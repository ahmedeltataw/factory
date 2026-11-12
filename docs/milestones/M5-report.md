# M5 report: task graph, phases and init

Status: closing | 2026-11-12
Branch: `m5-integration`. Written by the Lead.

## Result

M5 adds these features:
- **Schema v7:** `phases` and `task_deps` tables with triggers; `tasks.phase` defaults to `intake`.
- **Graph core:** `core/graph.ts`, a pure `planDispatch` with the rules block, phase-locked, deps, scope, backoff and schedule. Output is `{schedule, block, wait}`.
- **Commands:** `task create --phase/--after` and `phase advance`.
- **Dispatch:** the supervisor loop dispatches through `planDispatch`.
- **Status:** phases, per-task phase, `dependsOn`, `waiting` and the Arabic view.
- **Init:** `init` creates the five phase rows.
- **Legacy projects:** a project with no phase rows behaves as in M4 (contract amendment CHK-M5-05-c).
- **Acceptance:** `acceptance/M5.ps1`, demos 10-14 (init, graph chain and diamond, block, phase, crash with takeover).

12 cards are merged with evidence (M5-01 to M5-08, QA1, QA2, WIN, WIN2); M5-09 is this close.

## Cards

| Card | Builder | Reviewer | Recorded result |
|---|---|---|---|
| M5-01 | gpt-6.1-terra | gemini-3.8-flash-high | Merged with evidence. |
| M5-02 | gemini-3.8-flash-high | gpt-6.1-sol | Merged with evidence; CHK-M5-02-b is repeated from an `m5-integration` checkout at close. |
| M5-QA1 | gpt-6.1-terra | gemini-3.8-flash-high | Merged with evidence. |
| M5-QA2 | gemini-3.8-flash-high | gpt-6.1-sol | Merged with evidence. |
| M5-WIN | gpt-6.1-terra | gemini-3.8-flash-high | Windows stability; merged with evidence. |
| M5-WIN2 | gemini-3.8-flash-high | gpt-6.1-sol | Windows stability; merged with evidence. |
| M5-03 schema v7 | gpt-6.1-terra | gemini-3.8-flash-high | Merged; `store.ts` 93.88, `init.ts` 81.25. |
| M5-04 graph core | gemini-3.8-flash-high | gpt-6.1-sol | Merged; `graph.ts` 94.01. |
| M5-05 commands, legacy projects | gpt-6.1-terra | gemini-3.8-flash-high | Merged after the phase-less amendment; `apply-commands.ts` 90.41, `commands.ts` 82.72. |
| M5-06 dispatch | gpt-6.1-terra | gemini-3.8-flash-high | Merged after 4 protected-test rounds; `supervisor-loop.ts` 86.48. |
| M5-07 status | gemini-3.8-flash-high | gpt-6.1-sol | Merged after 4 rounds; mutation 93.95 on the card. |
| M5-08 acceptance script | terra, then gemini-3.8-flash-high | gpt-6.1-sol | Lane change after terra's patch tool failed 3 times on `M5.ps1`; 7 findings fixed in 3 rounds; demos 10-14 pass. |
| M5-09 close | Lead and owner | none | See "Close" below. |

Card results come from `.factory/evidence/<card>/1.json` on `m5-integration`.

## What review and CI caught

- **Contract conflict (M5-05):** the M3 protected fixture has no phase rows, so the first run failed 105 tests (56 outside the sandbox). terra reported a contract conflict and the Lead amended CHK-M5-05-c: phase-less projects behave as M4. Muse reviewed it (inbox #20) and 3 minor findings were accepted.
- **Contract drift (M5-05 review):** Flash's "changes" verdict came only from the card branch lacking the integration contract edits. Fixed by merging `m5-integration` into the card branch.
- **Exact-shape protected tests (M5-07):** m4-schema CHK-M4-01-d and m5-schema CHK-M5-03-d assert the exact status shape and failed once status gained fields. terra updated them.
- **Protected tests (M5-06, sol):** 8, 4 and 1 findings over 4 rounds.
- **Mutation:** M5-07 first scored 72.33 (below 80); in-process tests lifted it to 93.95. M5-06 scored 78.69; idle tests lifted it to 86.48.
- **Acceptance script (M5-08, sol):** Step 12 counted commits on a task that never ran (git exit 128); a queued kill was never applied by a supervisor; cleanup took one process snapshot instead of repeating until none remained.
- **Muse QA:** issues #12 and #20 closed; #19 answered (PID-only lookup audit, see Lessons). Muse qa-bug #13 (M4-01 CHK-M4-01-d recorded pass with 2 suite failures at merge time) is still open; it is an M4 record fix and does not block M5.

## Incidents

- **Telegram bot invisible to the group:** bot privacy mode was on, so `@Lead` messages from Muse did not arrive. Making the bot a group admin fixed it (checked with getChatMember, then messages arrived).
- **Weekly usage:** the weekly limit reached 99%, so all work stopped until the reset (rule saved: stop at 99%).
- **DNS outage:** the Internet was down, which blocked push and clone until it came back.
- **agy first run failed (M5-06):** the brief lacked the CRITICAL command whitelist, so permission was auto-denied.

## Close

- **CI:** push run 43195227145 on `ba235dd` is green on all four cells (windows and ubuntu, node 24 and 26).
- **Mutation:** full run 43195254715 on `ba235dd` passed. Total 89.04, break threshold 80. Per file: `apply-commands.ts` 90.41, `commands.ts` 83.95, `fence.ts` 100.00, `outbox.ts` 83.25, `recovery.ts` 88.38, `store.ts` 93.88, `supervisor-lease.ts` 81.19, `supervisor-loop.ts` 86.07, `graph.ts` 94.01, `scope.ts` 99.18. The run took 2 h 39 min on one runner for 2071 mutants.
- **Acceptance:** per CHK-M5-02-b the Lead ran `acceptance/M5.ps1`, `acceptance/M4.ps1` and `acceptance/M3.ps1` from an `m5-integration` checkout with no `-Source`. Results: `M5: PASS` (steps 1-14), `M4: PASS`, `M3: PASS`. The owner repeats them on the owner machine before `main` moves.

## Lessons for M6

- `acceptance/M5.ps1 -SkipBaseline` always prints `M5: FAIL` by design; only the full run counts.
- Windows PID reuse and libuv job objects: do not trust a PID alone. A follow-up card audits tests that look up a process by PID only (Muse #19). There is no regression test because the case is not deterministic on CI.
- agy briefs must start with a CRITICAL line that whitelists shell commands, and must not use globs.
- terra's patch tool fails on BOM and CRLF files with nested here-strings. Give such files to Flash and review with sol.
- When a status shape gains fields, update every exact-shape protected test in the same card.
- Phase-less legacy fixtures: say in the contract how old fixtures behave before changing a schema default.
- Full mutation is slow (about 2.7 hours for 10 files). Dispatch per-file groups in parallel for quick feedback and keep the full run for close.
- Keep the Telegram bot a group admin and put `@Muse` in every message meant for him.
