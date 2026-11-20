import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  BuiltinTools,
  CapabilitiesConfig,
  defineTool,
  LocalAgentConfig,
  LocalOpenAIAgentConfig,
  policy,
  UnsupportedCapabilityError,
} from "../src/index.js";

function startMockOpenAIServer(
  responder: (
    body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] },
    callIndex: number,
  ) => unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let callIndex = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      callIndex += 1;
      const body = JSON.parse(raw);
      const payload = responder(body, callIndex);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("TsEngine (pure-TS Vercel AI SDK kernel)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes multi-turn chat, tool calls, Zod structuredOutput, and saveDir persistence", async () => {
    const saveDir = mkdtempSync(path.join(tmpdir(), "wf-sdk-ts-"));
    tempDirs.push(saveDir);

    const mockServer = await startMockOpenAIServer((_body, idx) => {
      if (idx === 1) {
        return {
          id: "cmpl-1",
          object: "chat.completion",
          created: 1700000000,
          model: "group/workflow",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "multiply", arguments: '{"x":6,"y":7}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
        };
      }
      return {
        id: "cmpl-2",
        object: "chat.completion",
        created: 1700000001,
        model: "group/workflow",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"product":42}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
      };
    });

    try {
      const ResultSchema = z.object({ product: z.number() });
      const multiplyTool = defineTool({
        name: "multiply",
        description: "Multiply two numbers",
        inputSchema: z.object({ x: z.number(), y: z.number() }),
        execute: async ({ x, y }) => ({ result: x * y }),
      });

      const cfg = new LocalOpenAIAgentConfig({
        engine: "ts",
        baseUrl: mockServer.baseUrl,
        model: "group/workflow",
        apiKey: "magpie",
        systemInstructions: "Compute carefully.",
        capabilities: new CapabilitiesConfig({ enabledTools: [BuiltinTools.FINISH] }),
        policies: [policy.allowAll()],
        tools: [multiplyTool],
        responseSchema: ResultSchema,
        saveDir,
      });

      await using agent = await Agent.create(cfg);
      const res = await agent.chat("Multiply 6 and 7");
      expect(await res.structuredOutput()).toEqual({ product: 42 });
      expect(res.usageMetadata.promptTokenCount).toBe(100);
      expect(res.usageMetadata.candidatesTokenCount).toBe(25);
      expect(res.usageMetadata.totalTokenCount).toBe(125);

      const saved = JSON.parse(readFileSync(path.join(saveDir, "history.json"), "utf8"));
      expect(saved.messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      await mockServer.close();
    }
  });

  it("blocks disallowed tools via policy and rejects unsupported sandbox capabilities", async () => {
    const blockedServer = await startMockOpenAIServer((_body, idx) => {
      if (idx === 1) {
        return {
          id: "cmpl-1",
          object: "chat.completion",
          created: 1700000000,
          model: "group/workflow",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "secret_tool", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        id: "cmpl-2",
        object: "chat.completion",
        created: 1700000001,
        model: "group/workflow",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Tool was denied." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      };
    });

    try {
      let executed = false;
      const secretTool = defineTool({
        name: "secret_tool",
        description: "Should be blocked",
        inputSchema: z.object({}),
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      });

      const cfg = new LocalOpenAIAgentConfig({
        engine: "ts",
        baseUrl: blockedServer.baseUrl,
        model: "group/workflow",
        policies: [policy.denyAll()],
        tools: [secretTool],
      });

      await using agent = await Agent.create(cfg);
      const res = await agent.chat("Run secret tool");
      expect(executed).toBe(false);
      expect(await res.text()).toContain("denied");
    } finally {
      await blockedServer.close();
    }

    const subagentCfg = new LocalOpenAIAgentConfig({
      engine: "ts",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "group/workflow",
      capabilities: new CapabilitiesConfig({ enableSubagents: true }),
    });
    await expect(Agent.create(subagentCfg)).rejects.toThrow(UnsupportedCapabilityError);

    const writeFlagCfg = new LocalOpenAIAgentConfig({
      engine: "ts",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "group/workflow",
      capabilities: new CapabilitiesConfig({ fileWrites: true }),
    });
    await expect(Agent.create(writeFlagCfg)).rejects.toThrow(UnsupportedCapabilityError);

    const writeToolCfg = new LocalOpenAIAgentConfig({
      engine: "ts",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "group/workflow",
      capabilities: new CapabilitiesConfig({ enabledTools: [BuiltinTools.WRITE_FILE] }),
    });
    await expect(Agent.create(writeToolCfg)).rejects.toThrow(UnsupportedCapabilityError);

    const noBaseUrlCfg = new LocalAgentConfig({
      engine: "ts",
      model: "gemini-2.5-flash",
    });
    await using noBaseAgent = await Agent.create(noBaseUrlCfg);
    await expect(noBaseAgent.chat("hi")).rejects.toThrow(UnsupportedCapabilityError);

    const localWithBaseServer = await startMockOpenAIServer(() => ({
      id: "c-local",
      object: "chat.completion",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }));
    try {
      await using localBaseAgent = await Agent.create(
        new LocalAgentConfig({ engine: "ts", model: "m", baseUrl: localWithBaseServer.baseUrl }),
      );
      const r = await localBaseAgent.chat("ping");
      expect(await r.text()).toBe("ok");
    } finally {
      await localWithBaseServer.close();
    }
  });

  it("supports builtin READ_FILE / LIST_DIR tools and structured JSON retry", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "wf-sdk-files-"));
    tempDirs.push(workDir);
    writeFileSync(path.join(workDir, "note.txt"), "hello world", "utf8");

    const server = await startMockOpenAIServer((_body, idx) => {
      if (idx === 1) {
        return {
          id: "c1",
          object: "chat.completion",
          created: 1700000000,
          model: "m",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc1",
                    type: "function",
                    function: {
                      name: "list_directory",
                      arguments: JSON.stringify({ path: workDir }),
                    },
                  },
                  {
                    id: "tc2",
                    type: "function",
                    function: {
                      name: "view_file",
                      arguments: JSON.stringify({ path: path.join(workDir, "note.txt") }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      if (idx === 2) {
        // Invalid JSON first -> triggers single retry
        return {
          id: "c2",
          object: "chat.completion",
          created: 1700000001,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "not json" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        id: "c3",
        object: "chat.completion",
        created: 1700000002,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '```json\n{"fileContent":"hello world"}\n```' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      };
    });

    try {
      const cfg = new LocalOpenAIAgentConfig({
        engine: "ts",
        baseUrl: server.baseUrl,
        model: "m",
        capabilities: new CapabilitiesConfig({
          enabledTools: [BuiltinTools.READ_FILE, BuiltinTools.LIST_DIR],
        }),
        policies: [policy.allowAll()],
        responseSchema: z.object({ fileContent: z.string() }),
      });

      await using agent = await Agent.create(cfg);
      const res = await agent.chat("Read the note");
      expect(await res.structuredOutput()).toEqual({ fileContent: "hello world" });
    } finally {
      await server.close();
    }
  });

  it("blocks builtin READ_FILE/LIST_DIR under denyAll and throws after failed JSON retries", async () => {
    const server = await startMockOpenAIServer((_body, idx) => {
      if (idx === 1) {
        return {
          id: "c1",
          object: "chat.completion",
          created: 1700000000,
          model: "m",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc1",
                    type: "function",
                    function: { name: "list_directory", arguments: '{"path":"/tmp"}' },
                  },
                  {
                    id: "tc2",
                    type: "function",
                    function: { name: "view_file", arguments: '{"path":"/tmp/x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        };
      }
      return {
        id: `c${idx}`,
        object: "chat.completion",
        created: 1700000001,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "still invalid json" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      };
    });

    try {
      const cfg = new LocalOpenAIAgentConfig({
        engine: "ts",
        baseUrl: server.baseUrl,
        model: "m",
        capabilities: new CapabilitiesConfig({
          enabledTools: [BuiltinTools.READ_FILE, BuiltinTools.LIST_DIR],
        }),
        policies: [policy.denyAll()],
        responseSchema: z.object({ ok: z.boolean() }),
      });

      await using agent = await Agent.create(cfg);
      await expect(agent.chat("Try read")).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
