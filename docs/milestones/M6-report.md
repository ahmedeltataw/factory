# M6 report: GitHub intake

Status: closing | 2026-11-14
Branch: `m6-integration`. Written by the Lead.

## Result

M6 adds a read-only GitHub intake to the Supervisor. A person approves every task; nothing is written to GitHub.

- **Schema v8:** `github_events` and `github_cursor` tables with triggers (no delete, immutable except the pending-to-decided update, pending rows need a title and scope).
- **Event model and gate:** `sources/github/{event,gate,ports}.ts`. Sanitizer, allow-list gate (actor id, repo, label, command line, pending limit), `parsePolicy` for `<state-dir>/github-policy.json`.
- **Ingest:** `ingestPoll` dedupes by (project, event id), stores ignored and pending events with reasons, keeps the ETag and the poll cursor, sanitizes error text; a fake GitHub port for tests.
- **Commands:** `factory github approve|reject`. Approve creates the task from the event row (task id = approve command id) and marks the event `approved` in one fenced transaction; reject records a sanitized reason.
- **Real client:** `createGitHubClient({ token, apiUrl? })`. One read-only `GET /repos/{owner}/{name}/events`, fixed headers, `redirect: 'manual'`, base-URL guard, 5 MiB cap, same-origin `Link` pages (at most 2), rate-limit mapping, redaction of the token from everything that leaves the client.
- **Token isolation:** the token lives in the Supervisor process only; `spawnWorker` strips `FACTORY_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_PAT` (case-insensitive) from the worker and grandchild environment.
- **Loop polling:** `LoopDeps.github`, policy re-read each tick (a missing or invalid policy pauses polling with `policy: <reason>` in `github_cursor.error`), due repos polled one at a time with a 20 s timeout, `runTick` returns `idle: false` when a poll was due, fault `github-after-poll` for the crash test, CLI `start` wiring (token variable, policy validation, API URL).
- **Status:** `github` field in `--json` and in the Arabic view (repos, counts, newest 20 pending events, re-sanitized titles); `schemaVersion` 8.
- **Acceptance:** `acceptance/M6.ps1` with a local fake GitHub server (`acceptance/lib/fake-github.mjs`), demos 10-15 (init, intake, approval, hostile text, token, crash with takeover).

17 cards are merged with evidence (M6-01 to M6-08, QA1, QA2, FIX1, WIN1); M6-09 is this close.

## Cards

| Card | Builder | Reviewer | Recorded result |
|---|---|---|---|
| M6-01 event model, gate | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `event.ts` 90.48, `gate.ts` 89.27; protected tests 5 rounds (sol). |
| M6-02 schema v8 | gemini-3.8-flash-high | gpt-6.1-sol | Merged; `store.ts` 94.23; one finding on the `status.ts` schema literal, resolved by amendment. |
| M6-03 ingest, fake port | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `ingest.ts` 83.73; protected tests 4 rounds. |
| M6-04 approve, reject | gemini-3.8-flash-high | gpt-6.1-sol | Merged; `apply-commands.ts` 86.03; terra stopped once on the task `source` field (amendment: traceability is `github_events.task_id`). |
| M6-06 client, token isolation | gemini-3.8-flash-high | gpt-6.1-sol | Merged after 4 review rounds; `client.ts` 88.33 (first run 64.40, tests added). |
| M6-05 loop polling | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `supervisor-loop.ts` 84.10, `faults.ts` 80.00; protected tests (Flash) 8 rounds with sol. |
| M6-07 status | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `status.ts` 91.13; protected tests 3 rounds; five older protected status/schema tests got the additive `github` field. |
| M6-08 acceptance script | gemini-3.8-flash-high | gpt-6.1-sol | Merged after 5 review rounds; demos 10-15 pass. |
| M6-QA1 PID-only tests | gemini-3.8-flash-high, terra for its 3 protected tests | gpt-6.1-sol | Merged after 4 rounds; one strict shared helper `tests/helpers/process-identity.ts`; recorded residual below. |
| M6-QA2 M6-01 coverage gaps | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `event.ts` 96.05, `gate.ts` 99.40. |
| M6-FIX1 M4 evidence note | Lead | none | `M4-report.md` correction note and `M4-01/2.json` annotation; strict traceability green. |
| M6-WIN1 diamond test window | gemini-3.8-flash-high | Lead | One knob value; local full suite green for the first time since M6-05. |
| M6-09 close | Lead and owner | none | See "Close". |

Card results come from `.factory/evidence/<card>/1.json` on `m6-integration`.

## What review and CI caught

