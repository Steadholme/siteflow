# F-001 Project Management

## Architectural Scope

Project Management SHOULD own the canonical `Project` aggregate and all settings that influence deployability: repository binding, framework settings, domain bindings, environment variable references, preview policy, release policy, and retention policy.

The Project API MUST be the only write path for project configuration. Build workers, routing appliers, and webhook handlers MUST consume project snapshots or read models instead of mutating project settings directly.

## Required Capabilities

- Project creation MUST validate `slug`, display name, repository binding shape, default branch, and initial deployment policy.
- Domain activation MUST enforce global uniqueness across active projects and release channels.
- Project deletion SHOULD be soft-delete first. Hard deletion MUST be blocked while active release channels, retained artifacts, or active preview URLs reference the project.
- Pause or disable state MUST prevent new webhook-triggered builds while preserving existing routes unless the operator explicitly disables routing.
- Read APIs MUST return secret metadata only, such as name, scope, and last updated time. They MUST NOT return secret values.

## Implementation Pattern

Use a project aggregate table plus child tables for domains, secret references, repository binding, and optional branch policy. Domain rows SHOULD have unique active constraints such as `normalized_hostname` where `deleted_at is null`.

Project updates SHOULD create audit records with old and new safe values. Secret value changes SHOULD record only metadata such as secret key name and version reference.

## Integration Contracts

Webhook ingestion MUST look up projects by repository binding and provider metadata. Routing MUST read active domains and release channel pointers. Build workers MUST read a resolved project build profile, not loosely reassemble settings from multiple endpoints.

## Failure Modes

If a project update would invalidate active routing, the API MUST reject it or place the project in a pending validation state. If domain validation passes but Nginx reload later fails, the project state SHOULD preserve the old active route and expose the failed route operation.
