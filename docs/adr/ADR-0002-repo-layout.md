# ADR-0002: Repository layout

Status: proposed (Step 0) · Date: 2026-11-07 · Author: Lead

## Decision

One root package (no pnpm workspace until the Claude Code plugin needs its own package).

```text
factory/
  supervisor/src/core/        # pure domain: no I/O, no model imports, no node:fs/sqlite
  supervisor/src/app/         # I/O: store, migrations, effects, outbox, leases (M2+)
  supervisor/src/cli/         # `factory` command (M2+)
  supervisor/src/executors/   # CLI worker adapters (M3 fake, M6 real)
  supervisor/src/sources/     # GitHub (M10)
  tests/                      # mirrors supervisor/src; tests/protected/** = protected tests
  scripts/                    # deterministic checks (forbidden imports, traceability, evidence)
  schemas/                    # JSON schemas (evidence, reports, brain calls)
  cards/  templates/          # role cards and templates (later)
  plugin/                     # Claude Code remote control (later)
  docs/adr/ docs/milestones/  # decisions and milestone specs
  .factory/evidence/          # machine-readable evidence records
  licenses/                   # third-party licences kept verbatim (dsh MIT)
  LICENSE SOURCE_MANIFEST.json NOTICE README.md
```

## Rules

- `supervisor/src/core/**` may import only `node:crypto` and other core files (checked by the forbidden-import scan).
- `tests/protected/**`, `schemas/**`, `docs/**` and `.factory/evidence/**` are never edited by a Builder. Protected tests change only through a Lead card.
- Ported dsh files keep their original file names under `supervisor/src/core/` so hashes can be compared against `SOURCE_MANIFEST.json`.
- One worktree per card: `D:/ai-project/factory-wt/<card-id>` on branch `card/<card-id>`. The Lead merges into `main` one card at a time.

## Licence

The factory repo is MIT licensed (root `LICENSE`, Designer decision 2026-11-07). The dsh MIT text stays in `licenses/dsh-superagent-MIT.txt` and NOTICE.
