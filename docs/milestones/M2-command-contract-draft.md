# M2 command log: proposed contract

Status: draft for review; do not implement against it yet. Local branch `codex/m2-commands` is based on the still-unaccepted storage and verification work. Nothing here authorizes a merge into `main` or upload.

## Boundaries

The CLI may append commands; the Supervisor owns processing and all domain effects. Recording a command is not proof that it has been processed. External side effects, outbox delivery, authorization, answers and lease ownership are separate contracts and are not solved by this draft.

## Proposed command envelope

Each command has an immutable caller-supplied ID, project ID, kind, payload encoded as JSON text, and creation timestamp. Project IDs reference existing projects. Store the exact submitted JSON text as part of the immutable envelope. Require syntactically valid JSON and nonempty IDs and kind; define timestamp validation explicitly in the protected tests. The proposed initial comparison for an existing command ID is byte-for-byte equality of every envelope field: an identical retry is a duplicate and returns the existing record; a different envelope with the same ID is a conflict, never an overwrite. Equivalent JSON with different whitespace counts as different unless a future approved contract introduces canonicalization.

The database must prevent command rows from being updated or deleted through ordinary SQL, not merely through the public API. Insert and duplicate detection must be safe under concurrent connections. Avoid `INSERT OR REPLACE`; foreign-key failures and invalid JSON must not create a partial command. A versioned migration must preserve existing projects and reject unsupported future schema versions.

## Processing invariant to specify separately

A later processing card must define a transaction that claims an eligible command, records a domain transition and marks the command applied atomically, so a duplicate command or restart cannot apply that local transition twice. A database transaction alone cannot guarantee exactly-once behavior for an external API; that needs the later outbox and idempotency contract. Failed or interrupted processing must not falsely mark a command applied. Lease ownership and stale-takeover requirements must be frozen before dispatching concurrent workers.

## Before builder dispatch

1. Review the storage contract and its pending gates; define the next schema version and how previous protected tests should evolve without changing historical evidence.
2. Freeze the TypeScript and SQL interfaces, error classes, timestamp format, size limits, payload handling and whether empty or whitespace-only fields are accepted. Resolve the semantics of reused IDs and transaction ownership explicitly.
3. Write protected tests first: fresh and upgrade migrations; foreign keys and malformed inputs; insert, byte-identical retry, conflicting retry; direct update/delete rejection; two-connection races and crash/reopen behavior. Include generated inputs and mutation targets.
4. Assign a bounded, separate-worktree builder card, then independently review the diff and run the applicable verification layers. Never declare remote CI or Claude's review complete without evidence.
