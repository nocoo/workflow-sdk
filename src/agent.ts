import type { BaseAgentConfig } from "./config.js";
import { AntigravityEngine } from "./engines/antigravity.js";
import { TsEngine } from "./engines/ts-engine.js";
import type { EngineAdapter, EngineTurnResult, UsageMetadata } from "./types.js";

export type AdapterFactory<T> = (config: BaseAgentConfig<T>) => EngineAdapter<T>;

export interface AgentOptions<T = unknown> {
  adapterFactory?: AdapterFactory<T>;
}

/**
 * Response returned from a single `agent.chat()` invocation, mirroring google-antigravity Response.
 */
export class AgentResponse<T = unknown> {
  private readonly result: EngineTurnResult<T>;
  readonly usageMetadata: UsageMetadata;

  constructor(result: EngineTurnResult<T>) {
    this.result = result;
    this.usageMetadata = result.usageMetadata;
  }

  async text(): Promise<string> {
    return this.result.text;
  }

  async structuredOutput(): Promise<T | null> {
    return this.result.structured;
  }
}

function defaultAdapterFactory<T>(config: BaseAgentConfig<T>): EngineAdapter<T> {
  if (config.engine === "ts") {
    return new TsEngine(config);
  }
  return new AntigravityEngine(config);
}

/**
 * Stateful Agent session wrapper supporting both `await using` (`Symbol.asyncDispose`)
 * and explicit `start()` / `close()` lifecycle management.
 */
export class Agent<T = unknown> implements AsyncDisposable {
  readonly config: BaseAgentConfig<T>;
  private readonly adapterFactory: AdapterFactory<T>;
  private adapter: EngineAdapter<T> | null = null;
  private started = false;

  constructor(config: BaseAgentConfig<T>, options: AgentOptions<T> = {}) {
    this.config = config;
    this.adapterFactory = options.adapterFactory ?? defaultAdapterFactory;
  }

  static async create<T = unknown>(
    config: BaseAgentConfig<T>,
    options: AgentOptions<T> = {},
  ): Promise<Agent<T>> {
    const agent = new Agent(config, options);
    return await agent.start();
  }

  async start(): Promise<this> {
    if (this.started) {
      return this;
    }
    const adapter = this.adapterFactory(this.config);
    await adapter.start();
    this.adapter = adapter;
    this.started = true;
    return this;
  }

  async chat(prompt: string): Promise<AgentResponse<T>> {
    if (!this.started || !this.adapter) {
      throw new Error("Agent is not started. Call await agent.start() or Agent.create(config).");
    }
    const result = await this.adapter.chat(prompt);
    return new AgentResponse(result);
  }

  async close(): Promise<void> {
    if (!this.started || !this.adapter) {
      return;
    }
    const adapter = this.adapter;
    this.adapter = null;
    this.started = false;
    await adapter.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
