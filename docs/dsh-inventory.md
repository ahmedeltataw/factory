# dsh inventory (Step 0)

Source: dsh-superagent-prototype @ `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` (see `SOURCE_MANIFEST.json`). 176 files under `src/` + `tests/`; `tests/` holds 65 files (59 `*.spec.*` files + fixtures).

## Coupling found (import scan, 2026-11-07)

- `src/core/**` imports only `node:crypto` and sibling core files. **Clean.**
- `src/app/retry-health.ts` has no imports. **Clean**, but its test imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session`.
- `src/app/store.ts` is **not** clean: `store → kv → sources/github` (Cordis) and `store → policy → infra/environment` (Cordis). It also depends on `migration.ts`, which imports Feishu, `context.ts` (Cordis) and prompts.
- `src/app/outbox.ts` imports `sources/registry` and `infra/commands`. `src/app/effects.ts` imports `infra/health → sources/host`.
- 26 files import `@deepseek-ai/*` directly.

**Consequence:** the round-15/16 plan to port `store`, `effects`, `outbox` and `migration` nearly as-is in M1 does not hold. In M1 we copy only the clean files. Store, effects, outbox and migration are re-implemented in M2 (schema rewrite) using dsh as a read-only reference.

## Decision per file group

| Group | M1 action | Later |
|---|---|---|
| `src/core/*.ts` (15 files, ~2,088 lines) | **Port verbatim** (hash-checked), then no edits in M1 | M2+: adapt model (Task/Attempt/Authorization), rewrite engine/stage/tickets, replace evals |
| `tests/core-engine.spec.ts`, `tests/stage.spec.ts` | Copy as protected tests (one import line rewritten, hash-checked) | Updated by Lead when core is rewritten |
| `src/app/retry-health.ts` | Port verbatim | — |
| `tests/retry-health.spec.ts` | Rewrite without `@deepseek-ai/*` (same assertions) | — |
| `src/app/store.ts`, `store-read.ts`, `effects.ts`, `outbox.ts`, `migration.ts`, `versions.ts`, `kv.ts` | Not copied; reference only | M2 re-implementation |
| `src/sources/github-*.ts` | Not copied | M10 adapt (zod + core only, after `host`/`deployment` removal) |
| `src/policy.ts`, `admission.ts`, `limits.ts` | Not copied | M2 `core/authorization` + policy rewrite |
| `src/executor/background.ts` | Not copied | M6 executors (background shell jobs) |
| `src/executor/dsh.ts`, `src/app/{runtime,sessions,context,setup,execution-environment,api,http,assessment,delivery,resources,role-models,settings,tools}/**`, `src/index.ts`, `src/deployment.ts`, `src/navigation.ts`, `src/infra/environment.ts` | **Drop** (DSH host) | Rewritten from scratch where needed |
| `src/client/**`, `src/app/views/**`, `tests/panel-*.spec.tsx`, `client.spec.tsx`, `controls.spec.tsx` | **Drop** | Plugin/CLI read models later |
| `src/sources/feishu*.ts`, Feishu tests | **Drop** | — |
| `cordis.patch.yml`, `prompts/`, `skills/`, `locale/`, `@deepseek-ai/*` peers | **Drop** | — |

## Forbidden in the factory repo (enforced by a scan from M1)

`@deepseek-ai/*`, `cordis`, `feishu`, `dsh-` package imports, and any import from a dropped path above.
