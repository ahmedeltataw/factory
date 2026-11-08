# M2 preparation: runtime contract

Status: planning draft; contracts are not frozen and no builder has been dispatched. Baseline: M1 commit `559abdb38e9e38c8ff80bd079fc6cc813edcf6f5`; see `M1-local-review.md` for the outstanding milestone review.

## Purpose and boundaries

Implement the runtime contract described in the build manual: validated domain schemas, versioned SQLite migrations, append-only commands with idempotent processing, single-supervisor ownership with a heartbeat, and read-only status in JSON and Arabic. Preserve the M1 imported core and its protected tests unless a separate Lead card explicitly defines an authorized change. The Supervisor owns domain writes and side effects; CLI writers are limited to append-only commands and answers.

## Order of work

1. Resolve the open M1 findings and prepare the M2 specification with stable `CHK-M2-*` criteria, card scopes, dependencies, evidence and verification layers.
2. Define and review the storage and migration contracts, including schema/version compatibility, transaction boundaries, constraints and error behavior. Write protected contract tests before assigning implementation.
3. After the store contract is frozen, assign disjoint command-protocol and ownership-lease cards in separate worktrees. Protect the no-duplicate-effect and single-owner invariants with negative and property tests; define failure and stale-takeover behavior before implementation.
4. Integrate status and end-to-end checks after the preceding interfaces are stable. Verify fresh and upgrade migrations, SQLite foreign keys, WAL and busy timeout, duplicate commands, competing supervisors, stale recovery and restart behavior.
5. Run the required tests, property and mutation checks, review every card and evidence record, and prepare Designer acceptance. Keep the milestone open until all required checks, acceptance and permitted independent review are established.

## Non-negotiable checks

- A duplicate command cannot produce a duplicate effect; conflict behavior for a reused identifier with different content must be explicit and tested.
- A second live supervisor cannot gain ownership; stale takeover requires evidence and an explicit protocol. An OS lock and a heartbeat lease must not be confused with SQLite WAL.
- Migration failure must not leave a partially applied version; a supported upgrade must preserve data. Verify the actual transaction strategy for each migration.
- The status command distinguishes stale or unknown ownership and pending commands; it does not write domain state.
- Core mutation and property tests follow `docs/verification-policy.md`; CI matrix, fresh-clone replay, evidence, and Designer acceptance remain required. Local-only work cannot establish remote CI.

## Temporary operating arrangement

Codex is temporarily Lead and Reviewer by Designer direction. Builders remain the named OpenCode models; tests and final review must identify their actual authors and avoid implying an independent Claude check. Work stays local on branches separate from `main`; no GitHub upload is authorized. Claude reviews the work after returning. Never send secrets or client-confidential material to free models.
