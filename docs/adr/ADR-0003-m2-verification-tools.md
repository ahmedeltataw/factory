# ADR-0003: M2 verification tools

Status: proposed for local review · Date: 2026-11-08 · Author: temporary Lead

The M2 verification policy already requires property tests with fast-check and mutation tests with StrykerJS using its Vitest runner. Add exact development dependency versions `fast-check` 4.10.2, `@stryker-mutator/core` 10.1.1 and `@stryker-mutator/vitest-runner` 10.1.1, with a frozen lockfile. These are test tools, not runtime dependencies. Registry metadata reports Node >=22 for Stryker and the Vitest runner accepts Vitest >=2, compatible with the project's Node 24/26 and Vitest 4 targets. Verify rather than assume each target runs.

Add a focused store property suite and a bounded Stryker configuration for `supervisor/src/app/store.ts`. Mutation and property results are evidence, not a replacement for contract tests or review. The Ubuntu mutation job remains required by the verification policy; local Windows execution is supplemental. Do not disable lifecycle protections or relax the existing 80% minimum. Do not publish or modify `main`.

This extends the M1-only dependency and configuration assertions; update them to reflect the new exact versions instead of deleting them. The record is provisional until reviewed and all required checks pass.
