# M1 acceptance script safety repair

The current `acceptance/M1.ps1` removes a fixed directory under `TEMP` recursively before cloning. Replace that behavior with a unique, owned destination per run; never delete or reuse a pre-existing path. Do not remove temporary content automatically. Print the destination so a human can inspect it.

Accept optional `-Source` for a Git clone source, defaulting to the existing GitHub URL. Supplying a local nonexistent path enables a no-network failure test. Source is data passed as a Git argument, not shell code. A failed clone or invalid Node version must stop immediately with nonzero exit, without entering a missing directory or running subsequent acceptance checks. Preserve the other acceptance steps and do not claim a passed acceptance if any step fails. Do not push, merge, or delete directories. Builder scope is only `acceptance/M1.ps1`; the Lead owns protected tests and documentation.

`CHK-M1-ACCEPT-SAFE-a`: two invocations with a local nonexistent source fail without network, and do not delete or change a pre-existing `factory-m1-acceptance` directory under their temporary parent.

`CHK-M1-ACCEPT-SAFE-b`: the generated clone destination is unique per invocation; failed clone does not run install/test/build. A complete M1 acceptance still requires the documented remote and platform evidence; this repair is not acceptance by itself.

## Local review record, 2026-11-09

OpenCode `opencode/nemotron-3.5-super-vl-free` implemented the repair before the Designer's model-routing change. Antigravity `gemini-4-argon-high` performed a read-only review of the identical script content subsequently committed as `0ff94c8`, reporting no actionable blocking finding. The Reviewer noted that resetting `LASTEXITCODE` before every step would be a defensive improvement for future non-native steps; this is not established as a failure in the present native-command-only script. The read-only relay reported no working-tree modification. Codex independently ran the four protected Windows safety checks with a local-only test repository; they passed. This does not establish Linux CI, remote CI, a complete acceptance run, or review of later script changes.
