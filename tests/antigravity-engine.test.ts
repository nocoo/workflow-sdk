import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AntigravityEngine } from "../src/engines/antigravity.js";
import {
  Agent,
  BuiltinTools,
  CapabilitiesConfig,
  defineTool,
  LocalAgentConfig,
  LocalOpenAIAgentConfig,
  policy,
} from "../src/index.js";

function createFakeBridgeProcess(handlers: {
  onInit?: (params: Record<string, unknown>, send: (obj: unknown) => void) => void;
  onChat?: (params: Record<string, unknown>, send: (obj: unknown) => void, id: number) => void;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: () => boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit("close", 0);
    return true;
  };

  const send = (obj: unknown) => {
    proc.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  let buffer = "";
  proc.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as {
        id: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.method === "init") {
        handlers.onInit?.(msg.params ?? {}, send);
        send({ id: msg.id, result: { ok: true } });
      } else if (msg.method === "chat") {
        handlers.onChat?.(msg.params ?? {}, send, msg.id);
      } else if (msg.method === "close") {
        send({ id: msg.id, result: { ok: true } });
      }
    }
  });

  return proc;
}

describe("AntigravityEngine (stdio JSON-RPC bridge)", () => {
  it("forwards config, executes bidirectional TS tool_call, and validates Zod structuredOutput", async () => {
    const ResultSchema = z.object({ city: z.string(), tempC: z.number() });
    const weatherTool = defineTool({
      name: "get_weather",
      description: "Get city weather",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ tempC: city === "Tokyo" ? 21 : 15 }),
    });

    const config = new LocalOpenAIAgentConfig({
      engine: "antigravity",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/workflow",
      apiKey: "magpie",
      systemInstructions: "Return structured weather.",
      capabilities: new CapabilitiesConfig({ enabledTools: [BuiltinTools.FINISH] }),
      policies: [policy.allowAll()],
      tools: [weatherTool],
      responseSchema: ResultSchema,
    });

    let capturedInit: Record<string, unknown> = {};
    const fakeProc = createFakeBridgeProcess({
      onInit: (params) => {
        capturedInit = params;
      },
      onChat: (_params, send, reqId) => {
        // Trigger a reverse tool_call from Python bridge -> TS -> Python bridge
        send({
          id: 9001,
          method: "tool_call",
          params: { name: "get_weather", args: { city: "Tokyo" } },
        });
        // Listen for tool response on stdin is handled inside createFakeBridgeProcess? Wait - handle below:
        setTimeout(() => {
          send({
            id: reqId,
            result: {
              text: "Finished",
              structured: { city: "Tokyo", tempC: 21 },
              usageMetadata: {
                promptTokenCount: 120,
                candidatesTokenCount: 30,
                thoughtsTokenCount: 0,
                totalTokenCount: 150,
              },
            },
          });
        }, 15);
      },
    });

    const toolReplies: unknown[] = [];
    const origWrite = fakeProc.stdin.write.bind(fakeProc.stdin);
    fakeProc.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      const str = String(chunk);
      if (str.includes('"id":9001')) {
        toolReplies.push(JSON.parse(str.trim()));
      }
      return origWrite(chunk as string, ...(rest as []));
    }) as typeof fakeProc.stdin.write;

    const engine = new AntigravityEngine(config, {
      spawnFn: () => fakeProc as never,
    });
    const agent = new Agent(config, { adapterFactory: () => engine });
    await using session = await agent.start();

    expect(capturedInit.model).toBe("group/workflow");
    expect(capturedInit.baseUrl).toBe("http://127.0.0.1:3425/v1");
    expect(Array.isArray(capturedInit.tools)).toBe(true);

    const res = await session.chat("What is the weather in Tokyo?");
    expect(await res.text()).toBe("Finished");
    expect(await res.structuredOutput()).toEqual({ city: "Tokyo", tempC: 21 });
    expect(res.usageMetadata.totalTokenCount).toBe(150);
    expect(toolReplies).toEqual([{ id: 9001, result: { tempC: 21 } }]);
  });

  it("propagates bridge RPC errors and unexpected process exit cleanly", async () => {
    const config = new LocalOpenAIAgentConfig({
      engine: "antigravity",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/workflow",
    });

    const fakeProc = createFakeBridgeProcess({
      onChat: (params, send, reqId) => {
        if (params.prompt === "hello") {
          send({ id: reqId, error: { message: "Gateway unavailable" } });
        }
      },
    });

    const engine = new AntigravityEngine(config, {
      spawnFn: () => fakeProc as never,
    });
    await engine.start();
    await engine.start(); // idempotent start
    await expect(engine.chat("hello")).rejects.toThrow("Gateway unavailable");

    // Simulate blank line chunk and mid-flight process crash rejecting pending request
    fakeProc.stdout.write("\n");
    const inflight = engine.chat("mid-flight");
    fakeProc.stderr.write("fatal python traceback");
    fakeProc.emit("close", 1);
    await expect(inflight).rejects.toThrow("fatal python traceback");
    await expect(engine.chat("after crash")).rejects.toThrow();
    await engine.close(); // safe after crash
    await engine.close(); // idempotent close
  });

  it("handles unknown tool_call, throwing tool_call, and LocalAgentConfig init params", async () => {
    const failingTool = defineTool({
      name: "fail_tool",
      description: "Always throws",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("boom");
      },
    });

    const localCfg = new LocalAgentConfig({
      model: "gemini-2.5-flash",
      vertex: true,
      project: "my-proj",
      location: "us-central1",
      apiKey: "k",
      tools: [failingTool],
    });

    let initPayload: Record<string, unknown> = {};
    const toolErrors: unknown[] = [];

    const fakeProc = createFakeBridgeProcess({
      onInit: (params) => {
        initPayload = params;
      },
      onChat: (_params, send, reqId) => {
        send({ id: 7001, method: "tool_call", params: { name: "missing_tool", args: {} } });
        send({ id: 7002, method: "tool_call", params: { name: "fail_tool", args: {} } });
        setTimeout(() => {
          send({
            id: reqId,
            result: { text: "done", structured: null },
          });
        }, 20);
      },
    });

    const origWrite = fakeProc.stdin.write.bind(fakeProc.stdin);
    fakeProc.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      const str = String(chunk);
      if (str.includes('"id":7001') || str.includes('"id":7002')) {
        toolErrors.push(JSON.parse(str.trim()));
      }
      return origWrite(chunk as string, ...(rest as []));
    }) as typeof fakeProc.stdin.write;

    const engine = new AntigravityEngine(localCfg, { spawnFn: () => fakeProc as never });
    await engine.start();
    const res = await engine.chat("test tools");
    expect(res.text).toBe("done");
    expect(res.structured).toBeNull();
    expect(initPayload.kind).toBe("local");
    expect(initPayload.project).toBe("my-proj");
    expect(toolErrors).toEqual([
      { id: 7001, error: { message: "Unknown tool 'missing_tool'" } },
      { id: 7002, error: { message: "boom" } },
    ]);
    await engine.close();
  });
});
