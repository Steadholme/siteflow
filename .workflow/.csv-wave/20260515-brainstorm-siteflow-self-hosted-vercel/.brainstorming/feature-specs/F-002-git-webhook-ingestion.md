# F-002 Git Webhook Ingestion

## Summary

Git Webhook Ingestion receives provider requests, verifies signatures, normalizes events, deduplicates deliveries, records disposition, and enqueues deployment-oriented build jobs. It is a narrow trust boundary and MUST NOT run builds, detect frameworks, or mutate release channels directly.

## User Value

Developers get automatic deployments from pushes and pull requests without losing trust in security or idempotency. Operators can diagnose why an event was accepted, rejected, ignored by policy, deduplicated, or enqueued.

## Requirements

- MUST verify provider signatures against the raw request body with per-project webhook secrets.
- MUST normalize events into provider, repository, branch, commit SHA, actor, event type, tag, and PR metadata where available.
- MUST deduplicate by provider event ID or deterministic fingerprint.
- MUST enqueue release-candidate builds for configured production or staging branches.
- SHOULD enqueue preview builds for pull requests when previews are enabled.
- MUST reject unsigned, malformed, or unauthorized requests with safe error messages.
- SHOULD provide setup verification or webhook test flow.

## Data/State

Persist `source_events` before job creation. Use a unique key such as `source_events(project_id, event_fingerprint)`. Store bounded rejection records in `webhook_rejections` without secrets. Accepted events and initial `build_jobs` SHOULD be inserted in one transaction so stored events have a job, skip reason, or retryable enqueue failure.

## Operations

Provider adapters implement `verify`, `extract_event_id`, `normalize`, and `should_enqueue`. Queue messages contain stable IDs only. Duplicate accepted deliveries return safe success without creating duplicate jobs. Enqueue failures are marked retryable for reconciliation.

## Acceptance Criteria

- A valid signed push to a configured branch enqueues exactly one build even on provider retry.
- Invalid signatures and malformed payloads never leak secret material.
- Recent webhook events show accepted, rejected, ignored, deduped, or enqueued state.
- Pull request events enqueue previews only when preview policy is enabled.
- Queue messages do not contain raw secrets or full provider payloads.

## Open Questions

- Which provider is first: GitHub, GitLab, Gitea, or generic webhook-only?
- How long should raw or redacted provider payloads be retained?
- Should MVP include manual replay for failed accepted events?

