# F-007 Preview Deployments

## Summary

Preview Deployments provide branch, pull-request, and commit-specific URLs backed by immutable deployment artifacts. The feature is P1, but its route keys, retention model, and deployment lineage should be reserved in P0 to avoid later data model rework.

## User Value

Reviewers can inspect changes before release. Developers get predictable preview URLs and provider feedback. Project owners keep previews separate from production and staging channels.

## Requirements

- MUST link project, source event, branch or PR, commit SHA, build job, deployment, artifact, preview URL, status, and retention policy.
- MUST NOT replace production or staging traffic unless explicitly promoted.
- SHOULD generate predictable, collision-resistant preview URLs.
- SHOULD update the active PR preview pointer when new commits arrive.
- SHOULD retain prior commit previews until retention removes them.
- MAY post Git provider statuses when credentials are configured.
- SHOULD support project-level preview retention.

## Data/State

`preview_deployments` points to deployments, not directly to artifacts. Optional `preview_aliases` can map project plus PR number or branch slug to the latest preview deployment. URL keys require uniqueness constraints. Review metadata includes PR title, PR number, source branch, base branch, author, provider URL, and status callback result.

## Operations

Preview build follows normal webhook, worker, artifact, and routing flow with preview intent. URL reservation happens before external exposure. Closing a PR may move preview records to retention-pending after a grace period. Deletion removes routing references before artifact retention can delete bytes.

## Acceptance Criteria

- Preview URL never changes production or staging without promotion.
- Branch collisions after slug normalization receive deterministic suffixes.
- New PR commits update current preview while preserving recent commit previews by policy.
- Git callback failures are visible and retryable but do not invalidate successful previews.
- Promoted preview artifacts are protected by release-channel and rollback rules.

## Open Questions

- Are commit previews part of MVP, or is all preview UI deferred to P1?
- Should private preview access control be required for first release?
- What default preview retention balances reviewer value and storage cost?

