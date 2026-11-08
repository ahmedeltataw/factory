# M1 temporary Lead / Reviewer assessment

Date: 2026-11-08. Reviewed baseline: `559abdb38e9e38c8ff80bd079fc6cc813edcf6f5`.

## Decision

**Pending**, not a milestone closure. The temporary Lead and Reviewer are both Codex; this is not Claude's independent final check. No evidence of a GitHub run URL or a fresh-clone replay on both operating systems was established in this review. The earlier Designer-reported CI and acceptance results remain historical reports, not newly verified runs. Claude's later review and the outstanding milestone requirements remain open.

## Local checks

On Windows with Node 26.13.0 and pnpm 12.15.0, the frozen lockfile install, typecheck, build, and all 252 tests passed. The manifest verified 20 entries, the forbidden-import scan passed, traceability checked all five M1 cards, and the evidence validator accepted the six existing records. The test runner initially failed to rename temporary files under its default temporary directory; setting `TEMP` and `TMP` to a workspace-local directory allowed the test suite to pass. These checks do not establish the four-cell CI matrix or a fresh-clone replay.

## Findings and follow-up

1. `CHK-M1-04-a` explicitly requires a CI run URL, but the existing record reports the four cells without a URL. Capture and verify it when permitted, or record an explicitly approved exception; do not mark the requirement independently verified.
2. `M1-04/1.json` itself records `L3` as pending milestone review. Preserve that status until the required review and closure conditions are satisfied.
3. `acceptance/M1.ps1` recursively deletes a fixed directory named `factory-m1-acceptance` under `TEMP` before cloning. It was not run in this assessment. Make the acceptance run use a unique owned directory and handle cleanup safely before a future run.
4. The traceability script accepts a `not-run` check with `deferred_to`, while the policy describes pass coverage. A passing traceability check by itself therefore does not prove that every check ran. Review deferred results and their destination evidence explicitly.
5. `check-evidence.mjs` verifies a small structural subset of the policy's example; it does not independently verify command output hashes, commit identities, or reviewer independence. Review those against source evidence rather than treating its exit code as proof of them.

No GitHub write or upload was performed. `main` was left unchanged.
