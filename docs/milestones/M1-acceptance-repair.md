# M1 acceptance script safety repair

The current `acceptance/M1.ps1` removes a fixed directory under `TEMP` recursively before cloning. Replace that behavior with a unique, owned destination per run; never delete or reuse a pre-existing path. Do not remove temporary content automatically. Print the destination so a human can inspect it.

Accept optional `-Source` for a Git clone source, defaulting to the existing GitHub URL. Supplying a local nonexistent path enables a no-network failure test. Source is data passed as a Git argument, not shell code. A failed clone or invalid Node version must stop immediately with nonzero exit, without entering a missing directory or running subsequent acceptance checks. Preserve the other acceptance steps and do not claim a passed acceptance if any step fails. Do not push, merge, or delete directories. Builder scope is only `acceptance/M1.ps1`; the Lead owns protected tests and documentation.

`CHK-M1-ACCEPT-SAFE-a`: two invocations with a local nonexistent source fail without network, and do not delete or change a pre-existing `factory-m1-acceptance` directory under their temporary parent.

`CHK-M1-ACCEPT-SAFE-b`: the generated clone destination is unique per invocation; failed clone does not run install/test/build. A complete M1 acceptance still requires the documented remote and platform evidence; this repair is not acceptance by itself.
