import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BaseAgentConfig, LocalAgentConfig, LocalOpenAIAgentConfig } from "../config.js";
import { toJsonSchema, validateWithSchema } from "../tools.js";
import { type EngineAdapter, type EngineTurnResult, emptyUsageMetadata } from "../types.js";

export interface AntigravityEngineOptions {
  spawnFn?: typeof spawn;
  uvCommand?: string;
  bridgePath?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function defaultBridgePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../python/bridge.py");
}

/**
 * Primary execution kernel bridging to google-antigravity Python SDK over stdio NDJSON.
 */
export class AntigravityEngine<T = unknown> implements EngineAdapter<T> {
  private readonly config: BaseAgentConfig<T>;
  private readonly spawnFn: typeof spawn;
  private readonly uvCommand: string;
  private readonly bridgePath: string;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrBuf = "";
  private stdoutBuf = "";
  private closed = false;

  constructor(config: BaseAgentConfig<T>, options: AntigravityEngineOptions = {}) {
    this.config = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.uvCommand = options.uvCommand ?? "uv";
    this.bridgePath = options.bridgePath ?? defaultBridgePath();
  }

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }
    this.closed = false;
    const proc = this.spawnFn(this.uvCommand, ["run", this.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString("utf8");
      const lines = this.stdoutBuf.split("\n");
      this.stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        this.handleLine(line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
    });

    proc.on("close", (code) => {
      this.proc = null;
      const err = new Error(
        `Antigravity bridge exited (code=${String(code)})${this.stderrBuf ? `: ${this.stderrBuf.trim()}` : ""}`,
      );
      for (const req of this.pending.values()) {
        req.reject(err);
      }
      this.pending.clear();
    });

    await this.request("init", this.buildInitParams());
  }

  async chat(prompt: string): Promise<EngineTurnResult<T>> {
    if (!this.proc || this.closed) {
      throw new Error("AntigravityEngine is not running.");
    }
    const raw = (await this.request("chat", { prompt })) as {
      text?: string;
      structured?: unknown;
      usageMetadata?: EngineTurnResult["usageMetadata"];
    };
    const structured =
      raw.structured !== null && raw.structured !== undefined && this.config.responseSchema
        ? validateWithSchema(this.config.responseSchema, raw.structured)
        : ((raw.structured as T | null) ?? null);

    return {
      text: raw.text ?? "",
      structured,
      usageMetadata: raw.usageMetadata ?? emptyUsageMetadata(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const proc = this.proc;
    if (!proc) {
      return;
    }
    try {
      await this.request("close", {});
    } catch {
      // Process may have already exited
    } finally {
      if (this.proc && !this.proc.killed) {
        this.proc.kill();
      }
      this.proc = null;
    }
  }

  private buildInitParams(): Record<string, unknown> {
    const common: Record<string, unknown> = {
      model: this.config.model,
      apiKey: this.config.resolveApiKey(),
      env: this.config.env,
      systemInstructions: this.config.systemInstructions,
      capabilities: {
        enabledTools: this.config.capabilities.enabledTools,
        enableSubagents: this.config.capabilities.enableSubagents,
      },
      policies: this.config.policies,
      tools: this.config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        jsonSchema: t.jsonSchema,
      })),
      responseSchema: this.config.responseSchema ? toJsonSchema(this.config.responseSchema) : null,
      saveDir: this.config.saveDir ?? null,
      workspaces: this.config.workspaces,
      conversationId: this.config.conversationId ?? null,
    };

    if (this.config instanceof LocalOpenAIAgentConfig) {
      common.kind = "openai";
      common.baseUrl = this.config.baseUrl;
    } else if (this.config instanceof LocalAgentConfig) {
      common.kind = "local";
      common.vertex = this.config.vertex;
      common.project = this.config.project;
      common.location = this.config.location;
      common.baseUrl = this.config.baseUrl;
    }
    return common;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const reqId = this.nextId++;
    const proc = this.proc;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      proc?.stdin.write(`${JSON.stringify({ id: reqId, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { name: string; args: unknown };
      result?: unknown;
      error?: { message?: string };
    };

    if (msg.method === "tool_call" && msg.id !== undefined && msg.params) {
      void this.handleToolCall(msg.id, msg.params.name, msg.params.args);
      return;
    }

    if (msg.id !== undefined) {
      const req = this.pending.get(msg.id);
      if (req) {
        this.pending.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(msg.error.message ?? "Antigravity bridge RPC error"));
        } else {
          req.resolve(msg.result);
        }
      }
    }
  }

  private async handleToolCall(reqId: number, name: string, rawArgs: unknown): Promise<void> {
    const proc = this.proc;
    const target = this.config.tools.find((t) => t.name === name);
    if (!target) {
      proc?.stdin.write(
        `${JSON.stringify({ id: reqId, error: { message: `Unknown tool '${name}'` } })}\n`,
      );
      return;
    }
    try {
      const result = await target.invoke(rawArgs);
      proc?.stdin.write(`${JSON.stringify({ id: reqId, result })}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      proc?.stdin.write(`${JSON.stringify({ id: reqId, error: { message } })}\n`);
    }
  }
}
