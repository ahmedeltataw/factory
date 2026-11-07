# M1 report: Seed and inventory

Status: closed pending milestone review · Date: 2026-11-07

## Result
- `main` contains: toolchain (Node >=24, pnpm 12.15.0, TypeScript 6.0.3, Vitest 4.1.8, tsdown 0.22.14, zod 4.4.3), the dsh deterministic core (15 files) + retry-health, byte-identical to the pinned dsh blobs, 2 protected dsh tests, CI on {windows, ubuntu} x {Node 24, 26}, five guard scripts.
- 252 tests pass; typecheck and build clean; CI green on all 4 cells; fresh-clone replay green on Windows/Node 26; Designer acceptance `acceptance/M1.ps1` PASS.

## Cards
| Card | Role / model | Attempts | Review |
|---|---|---|---|
| M1-00 protected tests | Lead (Claude) | 1 | n/a (risk low) |
| M1-01 skeleton + toolchain | Builder A deepseek-v4.1-flash-free | 3 (1 silent timeout) | approve, pass 2 |
| M1-02 port core | Builder A deepseek-v4.1-flash-free | 1 | approve, pass 1 |
| M1-03 CI + guard scripts | Builder B glm-5.3-flash-free | 3 (+1 start failure) | approve, pass 3 |

## What the layers caught
- Reviewer: Lead spec edits bundled into a builder commit (now separate Lead commits); dependency test checked names but not versions; CI ran 3 of 5 guards; import scanner fooled by comments, strings, template imports and regex literals → replaced by the TypeScript AST.
- Lead: per-file hashes first taken from CRLF working copies (`core.autocrlf=true`); CRLF stored in a card commit (fixed by `.gitattributes` + renormalize); spec errors in the typecheck expectation and the protected-test import count.

## Learned for M2
- Parallel OpenCode `--standalone` starts can race: stagger starts by a few seconds.
- A builder run can hang silently: keep a hard timeout and retry once before switching model.
- The nvm pnpm shim fails on Node 26; use the Designer's pnpm 12.15.0 (`~/.local/c2c-tools`).
- Designer to-do: remove Node 25 from `C:/Program Files/nodejs`; optionally `gh auth login` so CI results can be read automatically.
- M2 (store, migrations, commands, leases, status) is the first core-risk milestone: mutation + property tests apply, and the Codex escalation rule (Designer approval) may trigger.
