# M2 status: preliminary design

Status: draft only. Depends on the as-yet-unaccepted storage and ownership work. No change here authorizes a GitHub upload or a merge to `main`.

The status command must work without starting a Supervisor, changing domain rows, migrating the schema, creating a missing database, or acquiring the writer lock. Open an existing state database read-only, close it on every path, and report a missing, unreadable, or incompatible database explicitly. A WAL database may have SQLite-managed sidecar activity; do not claim that opening it causes no filesystem activity without testing the platform.

Report structured JSON and an Arabic human-readable rendering of the same facts: schema version, number of recorded commands, and the lease's owner, generation, heartbeat time and recorded state when present. The commands table is an append-only log and has no processing status yet, so do not label all recorded commands as pending. The heartbeat may be fresh, stale, absent, released, or in the future relative to the observer's clock. A fresh heartbeat is evidence of recent reporting, not proof a process is currently alive; never display `RUNNING` merely from freshness. Do not return secrets or command payloads.

Before building, freeze a small command-line contract, JSON schema and error exit codes; add protected tests for absent database, read-only access, active/released/stale/future heartbeat, schema mismatch, malformed arguments, Arabic/JSON parity and unchanged database state. Ensure build/package configuration actually produces a usable CLI entry; the present build only packages `core/index.ts`. Status stays local until all required review and verification layers pass.
