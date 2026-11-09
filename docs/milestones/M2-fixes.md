# M2 review fixes

Lead: Claude, 2026-11-09. Source: independent review of Codex's temporary-lead M2 work (two Claude reviewers). Builders do not commit; the Lead commits after review.

### M2-05 lease, status and CLI fixes · Builder Gemini 3.8 Flash (Antigravity) · Reviewer gpt-6.1-sol · risk high

Allowed paths: `supervisor/src/app/supervisor-lease.ts`, `supervisor/src/app/status.ts`, `supervisor/src/cli/main.ts`, new `tests/m2-05-fixes.spec.ts`. Protected tests stay unchanged.

- `CHK-M2-05-a`: transaction detection throws when the database object has no boolean `isTransaction`; heartbeat and release never run unguarded. Test with a stub object.
- `CHK-M2-05-b`: when acquisition fails and the lock cleanup (`unlock`/`closeSync`) also fails, the thrown error keeps the primary error and attaches the cleanup failures (as `cause` or `AggregateError`), matching how `release` reports close failures. Test by injecting failures.
- `CHK-M2-05-c`: the Arabic view labels a released lease `مُحرَّر` and the not-applicable freshness `غير منطبق (تم تحرير الملكية)`; the heartbeat is labelled as a timestamp, not a duration. Arabic and JSON views show the same facts.
- `CHK-M2-05-d`: CLI read failures print a concise Arabic message for missing/unopenable database, unsupported schema version and malformed data; the raw message may follow only as a secondary detail line. Exit codes unchanged (1 read failure, 2 arguments, 0 success).
- `CHK-M2-05-e`: one exported constant `DEFAULT_STALE_AFTER_MS = 300_000` in `supervisor-lease.ts` is the CLI's threshold; the CLI accepts optional `--stale-after-ms <positive integer>` (invalid value exits 2).
- `CHK-M2-05-f`: full suite, typecheck and build pass.

### M2-06 traceability, command strings and CI fixes · Builder gpt-6.1-terra (Codex) · Reviewer Gemini 4 Argon · risk medium

Allowed paths: `scripts/check-traceability.mjs`, `tests/protected/m1-traceability-strict.spec.ts` (Lead-authorized edit for this card), its fixtures under `tests/scripts/**`, `supervisor/src/app/commands.ts`, new `tests/m2-06-commands.spec.ts`, `.github/workflows/ci.yml`, `acceptance/M1.ps1` only if needed.

- `CHK-M2-06-a`: the two strict-traceability tests for corrupt JSON and duplicate attempts use `--card-prefix ALL-P` (or an equivalent isolated fixture) and assert the specific messages, so removing either check makes them fail.
- `CHK-M2-06-b`: `--all --require-passing` ignores the evidence folder `step-0` (it is not a card) and passes on the real tree once all evidence exists; CI runs `--all --require-passing` instead of `--all`.
- `CHK-M2-06-c`: every command string field is rejected unless `String.prototype.isWellFormed()` is true; tests prove a lone surrogate is rejected and an exact retry of a valid command returns `duplicate`.
- `CHK-M2-06-d`: CI runs `node lib/factory.mjs status --state-dir <empty temp dir> --json` after `pnpm build` on every matrix cell and accepts only exit 1 with a non-empty stderr (missing database), proving the built CLI starts.
- `CHK-M2-06-e`: the mutation job comment matches CHK-M2-TOOLS-c (three files, combined break 80).
- `CHK-M2-06-f`: full suite, typecheck, build and all guard scripts pass.

### M2-07 lease mutation score · Builder gpt-6.1-terra (Codex) · Reviewer Gemini 4 Argon · risk medium · after M2-05

Allowed paths: new test files under `tests/` only.

- `CHK-M2-07-a`: Stryker with `stryker.config.json` reports a combined mutation score of at least 80 and `supervisor-lease.ts` alone at least 80; surviving mutants that are equivalent are listed with a one-line reason.
- `CHK-M2-07-b`: new tests assert behavior, not implementation details; full suite passes.
