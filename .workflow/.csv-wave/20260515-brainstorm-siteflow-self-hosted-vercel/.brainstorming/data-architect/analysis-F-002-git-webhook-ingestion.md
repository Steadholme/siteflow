# F-002 Git Webhook Ingestion - Data Architecture

## Normalized Event Model

Webhook ingestion MUST persist a normalized `source_event` before creating build jobs. The normalized event SHOULD include provider, provider event ID, repository external ID, project ID, event type, branch, commit SHA, commit message summary, author identity, tag, pull request number, base branch, head branch, delivery timestamp, and verification status.

Provider payloads MAY be stored for debugging, but sensitive headers, tokens, and oversized payload fragments MUST be excluded or redacted. Product behavior MUST use normalized fields, not raw provider JSON.

## Idempotency

The ingestion layer MUST deduplicate repeated deliveries by provider event ID where available. If no stable provider event ID exists, SiteFlow MUST derive an event fingerprint from provider, repository, event type, branch or PR number, commit SHA, and action.

A unique index on `source_events(project_id, event_fingerprint)` SHOULD enforce dedupe. Replayed events SHOULD return the existing event and avoid enqueueing duplicate build jobs unless the operator explicitly requests a rebuild.

## Build Intent Creation

Ingestion SHOULD create a build intent only after signature verification, repository binding resolution, event normalization, and policy evaluation. Pushes to production or staging branches SHOULD create release-candidate build jobs. Pull request events SHOULD create preview build jobs when previews are enabled.

`source_events` and initial `build_jobs` SHOULD be inserted in one database transaction. This guarantees a stored accepted event has either an associated job or a clear skip reason.

## Error and Rejection Records

Rejected unsigned, unauthorized, malformed, or unsupported events SHOULD be recorded in a bounded `webhook_rejections` table with safe metadata: provider, project or repository if resolvable, reason code, request ID, timestamp, and hash of delivery body. Rejection records MUST NOT store secrets.

## Indexing

Required indexes SHOULD include:

- `source_events(project_id, event_fingerprint)` unique
- `source_events(project_id, commit_sha)`
- `source_events(project_id, branch, created_at)`
- `source_events(project_id, pr_number, created_at)` where PR metadata exists
- `webhook_rejections(project_id, created_at, reason_code)`

## Auditability

Accepted events SHOULD produce audit events with actor type `provider`. A skipped event SHOULD still be traceable with a skip reason such as branch policy mismatch, previews disabled, unsupported event type, or duplicate delivery.
