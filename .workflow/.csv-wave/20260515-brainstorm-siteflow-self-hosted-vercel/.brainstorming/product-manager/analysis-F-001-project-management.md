# F-001 Product Management: Project Management

## Product Intent

Project management is the control-plane entry point. It MUST make a project understandable before any build runs: repository binding, default branch, framework settings, domains, environment variables, deployment policy, and release channels.

For MVP, this feature SHOULD optimize for correctness and operator confidence over elaborate team administration. A project owner must be able to answer: what repository is connected, what command will run, where artifacts will route, and who changed the setting.

## P0 Scope

- Create, update, list, search, pause, and delete projects.
- Store slug, display name, repository binding, default branch, framework preset or detection mode, build command, output directory, domains, environment variable references, and deployment policy.
- Validate slug and domain uniqueness before activation.
- Hide secret values from read APIs, manifests, logs, and UI.
- Show deployment history summary per project.
- Record audit metadata for creation, settings changes, promotion, rollback, pause, and deletion.

## P1 Scope

- Lightweight roles for platform operator, project owner, and read-only support.
- Project templates for common framework presets.
- Import flow from existing repository metadata.
- Policy hints, such as "previews disabled because wildcard DNS is not configured."

## Acceptance Criteria

- A platform operator MUST be able to create a project with repository binding and domain settings without touching worker configuration.
- The system MUST reject duplicate slugs and duplicate active domain bindings with clear validation messages.
- Read APIs MUST never return secret values; they MAY return secret names, references, scopes, and last updated timestamps.
- A paused project MUST NOT enqueue new webhook-triggered builds unless manually overridden by an operator.
- Project deletion MUST NOT remove active release artifacts without retention and rollback safety checks from F-005 and F-008.

## Product Risks

Too much early RBAC can slow MVP. The first release SHOULD use a simple operator trust model, while preserving audit fields needed for future roles. The highest-risk product failure is a project that looks configured but cannot produce a routable deployment; setup validation MUST surface missing Git credentials, domain conflicts, unknown framework config, and missing artifact backend.

## Dependencies

F-001 feeds all other features. It MUST define stable project identity and policy fields before webhook events, build jobs, artifacts, routes, previews, or release channels depend on them.
