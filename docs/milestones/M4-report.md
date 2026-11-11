# M4 report: retries, timeouts, scope locks and enforcement

Status: closed | 2026-11-11
Branch: `m4-integration`. The report draft came from Muse (factory-muse-inbox#7); the Lead finalised it.

## Result

M4 adds these features:
- **Schema and task options:** schema v6, a pure scope core (`core/scope.ts`), and per-task options (`--scope`, `--max-attempts`, `--timeout-ms`, `task retry`).
- **Executor and retries:** configurable fake-executor scenarios, exponential retry and backoff for transient exits (75), attempt timeouts with tree kill, and outbox backoff.
- **Robustness:** `SQLITE_BUSY` tolerance.
- **Scope locks:** FIFO scope locks derived from the DB, with reservation by waiting tasks.
- **Scope enforcement:** checked before commit, with `git status`, renames included.
- **Status:** status additions, including `--watch`.
- **Acceptance:** `acceptance/M4.ps1`.

All 17 cards are merged with evidence: M4-01 to M4-08, plus 9 fix and CI cards that came from review and CI. On the final integration head the full local suite passes 801/801. Typecheck, build, the manifest check and the forbidden-import check all pass.

## Cards

| Card | Builder | Reviewer | Recorded result |
|---|---|---|---|
| M4-01 schema v6 | gpt-6.1-terra | gemini-4-argon-high | Approved after 4 protected-test rounds; `store.ts` mutation 89.33%. |
| M4-02 scope core | gemini-3.8-flash-high | gpt-6.1-sol | Approved in round 3 after the Windows alias amendments; `scope.ts` mutation 99.18%. |
| M4-03 task options, `task retry` | gpt-6.1-terra | gemini-4-argon-high | Approved; `apply-commands.ts` 88.55%, `commands.ts` 82.72%. |
| M4-04 fake executor scenarios | gemini-3.8-flash-high | gpt-6.1-sol | Approved; 0 leaked processes. Not core, so no mutation. |
| M4-05 retries, timeouts, backoff, busy | gpt-6.1-terra | gemini-4-argon-high (impl), gpt-6.1-sol (tests) | 784/784; mutation `recovery.ts` 88.38, `supervisor-loop.ts` 84.76, `outbox.ts` 86.27. |
| M4-06 scope locks, enforcement | gpt-6.1-terra | gemini-4-argon-high (impl), gpt-6.1-sol (tests) | 795/798, the rest from machine load only; mutation `supervisor-loop.ts` 85.50, `outbox.ts` 83.25. |
| M4-07 status, `--watch` | gemini-3.8-flash-high | gpt-6.1-sol | Approved after the output-shape heuristic was removed; 756/756. |
| M4-08 acceptance script | gpt-6.1-terra | gemini-4-argon-high | Demos 10-14 pass on the owner machine (two Lead runs, 0 leaked processes); 2 Minor findings fixed. |
| M4-TH CIM test helper | gpt-6.1-terra | gemini-4-argon-high | Base64 command lines; 32/32. |
| M4-04-fix 8.3 short paths | gemini-3.8-flash-high | gpt-6.1-sol | Fixed 26 Windows CI failures; 8.3 regression test. |
| M4-CI traceability `--present-only` | gpt-6.1-terra | gemini-4-argon-high | Integration CI no longer red by design. |
| M4-WIN Windows CI stability | gpt-6.1-terra | gemini-4-argon-high | Cleanup retries, longer property timeout. |
| M4-PT process listing timeout | gpt-6.1-terra | gemini-4-argon-high | 30 s plus one ETIMEDOUT retry in `process-tree.ts`. |
| M4-WIN2 50-worker test budget | gpt-6.1-terra | gemini-4-argon-high | 900 s; passes on the owner machine. |
| M4-WIN3 test-helper PowerShell timeout | gemini-3.8-flash-high | gpt-6.1-sol | Same fix as M4-PT in 5 test files; 801/801. |
| M4-CI2 mutation on demand | gpt-6.1-terra | gemini-4-argon-high | Mutation job only on `workflow_dispatch`, 330-minute step. |
| M4-09 close | Lead and owner | — | See "Close" below. |

Card results come from `.factory/evidence/<card>/1.json` on `m4-integration`.

## What review and CI caught

- **Scope aliases (M4-02, sol):** Windows aliases (trailing dot or space, Unicode case, 8.3, device names). The contract now allows ASCII-only scope entries.
- **Output shape (M4-07, sol):** a status output-shape heuristic. The fields are now always present.
- **Protected tests (M4-05, M4-06, sol):** they used non-frozen hooks (`NODE_OPTIONS` preloads, barrier dirs, SQL matching), shared nonces, whole-`process.env` assertions (a failure printed every environment variable, tokens included), and kill races against a 1 s backoff. All of this is now in `docs/agents/rules-process.md` under "Protected tests".
- **Contract gap:** the fake executor always writes `factory-fake/<taskId>.txt`, so correct enforcement failed tests whose scope did not cover that file. The tests and the acceptance lock demo were amended. Older M3 tests that assumed default-scope tasks run concurrently got disjoint scopes.
- **CI (found by Muse, inbox #5 and #10):**
  - The 8.3 runner TEMP made the executor exit 2, which caused 26 Windows failures (M4-04-fix).
  - Traceability stayed red by design and hid those failures (M4-CI).
  - PowerShell timeouts in the product (M4-PT) and in the test helpers (M4-WIN3).
  - EPERM cleanup and a property-test timeout (M4-WIN).
  - Mutation overran its step timeout (M4-CI2).

## Incidents

- **Exposed secrets:** a failing test inside the Codex sandbox printed all environment variables. The owner was told to rotate the tokens, and the rule above now prevents it.
- **CI stopped:** the GitHub Actions spending limit blocked CI. The owner made the repo public (history was scanned for secrets first).
- **Builders never started:** after a context compaction, `codex` was not on PATH, so three builder runs did not start for about an hour. Builders are now launched with the full path and tracked as background tasks.

## Close

- **CI:** push run 43031001669 green on all four cells. Full mutation run 43031026998 passed: all files 80.0 or above (`supervisor-lease.ts` 81.19 lowest, `scope.ts` 99.18, total 88.05).
- **Acceptance (owner's machine):** the owner's first run of `acceptance/M4.ps1` failed at step 11 because the script clones the GitHub default branch (`main`, still M3 code). At the owner's request the Lead reran both scripts on the owner's machine with `-Source D:\ai-project\factory-wt\m4-int` (`m4-integration`): `M4: PASS` (steps 1-14) and `M3: PASS` (steps 1-19).
- **Models:** on 2026-11-11 `gemini-4-argon-high` was no longer offered by Antigravity. The owner chose `gemini-3.8-flash-high` as the reviewer for terra's cards (AGENTS.md).

## Lessons for M5

- Read every failed CI job after each integration push. A known red check hides new failures.
- Freeze `rules-process.md` and the contract at milestone start, and have Muse review the contract before freezing. Amendments are only for defects, each logged with its cause.
- First M5 card: full verify matrix on card branches via `workflow_dispatch` before merging process, executor, path or Windows cards.
- `process-tree.ts` starts a new PowerShell for every call (about 1 s each on the owner machine). Consider one persistent session.
- Acceptance scripts must test the milestone branch without a `-Source` override (M4.ps1 cloned `main`).
- Muse is the GitHub monitor and QA (inbox README). Route its `qa-bug` and `ci-issue` issues to builders.
