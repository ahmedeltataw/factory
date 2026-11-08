# M2 verification tools · local card

Status: in progress. Lead installs the exact dependencies recorded in ADR-0003 and owns documentation. Builder B owns `tests/config.spec.ts`, a new `tests/m2-store.property.spec.ts`, `stryker.config.json` and `.github/workflows/ci.yml`. No other files are in the builder scope; in particular do not edit protected tests or the store. Do not use shell, Git, network or GitHub. No remote operations.

- `CHK-M2-TOOLS-a`: configuration assertions retain the M1 pins and include the exact M2 development dependencies.
- `CHK-M2-TOOLS-b`: fast-check generates multiple valid project IDs/names, inserts them into a version-1 database, migrates and reopens it, and asserts exact data preservation and idempotence. Use bounded cases, per-case unique temporary directories and reliable connection/directory cleanup, including on failure.
- `CHK-M2-TOOLS-c`: Stryker config targets only `supervisor/src/app/store.ts`, uses Vitest, limits concurrency for Windows, sets the break threshold to 80, and provides text and JSON reports. The result is measured; it is never assumed.
- `CHK-M2-TOOLS-d`: the existing CI matrix remains intact; a separate Ubuntu mutation job is time-limited, uses Node 24 and a frozen install, and runs the focused mutation configuration. The job is configured locally but is not claimed as run.
- `CHK-M2-TOOLS-e`: local suite, typecheck and focused mutation run are recorded with exact outcomes. Offline installation and CI remain separately verifiable requirements.

No changes are merged into `main`, pushed, or represented as approved before review and required gates. The lead and reviewer roles are both Codex temporarily; this is not Claude's independent final review.
