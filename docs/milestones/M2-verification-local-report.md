# M2 storage verification: local results

Status: partial, pending CI and review. Verified code and tests: local commit `5ab899b` on `codex/m2-validation`, derived from storage implementation `50ea628`. The later commit containing this report changes documentation only.

- On Windows with Node 24.22.2 and Node 26.13.0, 12 test files and 260 tests passed, including 25 generated migration/reopen cases per property run. Typecheck passed on Node 24. Build, manifest, forbidden-import and existing M1 traceability checks passed; the build still packages only the M1 core, not the store.
- Node 24 Stryker run over `supervisor/src/app/store.ts` passed at **82.98%** (39 killed, 7 survived, 1 uncovered, no errors; 47 total). Seven survived and one uncovered remain review inputs, not proof of correctness. The second-version recheck was tested by injecting a version change immediately before the transaction; this is not a real multi-process concurrency test.
- The focused mutation run initially scored 70.21% and failed. Lead added contract checks for the version change, unavailable WAL and separately visible committed state; the later measurement passed. The local JSON report is ignored/generated at `reports/mutation/mutation.json`, SHA-256 `5979bf1548a9623884931f727b5aa84c1ed40e2107b9239d1521844002601ebc`.
- The frozen-lockfile install succeeded with registry metadata available and scripts disabled. A separate `--offline` attempt failed due to missing cached registry metadata; do not report it as a pass. This was not a clean-clone install.
- The Ubuntu mutation job is configured but has not run. No Linux environment is installed locally, and no CI, remote matrix, fresh-clone replay, milestone acceptance or Claude review is claimed. GitHub writes remain prohibited; no work was merged into `main`.

Open work includes review of surviving mutants and actual multi-process locking, the permitted path to independent review/CI, and the remaining M2 schemas, commands, lease protocol and status. The existing traceability `--all` output covered M1 only; it does not establish M2 acceptance.
