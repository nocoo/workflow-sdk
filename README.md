# @nocoo/workflow-sdk

TypeScript Agent & Workflow SDK aligned with the `google-antigravity` Python SDK, supporting two swappable execution kernels:

1. **Antigravity kernel (`engine: "antigravity"`, default)** — delegates to the official `google-antigravity` Python SDK (`localharness`) via an isolated `uv` stdio NDJSON bridge (`python/bridge.py`), preserving full capabilities, `BuiltinTools`, `policies`, `saveDir`, and bidirectional TypeScript tool callbacks.
2. **Pure-TS kernel (`engine: "ts"`)** — lightweight OpenAI-compatible runtime powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`), without OS-level sandboxing. Supports multi-turn history, optional `saveDir` persistence, custom/read-only tools, `policy` checks, and Zod/JSON Schema structured outputs.

## Installation

```sh
bun add @nocoo/workflow-sdk zod
```

Requirements:
- Node.js `>= 22`
- `uv` + Python `>= 3.11` (required only when running `engine: "antigravity"`)

## Quick Start

```ts
import {
  Agent,
  BuiltinTools,
  CapabilitiesConfig,
  LocalOpenAIAgentConfig,
  defineTool,
  policy,
} from "@nocoo/workflow-sdk";
import { z } from "zod";

const ReportSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
});

const getStats = defineTool({
  name: "get_stats",
  description: "Fetch daily metrics",
  inputSchema: z.object({ day: z.string() }),
  execute: async ({ day }) => ({ day, count: 42 }),
});

const config = new LocalOpenAIAgentConfig({
  engine: "antigravity", // Switch to "ts" for zero-binary pure-TS runtime
  baseUrl: "http://127.0.0.1:3425/v1",
  model: "group/workflow",
  apiKey: "magpie",
  systemInstructions: "Summarize the metrics concisely.",
  capabilities: new CapabilitiesConfig({
    enabledTools: [BuiltinTools.FINISH],
    enableSubagents: false,
  }),
  policies: [policy.allowAll()],
  tools: [getStats],
  responseSchema: ReportSchema,
});

await using agent = await Agent.create(config);
const response = await agent.chat("Analyze today's metrics.");
const data = await response.structuredOutput();
console.log(data, response.usageMetadata);
```

## Development & Quality Checks

```sh
bun run typecheck       # tsc --noEmit (S1)
bun run lint            # biome check --error-on-warnings . (S2)
bun run test:coverage   # vitest run --coverage, 95% thresholds (L1)
bun run build           # tsc -p tsconfig.build.json (B1)
bun run verify          # Full local check pipeline
```

## License

MIT
