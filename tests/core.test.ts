import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  AntigravityEngine,
  BuiltinTools,
  CapabilitiesConfig,
  defineTool,
  emptyUsageMetadata,
  LocalAgentConfig,
  LocalOpenAIAgentConfig,
  policy,
  ToolExecutionError,
  toJsonSchema,
  UnsupportedCapabilityError,
  validateWithSchema,
} from "../src/index.js";

describe("config, policy & tools", () => {
  it("evaluates allowAll, denyAll, and allow rules deterministically", () => {
    expect(policy.evaluate([], "read_file")).toBe(true);
    expect(policy.evaluate([policy.allowAll()], "anything")).toBe(true);
    expect(policy.evaluate([policy.denyAll()], "read_file")).toBe(false);
    expect(policy.evaluate([policy.denyAll(), policy.allow("read_file")], "read_file")).toBe(true);
    expect(policy.evaluate([policy.denyAll(), policy.allow("write_file")], "read_file")).toBe(
      false,
    );
  });

  it("defines tools with Zod schemas and converts to JSON Schema", async () => {
    const sumTool = defineTool({
      name: "add_numbers",
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    });

    expect(sumTool.name).toBe("add_numbers");
    expect(sumTool.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
    });
    await expect(sumTool.invoke({ a: 2, b: 3 })).resolves.toEqual({ sum: 5 });
    await expect(sumTool.invoke({ a: "bad" })).rejects.toThrow(ToolExecutionError);
  });

  it("constructs LocalOpenAIAgentConfig and LocalAgentConfig with Python-aligned defaults", () => {
    const Schema = z.object({ ok: z.boolean() });
    const openaiCfg = new LocalOpenAIAgentConfig({
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/workflow",
      env: { OPENAI_API_KEY: "magpie" },
      systemInstructions: "Be concise",
      capabilities: new CapabilitiesConfig({
        enabledTools: [BuiltinTools.FINISH],
        enableSubagents: false,
      }),
      policies: [policy.allowAll()],
      responseSchema: Schema,
    });

    expect(openaiCfg.engine).toBe("antigravity");
    expect(openaiCfg.resolveApiKey()).toBe("magpie");
    expect(openaiCfg.capabilities.enabledTools).toEqual([BuiltinTools.FINISH]);
    expect(openaiCfg.capabilities.enableSubagents).toBe(false);

    const localCfg = new LocalAgentConfig({
      engine: "ts",
      model: "gemini-2.5-flash",
      apiKey: "gem_key",
      vertex: true,
    });
    expect(localCfg.engine).toBe("ts");
    expect(localCfg.vertex).toBe(true);
    expect(localCfg.resolveApiKey()).toBe("gem_key");
  });

  it("throws when LocalOpenAIAgentConfig lacks baseUrl or model", () => {
    expect(() => new LocalOpenAIAgentConfig({ baseUrl: "", model: "m" })).toThrow();
    expect(
      () => new LocalOpenAIAgentConfig({ baseUrl: "http://localhost:1/v1", model: "" }),
    ).toThrow();
  });

  it("supports Agent lifecycle start/close and Symbol.asyncDispose", async () => {
    const calls: string[] = [];
    const cfg = new LocalOpenAIAgentConfig({
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/workflow",
    });

    const agent = new Agent(cfg, {
      adapterFactory: () => ({
        start: async () => {
          calls.push("start");
        },
        chat: async (prompt: string) => {
          calls.push(`chat:${prompt}`);
          return {
            text: "ok",
            structured: { answer: 42 },
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 0,
              totalTokenCount: 15,
            },
          };
        },
        close: async () => {
          calls.push("close");
        },
      }),
    });

    await using session = await agent.start();
    // Idempotent second start
    await session.start();
    const res = await session.chat("hello");
    expect(await res.text()).toBe("ok");
    expect(await res.structuredOutput()).toEqual({ answer: 42 });
    expect(res.usageMetadata.totalTokenCount).toBe(15);

    // Explicit second close is idempotent
    await session.close();
    expect(calls).toEqual(["start", "chat:hello", "close"]);
  });

  it("supports plain JSON schema helpers and emptyUsageMetadata", () => {
    const rawSchema = { type: "object", properties: { name: { type: "string" } } };
    expect(toJsonSchema(rawSchema)).toEqual(rawSchema);
    expect(validateWithSchema(rawSchema, { name: "ok" })).toEqual({ name: "ok" });
    expect(emptyUsageMetadata()).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    });
  });

  it("handles LocalAgentConfig env fallback and defaultAdapterFactory ts engine", async () => {
    const envCfg = new LocalAgentConfig({
      engine: "ts",
      model: "gemini-2.5-flash",
      env: { GEMINI_API_KEY: "from_env" },
      baseUrl: "http://127.0.0.1:1/v1",
    });
    expect(envCfg.resolveApiKey()).toBe("from_env");
    await using tsAgent = await Agent.create(envCfg);
    expect(tsAgent.config.engine).toBe("ts");

    const googleEnvCfg = new LocalAgentConfig({
      model: "gemini-2.5-flash",
      env: { GOOGLE_API_KEY: "from_google_env" },
    });
    expect(googleEnvCfg.resolveApiKey()).toBe("from_google_env");
    const defaultAgent = new Agent(
      new LocalOpenAIAgentConfig({ baseUrl: "http://127.0.0.1:1/v1", model: "m" }),
    );
    expect(defaultAgent.config.engine).toBe("antigravity");
    const spyStart = vi.spyOn(AntigravityEngine.prototype, "start").mockResolvedValueOnce();
    await defaultAgent.start();
    expect(spyStart).toHaveBeenCalledTimes(1);
    spyStart.mockRestore();
  });

  it("rejects chat before start and propagates UnsupportedCapabilityError", async () => {
    const cfg = new LocalOpenAIAgentConfig({
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/workflow",
    });
    const agent = new Agent(cfg);
    await expect(agent.chat("hi")).rejects.toThrow(/not started/i);
    expect(new UnsupportedCapabilityError("sandbox").name).toBe("UnsupportedCapabilityError");
  });
});