- **Token leaks:** sol found, over 4 rounds on the client, redaction that missed escaped (`tok`) tokens, hostile JSON keys that hit the `__proto__` setter, a stack overflow on deeply nested JSON, the 200-with-remaining-0 rate limit, argument-spread overflow on large pages, whole-environment assertions that could print inherited secrets, and non-root base paths.
- **Protected tests:** sol found vacuous witnesses (a poll must really happen before an absence is asserted), `spawnSync` blocking the event loop that hosts the fake server, bare-PID kills, cleanup that swallowed errors, an over-specified error string, equality checks that could not prove a fixed diagnostic, counts that also appeared in other rendered facts.
- **Contract gaps (Lead amendments, each logged with its cause):** task `source` field had no storage; the loop wiring (`LoopDeps.github`, policy re-read, idle rule, timeout, CLI start) and the crash seam were not pinned; status derivation of `github`; scope order (`JSON.parse`, not `parseScope`); five older protected tests that compare the exact old status shape; the paused-policy status visibility moved from M6-05 to M6-07.
- **Acceptance script:** Windows PowerShell 5.1 pitfalls found one by one by running it: `ConvertFrom-Json` does not enumerate arrays, `return ,$x` double-wraps, `Get-Content -Raw` is `$null` for an empty file, positional parameter binding of a function declared without `param()`.
- **CI:** the Ubuntu cells caught a Linux-only identity lookup in a protected test cleanup (`--title` marker not in `/proc/<pid>/cmdline`), fixed by treating the tracked child handle as the identity.
- **Flake root cause (M6-WIN1):** `CHK-M5-06-a` failed in 5 of 5 full local runs. It was not the 30 s timeout: the test verifies two workers through Windows CIM lookups that take seconds under load while the executor slept only 3 s. The overlap window is now 10 s.
- **Mutation:** the first full mutation dispatch failed in the Stryker dry run (5 minute default); `dryRunTimeoutMinutes` is now 60.

## Incidents

- **Memory protection:** Claude Code stopped background jobs twice because system memory was critically low (a Flash run, the Telegram listener, a second Flash run). They were restarted only after the owner said so, one job at a time.
- **Encoding:** terra's sandbox saved the Arabic literals of `status.ts` as question marks; the fix round rewrote them with `\u` escapes.
- **Sandbox limits:** builders could not run Windows CIM or the PowerShell script; the Lead ran every gate outside the sandbox.
- **Network:** the GitHub API was unreachable for several minutes during a CI wait; nothing was lost.

## Recorded residuals

- **M6-05:** `cli/main.ts` cannot be mutation-measured (the tests reach it through child processes, Stryker reports no coverage); it is covered by CHK-M6-05-b and CHK-M6-05-e.
- **M6-08 crash demo:** the fault is the Supervisor's own `SIGKILL` right after it holds an events result; the demo proves the boundary by state (200 with events logged, unchanged cursor with a NULL error, no new rows, old ETag after takeover). An external kill between the response headers and the client read is not witnessed.
- **M6-QA1:** the helper's failure-path cleanup does not bound `killTree` by the remaining deadline and can report pre-kill survivors as current leaks when the deadline expires; it only matters when a test is already failing.
- **No real-GitHub smoke** was run by the Lead (it never sees a token). Optional, the owner's choice: one run against a private test repository with a repository-scoped, Issues-R, 30-day token.

## Close

- **CI:** push runs on `m6-integration` green; per-card verify dispatches 4/4 on every card.
- **Full mutation dispatch:** run 43579710833 on `m6-integration` (module list now includes `status.ts` and the four GitHub intake files). Result: see the line added at the end of this section.
- **Acceptance (Lead, Windows, Node 26, fresh clone of `m6-integration`, no `-Source`, no `-SkipBaseline`):** `M6.ps1`, `M5.ps1`, `M4.ps1`, `M3.ps1` all end `PASS` (M6: 15 steps).
- **Owner's machine:** the owner repeats the four runs from an `m6-integration` checkout.
- **Docs:** everything under `docs/manual` stays local and is not pushed.

## Lessons for M7

- Run every acceptance script and every new PowerShell file on Windows PowerShell 5.1 early; the four pitfalls above cost most of M6-08.
- A protected test that observes a process must give the executor a lifetime that exceeds the slowest identity lookup under load, not a timing guess.
- Put identity helpers in one shared, strict module from the first process test; five rounds of per-file fixes (M6-QA1) were avoidable.
- Pin loop and CLI wiring (deps, flags, exit codes, idle rule) in the contract before briefing the protected tests, not after.
- A builder sandbox that cannot run CIM or PowerShell still needs the Lead to run the gates outside it; plan one job at a time on a memory-tight machine.
- Keep `stryker.config.json` and its dry-run timeout in step with the size of the suite.
