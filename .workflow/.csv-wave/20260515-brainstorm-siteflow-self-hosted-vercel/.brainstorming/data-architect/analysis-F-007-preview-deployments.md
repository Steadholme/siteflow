# F-007 Preview Deployments - Data Architecture

## Preview Entity

A `preview_deployment` MUST link project, source event, branch or pull request, commit SHA, build job, deployment, artifact, preview URL, status, retention policy, and timestamps. Preview records SHOULD be separate from release channels because their lifecycle and retention behavior are different.

Preview routes MUST point to deployments, not directly to artifacts. This preserves build logs, Git metadata, framework metadata, and artifact verification state.

## URL Identity and Collision Avoidance

Preview URL generation SHOULD use a stable project slug plus branch slug, pull request number, or short commit SHA. SiteFlow MUST reserve generated preview URL keys with a uniqueness constraint before publishing routes.

Branch names MUST be normalized into safe slugs. If two branch names collide after normalization, SiteFlow SHOULD append a deterministic suffix derived from commit SHA or source event ID.

## Update Semantics

Pull request previews SHOULD update the active PR preview pointer when new commits arrive, while previous commit previews remain available until retention removes them. This can be modeled with:

- immutable `deployments` per commit
- `preview_deployments` per deployment
- optional `preview_aliases` where `project + pr_number` points to latest preview deployment

The latest alias MUST NOT destroy older preview deployment rows.

## Review Metadata

Preview records SHOULD store review-friendly metadata: PR title, PR number, source branch, base branch, author, commit message summary, provider URL, and Git provider status callback result when configured. Provider data SHOULD be normalized and bounded; raw payload storage MAY be retained separately with redaction.

## Retention

Preview retention SHOULD be configurable by age, count per branch, count per PR, and project-level storage budget. Active PR aliases SHOULD protect their current deployment. Closed PR previews MAY enter `retention_pending` after a grace period.

Retention MUST check whether a preview deployment has been promoted. A promoted preview's artifact MUST be protected by the release channel and rollback rules.

## Indexing

Indexes SHOULD include:

- `preview_deployments(project_id, preview_url_key)` unique
- `preview_deployments(project_id, branch_slug, created_at)`
- `preview_deployments(project_id, pr_number, created_at)`
- `preview_deployments(project_id, commit_sha)`
- `preview_deployments(retention_state, retention_after)`

## Auditability

Preview creation, preview URL changes, Git status callback attempts, manual preview deletion, retention deletion, and promotion from preview MUST emit audit or operational events with source event and deployment references.
