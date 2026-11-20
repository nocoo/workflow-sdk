import { z } from "zod";
import { type JsonSchema, type SchemaLike, ToolExecutionError } from "./types.js";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly jsonSchema: JsonSchema;
  invoke(rawInput: unknown): Promise<TOutput>;
}

export function isZodSchema(value: unknown): value is z.ZodType {
  return Boolean(value && typeof value === "object" && "_zod" in value);
}

export function toJsonSchema(schema: SchemaLike): JsonSchema {
  if (isZodSchema(schema)) {
    return z.toJSONSchema(schema) as JsonSchema;
  }
  return schema;
}

export function validateWithSchema<T>(schema: SchemaLike<T>, value: unknown): T {
  if (isZodSchema(schema)) {
    return schema.parse(value) as T;
  }
  return value as T;
}

/**
 * Define a strongly typed tool executable by both Antigravity and pure-TS kernels.
 */
export function defineTool<TInput, TOutput>(options: {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput> | TOutput;
}): ToolDefinition<TInput, TOutput> {
  const jsonSchema = toJsonSchema(options.inputSchema);
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    jsonSchema,
    async invoke(rawInput: unknown): Promise<TOutput> {
      const parsed = options.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ToolExecutionError(
          `Invalid input for tool '${options.name}': ${parsed.error.message}`,
        );
      }
      return await options.execute(parsed.data);
    },
  };
}
