import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type ModelMessage, stepCountIs, type ToolSet, tool } from "ai";
import { z } from "zod";
import { type BaseAgentConfig, LocalAgentConfig, LocalOpenAIAgentConfig } from "../config.js";
import { policy } from "../policy.js";
import { toJsonSchema, validateWithSchema } from "../tools.js";
import {
  BuiltinTools,
  type EngineAdapter,
  type EngineTurnResult,
  UnsupportedCapabilityError,
  type UsageMetadata,
} from "../types.js";

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function assertSupportedCapabilities(config: BaseAgentConfig<unknown>): void {
  const cap = config.capabilities;
  if (cap.enableSubagents) {
    throw new UnsupportedCapabilityError("Pure-TS kernel does not support subagents.");
  }
  if (cap.fileWrites || cap.commandExecution) {
    throw new UnsupportedCapabilityError(
      "Pure-TS kernel does not provide OS sandboxing for write_file or commandExecution.",
    );
  }
  const unsupportedTools = cap.enabledTools.filter(
    (name) =>
      name === BuiltinTools.CREATE_FILE ||
      name === BuiltinTools.EDIT_FILE ||
      name === BuiltinTools.RUN_COMMAND,
  );
  if (unsupportedTools.length > 0) {
    throw new UnsupportedCapabilityError(
      `Pure-TS kernel does not support sandboxed builtin tools: ${unsupportedTools.join(", ")}.`,
    );
  }
}

/**
 * Pure-TS lightweight execution kernel powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`),
 * intentionally excluding OS-level sandboxing.
 */
export class TsEngine<T = unknown> implements EngineAdapter<T> {
  private readonly config: BaseAgentConfig<T>;
  private readonly messages: ModelMessage[] = [];
  private historyFile: string | null = null;

  constructor(config: BaseAgentConfig<T>) {
    this.config = config;
  }

  async start(): Promise<void> {
    assertSupportedCapabilities(this.config);
    if (this.config.saveDir) {
      mkdirSync(this.config.saveDir, { recursive: true });
      this.historyFile = path.join(this.config.saveDir, "history.json");
    }
  }

  async chat(prompt: string): Promise<EngineTurnResult<T>> {
    const baseUrl = this.resolveBaseUrl();
    const apiKey = this.config.resolveApiKey() ?? "magpie";
    const openai = createOpenAI({ baseURL: baseUrl, apiKey });

    const tools = this.buildToolSet();
    const hasTools = Object.keys(tools).length > 0;
    const schemaJson = this.config.responseSchema ? toJsonSchema(this.config.responseSchema) : null;

    const systemParts: string[] = [];
    if (this.config.systemInstructions) {
      systemParts.push(this.config.systemInstructions);
    }
    if (schemaJson) {
      systemParts.push(
        `Return ONLY a single valid JSON object strictly matching this JSON Schema (no markdown fences):\n${JSON.stringify(schemaJson)}`,
      );
    }

    this.messages.push({ role: "user", content: prompt });

    const totalUsage: UsageMetadata = {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    };

    const maxAttempts = schemaJson ? 2 : 1;
    let finalText = "";
    let structured: T | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await generateText({
        model: openai.chat(this.config.model),
        system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
        messages: this.messages,
        ...(hasTools ? { tools, stopWhen: stepCountIs(16) } : {}),
      });

      const promptTok = Number(result.totalUsage?.inputTokens ?? 0);
      const compTok = Number(result.totalUsage?.outputTokens ?? 0);
      totalUsage.promptTokenCount += promptTok;
      totalUsage.candidatesTokenCount += compTok;
      totalUsage.totalTokenCount += Number(result.totalUsage?.totalTokens ?? promptTok + compTok);

      finalText = result.text ?? "";

      if (!schemaJson || !this.config.responseSchema) {
        this.messages.push({ role: "assistant", content: finalText });
        break;
      }

      try {
        const parsedJson = JSON.parse(stripJsonFence(finalText));
        structured = validateWithSchema(this.config.responseSchema, parsedJson);
        this.messages.push({ role: "assistant", content: finalText });
        break;
      } catch (err) {
        if (attempt === maxAttempts - 1) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        this.messages.push({ role: "assistant", content: finalText });
        this.messages.push({
          role: "user",
          content:
            "Your previous response was not valid JSON matching the schema. Return ONLY valid JSON.",
        });
      }
    }

    this.persistHistory();

    return {
      text: finalText,
      structured,
      usageMetadata: totalUsage,
    };
  }

  async close(): Promise<void> {
    this.persistHistory();
  }

  private resolveBaseUrl(): string {
    if (this.config instanceof LocalOpenAIAgentConfig) {
      return this.config.baseUrl;
    }
    if (this.config instanceof LocalAgentConfig && this.config.baseUrl) {
      return this.config.baseUrl;
    }
    throw new UnsupportedCapabilityError(
      "Pure-TS kernel requires 'baseUrl' on LocalOpenAIAgentConfig or LocalAgentConfig.",
    );
  }

  private buildToolSet(): ToolSet {
    const toolSet: ToolSet = {};

    for (const custom of this.config.tools) {
      toolSet[custom.name] = tool({
        description: custom.description,
        inputSchema: custom.inputSchema,
        execute: async (input: unknown) => {
          if (!policy.evaluate(this.config.policies, custom.name)) {
            return { error: `Tool '${custom.name}' blocked by policy.` };
          }
          return await custom.invoke(input);
        },
      });
    }

    const enabled = new Set(this.config.capabilities.enabledTools);
    if (enabled.has(BuiltinTools.READ_FILE) && !toolSet[BuiltinTools.READ_FILE]) {
      toolSet[BuiltinTools.READ_FILE] = tool({
        description: "Read UTF-8 text file contents from local disk.",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path: filePath }: { path: string }) => {
          if (!policy.evaluate(this.config.policies, BuiltinTools.READ_FILE)) {
            return { error: "Tool 'read_file' blocked by policy." };
          }
          return { content: readFileSync(filePath, "utf8") };
        },
      });
    }

    if (enabled.has(BuiltinTools.LIST_DIR) && !toolSet[BuiltinTools.LIST_DIR]) {
      toolSet[BuiltinTools.LIST_DIR] = tool({
        description: "List directory entries on local disk.",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path: dirPath }: { path: string }) => {
          if (!policy.evaluate(this.config.policies, BuiltinTools.LIST_DIR)) {
            return { error: "Tool 'list_dir' blocked by policy." };
          }
          return { entries: readdirSync(dirPath) };
        },
      });
    }

    return toolSet;
  }

  private persistHistory(): void {
    if (!this.historyFile) {
      return;
    }
    writeFileSync(
      this.historyFile,
      `${JSON.stringify({ model: this.config.model, messages: this.messages }, null, 2)}\n`,
      "utf8",
    );
  }
}
