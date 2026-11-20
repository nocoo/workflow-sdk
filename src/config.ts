import type { PolicyRule } from "./policy.js";
import type { ToolDefinition } from "./tools.js";
import type { BuiltinToolName, EngineType, SchemaLike } from "./types.js";

export interface CapabilitiesConfigOptions {
  enabledTools?: BuiltinToolName[];
  enableSubagents?: boolean;
  fileReads?: boolean;
  fileWrites?: boolean;
  commandExecution?: boolean;
  mcp?: boolean;
}

export class CapabilitiesConfig {
  readonly enabledTools: BuiltinToolName[];
  readonly enableSubagents: boolean;
  readonly fileReads?: boolean;
  readonly fileWrites?: boolean;
  readonly commandExecution?: boolean;
  readonly mcp?: boolean;

  constructor(options: CapabilitiesConfigOptions = {}) {
    this.enabledTools = [...(options.enabledTools ?? [])];
    this.enableSubagents = options.enableSubagents ?? false;
    this.fileReads = options.fileReads;
    this.fileWrites = options.fileWrites;
    this.commandExecution = options.commandExecution;
    this.mcp = options.mcp;
  }
}

export interface BaseAgentConfigOptions<T = unknown> {
  engine?: EngineType;
  model: string;
  apiKey?: string;
  env?: Record<string, string>;
  systemInstructions?: string;
  capabilities?: CapabilitiesConfig;
  policies?: PolicyRule[];
  tools?: ToolDefinition<never, unknown>[] | ToolDefinition<unknown, unknown>[];
  responseSchema?: SchemaLike<T>;
  saveDir?: string;
  workspaces?: string[];
  conversationId?: string;
}

export abstract class BaseAgentConfig<T = unknown> {
  readonly engine: EngineType;
  readonly model: string;
  readonly apiKey?: string;
  readonly env: Record<string, string>;
  readonly systemInstructions?: string;
  readonly capabilities: CapabilitiesConfig;
  readonly policies: PolicyRule[];
  readonly tools: ToolDefinition<unknown, unknown>[];
  readonly responseSchema?: SchemaLike<T>;
  readonly saveDir?: string;
  readonly workspaces: string[];
  readonly conversationId?: string;

  protected constructor(options: BaseAgentConfigOptions<T>) {
    if (!options.model?.trim()) {
      throw new Error("AgentConfig requires a non-empty 'model'.");
    }
    this.engine = options.engine ?? "antigravity";
    this.model = options.model.trim();
    this.apiKey = options.apiKey;
    this.env = { ...(options.env ?? {}) };
    this.systemInstructions = options.systemInstructions;
    this.capabilities = options.capabilities ?? new CapabilitiesConfig();
    this.policies = [...(options.policies ?? [])];
    this.tools = [...((options.tools as ToolDefinition<unknown, unknown>[] | undefined) ?? [])];
    this.responseSchema = options.responseSchema;
    this.saveDir = options.saveDir;
    this.workspaces = [...(options.workspaces ?? [])];
    this.conversationId = options.conversationId;
  }

  abstract resolveApiKey(): string | undefined;
}

export interface LocalOpenAIAgentConfigOptions<T = unknown> extends BaseAgentConfigOptions<T> {
  baseUrl: string;
}

export class LocalOpenAIAgentConfig<T = unknown> extends BaseAgentConfig<T> {
  readonly baseUrl: string;

  constructor(options: LocalOpenAIAgentConfigOptions<T>) {
    super(options);
    if (!options.baseUrl?.trim()) {
      throw new Error("LocalOpenAIAgentConfig requires a non-empty 'baseUrl'.");
    }
    this.baseUrl = options.baseUrl.trim();
  }

  override resolveApiKey(): string | undefined {
    return this.apiKey ?? this.env.OPENAI_API_KEY;
  }
}

export interface LocalAgentConfigOptions<T = unknown> extends BaseAgentConfigOptions<T> {
  vertex?: boolean;
  project?: string;
  location?: string;
  baseUrl?: string;
}

export class LocalAgentConfig<T = unknown> extends BaseAgentConfig<T> {
  readonly vertex: boolean;
  readonly project?: string;
  readonly location?: string;
  readonly baseUrl?: string;

  constructor(options: LocalAgentConfigOptions<T>) {
    super(options);
    this.vertex = options.vertex ?? false;
    this.project = options.project;
    this.location = options.location;
    this.baseUrl = options.baseUrl;
  }

  override resolveApiKey(): string | undefined {
    return this.apiKey ?? this.env.GEMINI_API_KEY ?? this.env.GOOGLE_API_KEY;
  }
}
