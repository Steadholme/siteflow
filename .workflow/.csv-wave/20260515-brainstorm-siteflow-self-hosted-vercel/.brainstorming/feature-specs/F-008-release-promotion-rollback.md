# F-008 Release Promotion and Rollback

## Summary

Release Promotion and Rollback moves release-channel pointers between immutable deployments. It is P0 because it converts verified artifacts into controlled production or staging releases and enables incident recovery without rebuilding source.

## User Value

Release managers can promote known-good deployments and roll back quickly with audit context. Operators can see exactly which commit, artifact checksum, actor, reason, and routing revision are active.

## Requirements

- MUST promote only successful deployments with verified artifacts.
- MUST keep each enabled release channel pointing to exactly one active deployment.
- MUST support production and staging channels.
- MUST perform channel pointer update, channel event insertion, routing revision creation, and audit logging transactionally.
- MUST NOT rebuild source during rollback.
- SHOULD require a reason for production rollback.
- MAY add approval gates, branch policy checks, or scheduled windows after MVP.

## Data/State

`release_channels` stores project, channel name, active deployment, status, current sequence, actor, and update time. `channel_events` is append-only with previous deployment, next deployment, event type, reason, request ID, routing revision, status, and timestamp. Release channels point to deployments, never directly to storage objects.

## Operations

Promotion locks the channel row, validates deployment eligibility, protects artifact retention, updates pointer and sequence, writes channel and audit events, and creates a pending routing revision. Routing and CDN side effects run after commit through an outbox-style worker. Rollback selects a previous successful deployment with retained verified artifact.

## Acceptance Criteria

- Failed, unverified, expired, or deleted-artifact deployments are not promotable.
- Rollback does not create a build job.
- Successful channel operation leaves one active deployment pointer.
- Routing failure is explicit, preserves previous known-good route config, and supports retry or compensating rollback.
- Release history shows commit SHA, artifact checksum, actor, timestamp, reason, previous target, next target, and route result.

## Open Questions

- Should production promotion require approval in MVP or remain manual operator action?
- Should route apply failure leave the new channel pointer pending, active-with-attention, or automatically revert?
- Are canary or percentage rollouts explicitly out of scope for first release?

