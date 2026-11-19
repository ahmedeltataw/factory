# M7 report: Quotas, parallel slots, budget controls

Status: closed | 2026-11-19
Branch: `m7-integration`. Written by the Lead.

## Result

M7 adds concurrency caps, sliding-window provider quotas, task/phase/project budget caps, per-actor daily intake limits, commands/CLI, status visibility, and end-to-end acceptance coverage to the Supervisor.

- **Schema v9 (`M7-01`):** `limits`, `quota_windows`, `quota_reservations`, and `budget_caps` tables plus `tasks.provider` (`'default'`). Triggers forbid deleting reservations, forbid moving state backwards (`reserved -> settled | released`), enforce one reservation per attempt, and preserve all M3-M6 data and triggers on v8-to-v9 upgrade; v10 databases are refused unmodified.
- **Planner slots and gates (`M7-02`):** `planDispatch` enforces `maxParallel` (excess ready tasks wait with reason `slots` in task order) and `gates` (tasks gated by `quota` or `budget` neither consume slots nor join `held`, so later tasks are not blocked by them).
- **Quota ledger and loop wiring (`M7-03`):** new `supervisor/src/app/quota.ts` (`check`, `reserve`, `settle`, `release`) wired into `supervisor-loop.ts`, `recovery.ts` (`scheduleAttempt`, `finishAttempt`, `failExhaustedEffects`, `reconcileWorkers`), and `faults.ts` (`quota-after-reserve`). Counts are exact across crashes, kills (running -> `settled`, pending -> `released`), timeouts, outbox exhaustion, and stale-lease takeovers; loop idle rule respects `retryAtMs`.
- **Budget caps and thresholds (`M7-04`):** `budgetState` and `budgetUsage` in `quota.ts` across `task`, `phase`, and `project` levels (narrowest full cap wins: task, phase, project), floor-percentage states (`ok` <70, `warn` 70-89, `fallback-needed` 90-99, `stop` >=100). Lowering a cap stops new dispatch without killing running attempts; raising it resumes on the next tick.
- **Intake budget (`M7-05`):** optional `maxPerActorPerDay` (1..1000) in `github-policy.json` (`sources/github/gate.ts`, `ingest.ts`). Evaluated per event as processed against a rolling 24 h window (`Date.parse(received_at) > nowMs - 86400000`); excess events are stored `rejected` with reason `actor-daily-limit` while keeping event-ID dedupe and `maxPendingPerRepo`.
- **Commands and CLI (`M7-06`):** append-only `limits set`, `quota set|clear`, `budget set|clear`, and `task create --provider` (`commands.ts`, `apply-commands.ts`, `cli/main.ts`). Commands queue safely when the Supervisor is stopped, apply once under fence, and reject bad input with frozen named reasons.
- **Status (`M7-07`):** `status --json` adds always-present `dispatch` (`open | waiting-quota | paused-budget`), `limits`, `quota` (`resetsAt` `null` when `used === 0`), and `budget` (`null` on empty tables), `schemaVersion` 9, and waiting reasons `slots`/`quota`/`budget`. Arabic output reports facts only (never "remaining tokens").
- **Acceptance (`M7-08`):** `acceptance/M7.ps1` (Windows PowerShell 5.1, 15 steps) running baseline gates plus demos 10-15: init, parallel cap, sliding quota window, project budget pause/resume and Arabic text check, per-actor daily intake cap with canary isolation, and mid-run Supervisor kill with `--takeover` reconciliation.
- **Hardening and Windows fixes (`M7-FIX1`, `M7-FIX2`, `M7-FIX3`, `M7-QA1`):** single `ETIMEDOUT` retry in `process-identity.ts` (Muse #29); longer fake-worker overlap window in `CHK-M4-06-b`; Windows `killTree` natural-exit verification when `taskkill` returns exit 128 (`process-tree.ts`); multi-repo Arabic status assertions (Muse #27), deterministic `not_before_ms` headroom (Muse #31), and single-store transactional resets in `m2-lease-property` / `m5-commands-property` fixing Windows Node 26 CI timeouts (#209/#226).

12 M7 cards are merged into `m7-integration` (10 tracked cards with evidence in `.factory/evidence/M7-*/1.json` plus 2 targeted test-helper fixes `M7-FIX1` and `M7-FIX2`); M7-09 is this close.

## Cards

| Card | Builder | Reviewer | Recorded result |
|---|---|---|---|
| M7-01 schema v9 | gpt-6.1-terra | gemini-3.8-flash-high | Merged (`73d9f0d`); CI verify 4/4 (`43661701891`); `store.ts` mutation 93.81 (`43663298711`). |
| M7-02 slots and gates in planner | gemini-3.8-flash-high | gpt-6.1-sol | Merged (`f7880fb`); CI verify 4/4 (`43662377675`); `graph.ts` mutation 94.79 (`43663301290`); fixed own-property gate lookup. |
| M7-03 quota ledger and loop wiring | gpt-6.1-terra | gemini-3.8-flash-high | Merged (`aa2e914`); CI verify 4/4 (`43703109919`); `quota.ts` mutation 90.00 (`43703121602`); switched property tests to savepoint store-reuse. |
| M7-04 budget caps and thresholds | gemini-3.8-flash-high | gpt-6.1-sol | Merged (`fa27d3f`); CI verify 4/4 (`43706384919`); `quota.ts` mutation 100.00 (`43706395821`); scoped reservations to project tasks. |
| M7-05 intake budget per actor/day | gemini-3.8-flash-high | gpt-6.1-sol | Merged (`b1f8cc5`); CI verify 4/4 (`43686958394`); `ingest.ts` mutation 84.36 (`43686967150`); parsed `received_at` ms and counted per event. |
| M7-06 commands and CLI | gpt-6.1-terra | gemini-3.8-flash-high | Merged (`32ccee3`); CI verify 4/4 (`43708850395`); `apply-commands.ts` mutation 88.76 (`43708190625`). |
| M7-07 status of limits, quota, budget | gemini-3.8-flash-high | gpt-6.1-sol | Merged (`00bd87e`); CI verify 4/4 (`43716519719`); updated exact-shape protected status specs; status calls `quota.check` once per ready task. |
| M7-08 acceptance/M7.ps1 | gemini-3.8-flash-high | gpt-6.1-sol | Merged (`2cd246e`); CI verify 4/4 (`44270663497`); approved r9 after tightening Step 15 takeover counts, pre-expiry single-snapshot checks, and temp relocation fallbacks. |
| M7-FIX1 process enumeration retry | gpt-6.1-terra | gemini-3.8-flash-high | Merged (`b67e024` / `188dce9`); retries `findProcessesWithNonces` once on `ETIMEDOUT` (Muse #29). |
| M7-FIX2 FIFO overlap worker sleep | gemini-3.8-flash-high | gpt-6.1-terra | Merged (`1ccd7c6` / `de995f3`); widened fake-worker sleep in `CHK-M4-06-b` under load. |
| M7-FIX3 Windows killTree exit race | gpt-6.1-terra | gemini-4-carbon-high | Merged (`8c3d97b`); CI verify 4/4 (`44267119366`); `process-tree.ts` mutation 87.66 (`44265833457`); verifies remaining tree when `taskkill` exits 128. |
| M7-QA1 test hardening & property speed | gemini-4-carbon-high | gpt-6.1-sol | Merged (`ef4701b`); CI verify 4/4 (`44267470915`); multi-repo Arabic status (#27), `not_before_ms` headroom (#31), and property store-reuse (`m2-lease-property` 637 ms, `m5-commands-property` 544 ms). |
| M7-09 close | Lead | none | See "Close". |

Card results come from `.factory/evidence/M7-*/1.json` and merged commits on `m7-integration`.

## What review and CI caught

- **Contract review before freeze (Muse #28):** pinned `resetsAt: null` when `used === 0`, frozen command rejection reasons, per-event intake counting (not once per poll), reservation linkage and failure/kill/outbox/takeover semantics, and `check`/`reserve` parity property.
- **Planner and budget edge cases (sol):** own-property lookup for `gates` (`M7-02`), counting only reservations belonging to tasks in the current project (`M7-04`), parsing `received_at` timestamps in milliseconds (`M7-05`), and calling `quota.check` once per ready task in status (`M7-07`).
- **Acceptance hardening (sol + Lead live runs):** Step 12 pre-expiry assertions moved onto one status snapshot; Step 15 enforced full takeover lifecycle counts (both tasks `done`, 2 original `interrupted` + 2 replacement `succeeded` attempts = 4, 4 `settled` reservations) with `--max-units 4` and short-temp fallback paths.
- **Windows `killTree` natural-exit race (M7-FIX3):** live execution of `M7.ps1` Step 15 exposed that when an orphaned worker exits naturally between `windowsProcesses` and `taskkill /T /F /PID`, `taskkill` returns exit 128 and `killTree` previously returned `kill-failed` without checking whether any tree member remained alive.
- **Windows Node 26 CI timeouts (CI #209/#226, M7-QA1):** creating a fresh temp directory and running SQLite migrations on every fast-check sample pushed `m2-lease-property` and `m5-commands-property` past the 30 s per-test timeout under Windows CI load; reusing one store with transactional resets cut both suites to under 1 s each.

## Incidents

- **Shared-host CPU contention during acceptance:** another local project intermittently ran headless browser WebGL renders (~95% host CPU), causing wall-clock timing failures in `M5.ps1` Step 5 (`CHK-M4-06-a` and `ETIMEDOUT`). Waiting for idle CPU and no active external renderer before launching each acceptance script resolved it cleanly.
- **Antigravity 600 s tool-command ceiling:** full fresh-clone acceptance runs take 10-13 minutes each and exceeded the 600 s foreground command timeout. Running them via hidden WMI breakaway (`Win32_Process.Create` with `ShowWindow = 0`) avoided both timeouts and visible console windows.
- **Encoding on PowerShell pipes:** piping raw Arabic strings through PowerShell 5.1 turned characters into `?` on `board.json` (caught by Muse and fixed using `\u` escapes / UTF-8 file writes).

## Recorded residuals

- **`cli/main.ts` mutation coverage:** unchanged from M6 — reached via child processes in tests, so Stryker reports no coverage; covered by protected CLI tests (`CHK-M7-06-*`, `CHK-M7-07-*`) and `acceptance/M7.ps1`.
- **`maxPerActorPerDay` default:** policy version stays 1 and `maxPerActorPerDay` is optional (absent = M6 behavior). The M6 intake flood residual is closed once the owner sets it in `github-policy.json` (recommended: 20).
- **Real-GitHub smoke:** unchanged from M6 — optional owner-only smoke against a private test repo with a short-lived Issues-R token (the Lead never handles real tokens).

## Close

- **Static gates and strict traceability:** `check-manifest.mjs` OK (20 entries), `check-forbidden-imports.mjs` OK (42 files), `check-evidence.mjs` OK (78 records), `check-traceability.mjs --all --require-passing` OK (**75/75 cards M1-M7 passing**, 0 skipped).
- **CI:** per-card verify dispatches 4/4 green on every card; push CI run `44272947745` on `m7-integration` (`2dec4d1`) **4/4 green** (`windows-latest` and `ubuntu-latest`, Node 24 and 26).
- **Full mutation dispatch:** run `44272946115` on `m7-integration` (`2dec4d1`, 16 modules including `quota.ts`). Result: **success**. Total **88.66%** (90.14% covered; 4724 killed, 29 timeout, 520 survived, 88 no cov, 4 error; break threshold 80). `quota.ts` **100.00%**, lowest file `supervisor-lease.ts` **81.19%**; every module at or above 80%. Per-card `process-tree.ts` mutation run `44265833457`: **87.66%**.
- **Acceptance (Lead, Windows 11, Node 26, fresh clone of `m7-integration` at `2dec4d1`, no `-Source`, no `-SkipBaseline`):**
  - `M7.ps1`: **PASS** (15 steps, 1355/1355 tests, 741 s)
  - `M6.ps1`: **PASS** (669 s)
  - `M5.ps1`: **PASS** (596 s)
  - `M4.ps1`: **PASS** (667 s)
  - `M3.ps1`: **PASS** (602 s)
- **Docs:** everything under `docs/manual` stays local and is not pushed.

## Lessons for M8

- Reuse one SQLite store with `SAVEPOINT`/`ROLLBACK TO` (or clean transactional table resets) in every new fast-check property test; never allocate a temp dir and migrate per sample.
- On Windows, treat non-zero `taskkill` exits as signals to verify remaining live tree members rather than immediate failures when processes may exit naturally in the race window.
- Never omit `ShowWindow = 0` on WMI breakaway launchers, and avoid running heavy local acceptance runs while another project is saturating host CPU.
- Always pass `-f verify=true` when manually dispatching `.github/workflows/ci.yml` for card verification (omitting it triggers mutation instead).
- Write UTF-8 files directly from Node or use `\u` escapes for Arabic text; never pipe raw Arabic literals through PowerShell 5.1.
