# ADR-0001: Toolchain and runtime

Status: proposed (Step 0) · Date: 2026-11-07 · Author: Lead

## Decision

| Item | Choice |
|---|---|
| Runtime floor | **Node 24 LTS**; CI also runs **Node 26 LTS**. `engines.node: ">=24"` |
| Local | Node 26.13.0 (nvm) on the Designer's PC since 2026-11-07. An old Node 25.2.1 in `C:/Program Files/nodejs` is still first on the system PATH and must be removed so `node` resolves to 26. CI on 24/26 is authoritative |
| Package manager | pnpm, pinned via `packageManager: "pnpm@12.15.0"` (installed locally; pnpm 11/12 list Node 24 and 26 as supported). Lockfile committed; installs use `--frozen-lockfile` |
| Dependency scripts | Dependency lifecycle scripts off by default; any exception allow-listed in `package.json` with a reason |
| Language | TypeScript, `strict`, ESM, `NodeNext`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `.ts` import extensions (same settings as the dsh core, so ported files compile unchanged) |
| Tests | Vitest; fast-check (property tests, from M2); StrykerJS + Vitest runner (mutation, core modules, Ubuntu CI job only, from M2) |
| Runtime validation | zod 4 |
| Build | tsdown, single entry `supervisor/src/core/index.ts` in M1 (dsh entries `src/index.ts`, `sources/github.ts`, `sources/feishu.ts` are dropped) |
| Database | `node:sqlite` (Stability 1.1, active development). A compatibility probe test runs in CI on every Node line. If the probe fails on a supported LTS, an ADR decides the fallback; nothing is switched silently |
| CI | GitHub Actions, matrix `{windows-latest, ubuntu-latest} × {Node 24, Node 26}`, fresh clone, frozen lockfile |
| Line endings | `.gitattributes` `* text=auto eol=lf`. Hashes of ported files are taken from git blobs (LF), never from Windows working copies (the Designer's git has `core.autocrlf=true`) |

Exact versions of TypeScript, Vitest, zod and tsdown are pinned in `package.json` at M1-01 and recorded in its evidence.

## Why

- Node 24/26 are the supported LTS lines; 25 is EOL.
- Matching the dsh compiler settings lets the core be ported byte-for-byte, so its hash check stays meaningful.
- The Windows CI job catches path, process and file-locking differences early (Vitest drive-letter casing, Defender slowing pnpm).

## Consequences

- Before M2 the Designer installs Node 24 or 26.
- Known Windows risks to test: Vitest with mismatched drive-letter case (canonicalize cwd), pnpm under Defender, file locks. Proper-lockfile is not adopted; locking is designed in M2.
