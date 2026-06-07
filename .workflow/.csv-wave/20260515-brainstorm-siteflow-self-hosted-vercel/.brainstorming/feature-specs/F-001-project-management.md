# F-001 Project Management

## Summary

Project Management is the SiteFlow control-plane entry point. It defines the project aggregate, repository binding, framework defaults, domains, environment variable references, deployment policy, preview policy, retention policy, status, and audit metadata. The feature is P0 because every webhook, build, artifact, route, preview, and release operation depends on stable project identity and policy.

## User Value

Platform operators can onboard a site without changing worker or routing internals. Project owners can see what repository is connected, what command will run, where traffic will route, and which settings changed. Support users can inspect current deployment state without exposing secrets.

## Requirements

- MUST create, update, list, search, pause, soft-delete, and inspect projects.
- MUST validate project slug and active domain uniqueness before activation.
- MUST store repository binding, default branch, framework preset or detection mode, build command, output directory, domains, secret references, and deployment policy.
- MUST hide secret values from read APIs, logs, deployment manifests, and UI.
- SHOULD expose deployment history summary and audit timeline per project.
- MAY add lightweight roles after the single-operator MVP is stable.

## Data/State

Core records: `projects`, `repository_bindings`, `domain_bindings`, `project_environment_variables`, `deployment_policies`, and `audit_events`. Mutable project settings MUST be snapshotted into build jobs and deployments when they affect reproducibility. Active domains need partial uniqueness on normalized hostname where records are not deleted.

## Operations

Project creation validates repository shape, domain intent, and initial deployment policy. Pause blocks new webhook-triggered builds while preserving existing routes unless routing is explicitly disabled. Deletion is soft by default and MUST be blocked while active release channels, retained artifacts, or preview URLs still reference the project.

## Acceptance Criteria

- Duplicate slugs and active domains are rejected with clear validation errors.
- A paused project does not enqueue webhook-triggered builds.
- Read APIs return secret metadata only, never values.
- Project settings changes create audit events with safe before/after summaries.
- Deletion does not remove active release artifacts or release history.

## Open Questions

- Should MVP ship API-only plus CLI, or API plus minimal operator console?
- Which role model, if any, is required before multiple teams share one installation?
- Should repository reuse across multiple projects be allowed by default?

