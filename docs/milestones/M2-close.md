# M2 close

Lead: Claude, 2026-11-10.

### M2-08 M2 acceptance script · Builder Gemini 3.8 Flash (Antigravity) · Reviewer gpt-6.1-sol · risk low

Allowed paths: new `acceptance/M2.ps1` only. Model it on `acceptance/M1.ps1` (same Step/PASS/FAIL table style, same pnpm lookup, Arabic comment per step, `$ErrorActionPreference = 'Stop'`, fresh clone into `%TEMP%\factory-m2-acceptance`, never deletes outside that folder).

- `CHK-M2-08-a`: steps 1–9 of M1 are reused (Node 24/26, fresh clone, frozen install, typecheck, test, build, manifest, forbidden imports) and traceability runs `--all --require-passing`.
- `CHK-M2-08-b`: the Designer can see the runtime work: the script creates a temp state dir, runs `node lib/factory.mjs status --state-dir <dir>` on a missing database and expects exit 1 with an Arabic message; then creates a database and lease through a short Node one-liner that imports the built or source modules (`openStore`, `acquireSupervisor`), runs `status` (Arabic view and `--json`) and expects exit 0 with an active lease shown; then a second `acquireSupervisor` from another process must fail (lease refused); then the lease is released and `status` shows the released label `مُحرَّر`.
- `CHK-M2-08-c`: every temp dir the script creates is removed at the end, even on failure; the final line is `M2: PASS` or `M2: FAIL` and the exit code matches.

### M2-09 M2 close · Lead + Designer

- `CHK-M2-09-a`: GitHub Actions on the pushed M2 head is green on all four matrix cells, and the mutation job passes.
- `CHK-M2-09-b`: the Designer runs `acceptance/M2.ps1` and it ends `M2: PASS`.
- `CHK-M2-09-c`: `docs/milestones/M2-report.md` records cards, reviewers, what review caught and what is learned for M3.
