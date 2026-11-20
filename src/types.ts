import type { z } from "zod";

export type EngineType = "antigravity" | "ts";

export const BuiltinTools = {
  FINISH: "finish",
  VIEW_FILE: "view_file",
  READ_FILE: "view_file",
  LIST_DIR: "list_directory",
  CREATE_FILE: "create_file",
  WRITE_FILE: "create_file",
  EDIT_FILE: "edit_file",
  RUN_COMMAND: "run_command",
  FIND_FILE: "find_file",
  SEARCH_DIR: "search_directory",
  SEARCH_WEB: "search_web",
  READ_URL_CONTENT: "read_url_content",
} as const;

export type BuiltinToolName = (typeof BuiltinTools)[keyof typeof BuiltinTools] | (string & {});

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
}

export function emptyUsageMetadata(): UsageMetadata {
  return {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 0,
  };
}

export type JsonSchema = Record<string, unknown>;

export type SchemaLike<T = unknown> = z.ZodType<T> | JsonSchema;

export interface EngineTurnResult<T = unknown> {
  text: string;
  structured: T | null;
  usageMetadata: UsageMetadata;
}

export interface EngineAdapter<T = unknown> {
  start(): Promise<void>;
  chat(prompt: string): Promise<EngineTurnResult<T>>;
  close(): Promise<void>;
}

export class UnsupportedCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCapabilityError";
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}
