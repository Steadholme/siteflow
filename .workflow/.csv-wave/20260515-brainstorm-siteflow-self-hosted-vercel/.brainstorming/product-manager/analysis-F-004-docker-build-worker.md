# F-004 Product Management: Docker Build Worker

## Product Intent

The build worker is where SiteFlow earns trust from both developers and operators. It MUST be isolated enough for self-hosted safety, transparent enough for debugging, and deterministic enough that artifacts can be promoted or rolled back with confidence.

## P0 Scope

- Atomic job claim and lifecycle states: queued, running, succeeded, failed, canceled, timed-out.
- Disposable Docker containers with CPU, memory, timeout, environment, and workspace cleanup.
- Redacted build logs with phase markers for clone, install, build, output validation, and publish.
- Output directory validation before artifact creation.
- Worker-visible and API-visible failure reasons.
- Configurable builder image version recorded in deployment metadata.

## P1 Scope

- Dependency cache controls with clear invalidation.
- Remote cache adapter.
- Worker pool health view.
- Per-project resource policy overrides.
- Cancel/retry from UI or API.

## Acceptance Criteria

- A queued job MUST be claimed by only one worker.
- A timed-out job MUST stop its container and expose timeout classification.
- A missing output directory MUST fail before artifact publishing.
- Logs MUST redact configured secret patterns.
- A successful build MUST produce artifact metadata for F-005 and deployment metadata for F-003.
- Developers SHOULD be able to diagnose common build failures without SSH access to the worker host.

## Product Risks

Build workers can pull SiteFlow toward generic CI. Product scope MUST keep workers deployment-oriented: one repository revision, one framework preset or custom static build command, one output artifact. Matrix builds, arbitrary job graphs, and long-running services SHOULD NOT be accepted in MVP.

Cache support is valuable but risky. MVP MAY omit dependency cache if it threatens reproducibility or secret isolation. If included, cache state MUST be explainable and clearable by an operator.

## Dependencies

F-004 consumes deployment intent from F-002 and build settings from F-003. It produces artifacts for F-005, preview candidates for F-007, and release candidates for F-008.
