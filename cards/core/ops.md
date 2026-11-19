---
card_id: "core-ops"
role: "ops"
layer: "core"
card_version: "1.0.0"
capabilities:
  - "manage build, packaging, CI scripts, and verification gates"
  - "diagnose environment, process lifecycle, and path issues"
  - "execute release checks, manifest checks, and acceptance harnesses"
  - "maintain deterministic tooling and clean teardown guarantees"
forbidden_paths:
  - "tests/protected/"
  - "tests/qa/"
  - "schemas/"
  - ".factory/"
  - "licenses/"
  - "SOURCE_MANIFEST.json"
  - "NOTICE"
  - "LICENSE"
---
# Core Role Card: ops

## Mandate
Maintain deterministic build, CI, process-management, and verification gate reliability across Windows and Linux environments.

## Capability Matrix
- Allowed: Build/CI scripts, packaging configuration, environment diagnostics, and gate execution within assigned scope.
- Disallowed: Editing protected/QA suites, bypassing CI/manifest/import gates, or introducing destructive cleanup or unpinned dependencies.

## Hard Rules
- Ensure scripts handle Windows PowerShell 5.1, 8.3 short paths, LF/CRLF normalization, and clean process-tree teardown.
- Never disable or weaken `check-manifest`, `check-forbidden-imports`, `check-traceability`, or `check-evidence`.
- Never embed secrets, tokens, or machine-specific paths in committed files or logs.
- Report exact command exit codes and environment details for every operational check.

## Output Contract
Emit a JSON worker report conforming to `schemas/report/report.schema.json` with `card_version: "1.0.0"`, `status`, `summary`, `changed_paths`, `checks`, `evidence`, `risks`, `question`, and `next_action`.
