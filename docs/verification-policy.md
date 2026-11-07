# Verification policy

Status: proposed (Step 0) · Source: manual `12-build-steps-and-verification.md`.

## 1. Layers

| Layer | Meaning | Required for |
|---|---|---|
| L1 | Automated tests from the card, green on CI `{windows-latest, ubuntu-latest} × {Node 24, 26}` from a fresh clone with frozen lockfile | every implementation card |
| L2 | Negative tests: break it on purpose, assert the documented safe result | stateful, concurrent, destructive or security cards |
| L3 | Review by a Reviewer of a different model family than the Builder (or a different model for Codex-built cards, labelled `same-family-review`), given diff + evidence, never the Builder's reasoning | risk `high` cards, every milestone |
| L4 | Evidence record (§3) validated by `scripts/check-evidence` | every card |
| L5 | Designer acceptance script, ≤10 commands, Arabic notes on expected output | milestone end |
| MUT | StrykerJS (Vitest runner) on listed core modules, Ubuntu job, time-boxed; minimum mutation score **80%** on those modules, or a recorded exception approved by the Lead | M2+ core cards |
| PROP | fast-check properties for invariants named in the card | M2+ core cards |

A card lists which layers apply. Skipping a layer that the table requires needs a written reason in the card.

## 2. Check IDs and traceability

- Every DoD line in a card has a check ID: `CHK-<card>-<letter>`, e.g. `CHK-M1-02-a`.
- Each check ID maps to a test name, a script, or a command with an expected result.
- `scripts/check-traceability` fails if any DoD line has no check ID or any check ID has no passing result in the evidence record.

## 3. Evidence record

Path: `.factory/evidence/<card-id>/<attempt>.json`.

```json
{
  "schema_version": 1,
  "card": "M1-02",
  "attempt": 1,
  "role": "builder",
  "provider": "opencode", "model": "<model id>", "cli_version": "<x.y.z>",
  "base_sha": "<sha>", "head_sha": "<sha>",
  "changed_paths": ["..."],
  "checks": [
    { "id": "CHK-M1-02-a", "command": "pnpm test -- tests/protected/core-engine.spec.ts",
      "exit_code": 0, "result": "pass", "output_sha256": "<sha256 of captured output>" }
  ],
  "layers": { "L1": "pass", "L2": "n/a", "L3": "pending", "L4": "pass" },
  "labels": [],
  "started_at": "<UTC>", "ended_at": "<UTC>"
}
```

`result` is one of `pass | fail | not-run`. `not-run` never counts as pass. Captured outputs are stored next to the record as `<attempt>.<check>.log`.

## 4. Protected tests

- `tests/protected/**` is written or imported by the Lead before the Builder starts. In M1 they are dsh tests copied with only the documented one-line import rewrite; after reverting that line and normalizing to LF they must match `blob_sha256` in `SOURCE_MANIFEST.json`.
- A Builder diff touching `tests/protected/**`, `schemas/**`, `docs/**` or `.factory/**` fails the scope check.

## 5. Merge rule

A card merges only when L1 + L4 pass, every required layer passes, the scope check passes, and the Reviewer verdict is `approve`. Never merge unreviewed: if every Reviewer model is limited, the card waits (`WAITING_FOR_REVIEWER`).

## 6. Milestone close

All cards merged; Designer passes L5; **replay**: a fresh clone of `main` passes the full check suite on both OSes and both Node lines.
