# workflow-sdk

TypeScript Agent & Workflow SDK with dual execution kernels:
1. **Antigravity kernel** (`engine: "antigravity"`, default) — aligns with `google-antigravity` Python SDK via an isolated `uv` stdio JSON-RPC bridge.
2. **Pure-TS kernel** (`engine: "ts"`) — lightweight OpenAI-compatible runtime powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`), without OS-level sandboxing.

## Repository Layout

- `src/`: TypeScript SDK source (`index.ts`, `agent.ts`, `config.ts`, `policy.ts`, `tools.ts`, `types.ts`, `engines/`).
- `python/`: Bundled PEP 723 stdio bridge (`bridge.py`) invoked by the Antigravity kernel.
- `tests/`: Vitest unit and integration suites (`*.test.ts`).
- `.githooks/`: Local Git hooks (`pre-commit`, `pre-push`), activated via `bun run prepare`.
- `.github/workflows/`: Native `base-ci` (`v2026.24`) quality workflow (`pipeline.yml` + `quality-slots.yml`), CI quality only (no automated CD workflow; local `npm publish` only).

## Quality System (`system1-quality 1.3.0` + `base-ci v2026.24`)

All checks run in check-only mode without mutating tracked files.

```sh
bun run typecheck       # S1: Types (tsc --noEmit)
bun run lint            # S2: Lint (biome check --error-on-warnings .)
bun run test:coverage   # L1: Unit (vitest run --coverage, 95% threshold)
bun run build           # B1: Build (tsc -p tsconfig.build.json -> dist/)
bun run verify          # Full local verification pipeline
```

| Slot | Stage | Command / Mechanism | Status |
|---|---|---|---|
| S1 Types | Pre-commit, CI | `tsc --noEmit` | enforced |
| S2 Lint | Pre-commit, CI | `biome check --error-on-warnings .` | enforced |
| S3 Workflow | CI | `actionlint` + pinned SHA check | enforced |
| G1 Secrets | Pre-commit, CI | `gitleaks` (staged in pre-commit; repo in CI) | enforced |
| G2 Dependencies | Pre-push, CI | `osv-scanner` (when installed) / CI `osv-scanner` | enforced |
| B1 Build | Pre-push, CI | `bun run build` | enforced |
| L1 Unit | Pre-commit, CI | `vitest run --coverage` (95% statements/branches/functions/lines) | enforced |
| L2 Runtime | — | No platform runtime bindings required | N/A |
| L3 Integration | — | Covered by `L1 Unit` Vitest suite (stub skipped in CI) | N/A |
| L4 E2E | Manual | Live Magpie (`http://127.0.0.1:3425/v1`) dual-kernel verification | manual |
| P1 Package | Pre-push, CI | `npm pack` + isolated consumer import/type smoke test (reuses `B1` artifact) | enforced |
| Z1 Gate | CI | `quality / Z1: Gate` aggregating all required slots | enforced |

## Conventions

- Code, docstrings, comments, docs, and Git commits in English.
- Keep functions small, pure where possible, and free of speculative abstractions.
- Never commit secrets, credentials, `.local/` artifacts, `dist/`, or `coverage/`.
- Commit atomically after verified changes; do not force-push `main`.
