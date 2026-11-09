# M1 acceptance traceability strict mode

The existing traceability script treats an explicit deferred result as covered for planning. That is not evidence the check passed. Preserve existing coverage behavior by default, but add `--require-passing` to single-card and `--all` modes so every required check ID must have at least one `result: 'pass'` record. Deferred, failed, missing, and malformed entries do not satisfy strict mode. Maintain the current parsing and exit/error behavior for other flags. Make the final traceability check in `acceptance/M1.ps1` use `--all --require-passing`; deferred checks should keep acceptance open.

Builder may modify only `scripts/check-traceability.mjs` and `acceptance/M1.ps1`; the Lead owns the protected regression tests. No network, GitHub, shell commands, commits, or changes to evidence records. Never manufacture a passing result.

`CHK-M1-TRACE-STRICT-a`: existing default coverage mode continues to report an explicit deferral as covered; strict single-card mode reports that same evidence as non-passing.

`CHK-M1-TRACE-STRICT-b`: strict mode accepts evidence where all required IDs pass and works in both single-card and `--all` modes. Missing/deferred evidence makes strict mode nonzero.
