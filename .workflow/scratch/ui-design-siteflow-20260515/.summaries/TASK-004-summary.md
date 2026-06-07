# TASK-004 Summary

Status: completed

Implemented release promotion and rollback consoles under `src/features/release/**`.

## Changes

- Replaced `releaseRoutes.tsx` placeholder route elements with `ReleaseConsolePage` and `RollbackConsolePage`.
- Added promote workflow with candidate deployment, current channel state, artifact delta, safety checks, route preview, audit reason, actor, idempotency key, and guarded submit state.
- Added rollback workflow with known-good target table, ineligible target disabling, rollback impact, artifact protection, rebuild-not-required copy, route preview, rollback reason, and guarded submit state.
- Added feature-scoped CSS for release grids, sticky command actions, route preview, alert states, forms, and comparison panels.
- Added release tests covering route exports, promotion safety gates, stale candidates, command boundary copy, route apply failure, rollback target disabling, and successful rollback command submission.

## Verification

- `npm test -- --run src/features/release/release.test.tsx` passed: 7 tests.
- `npm run build` passed: TypeScript checks and Vite production build.

## Findings

- `FixtureSiteFlowClient` redaction can replace repeated read-model object references with the redaction placeholder. The release feature normalizes `safetyChecks` locally with route-preview/target fallbacks before evaluating destructive action gates.
