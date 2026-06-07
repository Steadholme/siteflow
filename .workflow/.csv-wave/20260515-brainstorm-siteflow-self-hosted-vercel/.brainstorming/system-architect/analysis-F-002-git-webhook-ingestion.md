# F-002 Git Webhook Ingestion

## Architectural Scope

Webhook ingestion MUST be a narrow trust boundary. It receives raw provider requests, verifies signatures, normalizes events, deduplicates delivery, and enqueues build jobs. It SHOULD NOT run framework detection, clone repositories, or mutate release channels directly.

## Endpoint Design

Each provider adapter MUST verify signatures against the raw request body before parsing or accepting the event. Supported adapters SHOULD include a generic interface:

- `verify(request, secret_ref)`
- `extract_event_id(request, payload)`
- `normalize(payload)`
- `should_enqueue(normalized_event, project_policy)`

The normalized event MUST include provider, repository ID or URL, branch, commit SHA, event type, actor, pull request metadata when present, and provider event ID or deterministic fingerprint.

## Idempotency and Queueing

The ingestion layer MUST write a `WebhookEvent` or source event record with a unique idempotency key before enqueueing a build job. Duplicate deliveries MUST return a safe success response when the original event was accepted.

Queue messages SHOULD contain only stable IDs, not full webhook payloads or secrets. The worker SHOULD resolve current project settings from the database when it starts, while the deployment record MUST preserve the resolved configuration used.

## Security

Unsigned, malformed, or unauthorized requests MUST be rejected with generic messages. Raw payload storage SHOULD be optional and retention-limited. If stored, raw payloads MUST be treated as sensitive because commit messages or PR metadata may contain secrets.

## Failure Modes

Provider outage or callback failure MUST NOT corrupt deployment state. If normalization succeeds but enqueue fails, the event SHOULD be marked `verified_normalized_enqueue_failed` and retried by a background reconciler. If enqueue succeeds but the HTTP response fails, idempotency MUST prevent duplicate builds on provider retry.
