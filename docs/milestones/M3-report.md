# M3 report: single-task slice and recovery

Status: closed | 2026-11-10  
Branch: `m3-integration`; report based on head `a70cfd0bd3206911a37e3d5649d66342c4537ca0`.

## Result

M3 implements the single-task slice: schema v5 and lease fencing, idempotent commands, worktrees and attempt evidence, process-tree handling, an outbox, Supervisor recovery, and status. M3-08 adds the acceptance script and fake-executor build entry.

The M3-01 through M3-08 cards and the fix/CI cards have passing recorded checks. The local strict traceability check passes for 25 cards; M3-09 is not yet a traced card heading. Recorded results are tied to their evidence heads, not a fresh full-suite run on this head. M3-09 closed after CI and owner acceptance.

## Cards

| Card | Builder | Reviewer | Recorded result |
|---|---|---|---|
| M3-01 schema and fence | gpt-6.1-terra | gemini-4-argon-high | Approved; 358 tests; store/fence mutation 91.25% combined. |
| M3-02 commands | gpt-6.1-terra | gemini-4-argon-high | Approved; 430 tests; command mutation 84.52% combined. |
| M3-03 worktree and evidence | gemini-3.8-flash-high | gpt-6.1-sol | Approved after four review rounds; 375 tests. |
| M3-03-fix short paths | gpt-6.1-terra | gemini-4-argon-high | Evidence records passing tests on four CI cells, including Windows 8.3 TEMP paths. |
| M3-04 process tree | gpt-6.1-terra | gemini-4-argon-high | Approved after four rounds; 456 tests. The original Windows mutation exception is superseded by M3-04-mut. |
| M3-04-fix and M3-04-mut | gpt-6.1-terra | gemini-4-argon-high | Fix approved; 36 targeted Windows tests recorded. Platform-stubbed in-process tests raised Linux mutation from 64.48% to 87.70% in CI run 42883233314. |
| M3-05 outbox | gpt-6.1-terra | gemini-4-argon-high | Approved; 457 tests; outbox mutation 85.83%. |
| M3-06 recovery | gpt-6.1-terra | gemini-4-argon-high | Approved; 553 tests, typecheck and build; recovery mutation 87.19%, loop 80.77%. |
| M3-07 status | gemini-3.8-flash-high | gpt-6.1-sol | Approved after payload and pending-command fixes; 511 tests at merge. |
| M3-CI workflow | gpt-6.1-terra | gemini-4-argon-high | Evidence records passing dispatch, matrix and PR base-scope checks. |
| M3-08 acceptance | gemini-3.8-flash-high rounds 1-12; gpt-6.1-terra from round 13 | gpt-6.1-sol rounds 1-4; gemini-4-argon rounds 5-6 | Approved; development run 15 with `-SkipBaseline` passed all 14 executed steps, removed its run directory and left zero processes. |
| M3-09 close | Lead and owner | — | Closed: CI green, owner acceptance M3 PASS and M2 PASS. |

Card results come from `.factory/evidence/<card>/1.json`; M3-04-mut's result is recorded under M3-04-fix. Antigravity 1.5.5 denied commands in edit runs, prompting the M3-08 builder switch documented in `M3.md`.

## What review and CI caught

- M3-03 review found containment, grandchild lifecycle, NUL-delimited path and log-validation issues. M3-04 review found self-kill and nonce guards, executor path, and Linux process handling issues.
- Windows CI exposed short versus long path mismatches in worktree checks and the outbox property helper. The fixes canonicalize paths.
- Process-tree fixes addressed Windows worker detachment, PID reuse and late descendants, and Linux root reaping. CIM command lines use validated UTF-16 base64 to avoid encoding corruption.
- M3-06 review and test review clarified recovery and final failure behavior; M3-07 review caught outbox payload and pending-command issues.
- The fixed nonce in `tests/protected/m3-recovery.spec.ts` belongs to a stubbed `spawnWorker`, with no real process. This finding is closed; no card is needed.

## Lessons for M4

- Resolve and kill the real `node.exe`: the nvm `node` launcher can exit while the Supervisor survives and retains its OS lock.
- In PowerShell 5.1, use `${x}:` where a colon follows a variable; avoid `$pId`, which aliases the automatic `$PID` variable.
- For long paths, use a bounded `robocopy /MIR /R:0 /W:0` cleanup before removing the directory; `Remove-Item` can fail beyond 260 characters.
- Drain stdout and stderr separately and asynchronously, with a deadline. Handle native stderr deliberately: `ErrorActionPreference = Stop` can turn it into a terminating error.
- Compare canonical paths using `realpathSync.native`; for missing paths, resolve the nearest existing ancestor before appending the remainder.
- Freeze contracts before protected-test review, and record evidence for fix and CI cards as well as core cards.

## Open items

- CI on head a70cfd0 (run 42886551175): verify green on all four cells (Ubuntu and Windows, Node 24 and 26), traceability included; full mutation job pending.
- Owner acceptance 2026-11-10 on Windows, source m3-integration: `acceptance/M3.ps1` printed `M3: PASS` and `acceptance/M2.ps1` printed `M2: PASS`. Linux is covered by CI (Ubuntu, Node 24 and 26).
- CI run 42886551175: all four verify cells and the full mutation job passed.
- M3-06 records an `attempt-after-spawn` process-only mutation exception. Deliberate scope limits remain: attempt timeouts, Windows Job Objects, `status --watch`, and real provider executors.
