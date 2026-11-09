# M1 acceptance traceability strict mode

The existing traceability script treats an explicit deferred result as covered for planning. That is not evidence the check passed. Preserve existing coverage behavior by default, but add `--require-passing` to single-card and `--all` modes so every required check ID has at least one result and every result recorded for that ID is `pass`. A conflicting duplicate, deferred, failed, missing, or malformed entry cannot satisfy strict mode. Maintain the current parsing and exit/error behavior for other flags. Deferred checks should keep acceptance open.

Builder may modify only `scripts/check-traceability.mjs` and `acceptance/M1.ps1`; the Lead owns the protected regression tests. No network, GitHub, shell commands, commits, or changes to evidence records. Never manufacture a passing result.

In strict `--all` mode, discover card sections and their check IDs from milestone specifications as well as evidence directories; a specified card with no evidence directory must fail. Support `--card-prefix <prefix>` only with `--all`, and use `--all --require-passing --card-prefix M1-` in M1 acceptance so incomplete M2 cards do not masquerade as missing M1 evidence. A strict prefix matching no specified cards must fail rather than report success. Preserve default non-strict behavior.

`CHK-M1-TRACE-STRICT-a`: existing default coverage mode continues to report an explicit deferral as covered; strict single-card mode reports that same evidence as non-passing.

`CHK-M1-TRACE-STRICT-b`: strict mode accepts evidence where all required IDs pass and works in both single-card and `--all` modes. Missing/deferred evidence makes strict mode nonzero.
