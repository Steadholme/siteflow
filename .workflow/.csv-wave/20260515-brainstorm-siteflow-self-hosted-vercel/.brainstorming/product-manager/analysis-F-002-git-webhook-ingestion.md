# F-002 Product Management: Git Webhook Ingestion

## Product Intent

Webhook ingestion turns repository activity into deployment intent. The product value is low-friction automation with high trust: SiteFlow should react quickly to pushes and pull requests, but MUST reject unauthorized or duplicate events.

## P0 Scope

- Verify provider signatures with per-project webhook secrets.
- Normalize push, tag, and pull request events into a common deployment intent model.
- Deduplicate repeated deliveries by provider event ID or deterministic fingerprint.
- Enqueue builds for configured staging or production branches.
- Store enough source metadata for user-facing diagnostics: branch, commit SHA, author, event type, provider event ID, and received timestamp.
- Provide a webhook test endpoint or setup verification flow.

## P1 Scope

- Git provider status callbacks for queued, building, succeeded, and failed states.
- Additional provider adapters.
- Branch policy rules beyond default production/staging branch matching.
- Manual replay for authorized failed ingestion events.

## Acceptance Criteria

- A valid signed push to a configured branch MUST enqueue exactly one build job even if the provider retries delivery.
- An invalid signature MUST be rejected and MUST NOT expose secret material in the response or logs.
- A malformed payload MUST produce a safe, actionable error classification.
- The project page SHOULD show recent webhook events and whether each created, skipped, or deduplicated a build intent.
- Pull request events SHOULD enqueue previews only when F-007 preview policy is enabled.

## Product Risks

The ingestion layer can become a support burden if events disappear into the queue. The MVP MUST expose event disposition: accepted, rejected, ignored by policy, deduplicated, or enqueued. This is a product requirement, not just an operational metric, because developers will compare SiteFlow behavior against managed platforms where Git feedback is expected.

## Dependencies

F-002 depends on F-001 repository binding and project policy. It creates inputs for F-004 builds and F-007 previews. Its normalized event model MUST be stable enough for F-003 versioning and F-008 release audit.
