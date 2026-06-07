# F-001 Project Management - Data Architecture

## Entity Boundaries

Project management MUST define the root aggregate for SiteFlow. A `project` owns configuration defaults and policies, but it SHOULD NOT own immutable deployment facts after those facts are created. Historical deployments MUST keep a snapshot of build and source metadata instead of reading mutable project settings.

Key entities:

- `projects`: ID, slug, display name, status, default branch, default framework preset, default output directory, retention policy, and created/updated timestamps.
- `repository_bindings`: project ID, provider, provider repository ID, clone URL, default branch, credential reference, webhook secret reference, and webhook status.
- `project_environment_variables`: project ID, environment or channel scope, key, secret reference or encrypted value pointer, and last rotated timestamp.
- `domain_bindings`: project ID, hostname, routing mode, verification status, certificate reference, and conflict status.
- `deployment_policies`: auto-build branches, preview enabled flag, production branch, staging branch, retention defaults, and approval mode if added later.

## Consistency Requirements

Project slug and active domain names MUST be unique before activation. Repository bindings SHOULD be unique by provider plus repository external ID unless the operator explicitly allows multiple projects to deploy from one repository.

Project deletion SHOULD be soft deletion first. A deleted project MUST stop webhook enqueueing and routing generation, but deployment lineage and audit history SHOULD remain available until retention policies remove unprotected artifacts.

Environment variable read APIs MUST NOT expose secret values. Deployment records SHOULD store only secret reference IDs or redacted configuration fingerprints.

## Audit and Lineage

Project creation, repository binding changes, domain changes, environment variable changes, framework override changes, retention policy updates, pause/resume, and deletion MUST emit audit events.

When mutable settings affect builds, SiteFlow SHOULD snapshot the relevant settings into the build job and deployment metadata. This preserves why a historical deployment used a specific output directory, framework preset, build command, or builder image.

## Indexing and Query Patterns

The MVP SHOULD support fast queries for:

- projects by slug
- projects by repository binding
- projects with active domain binding
- recent deployments per project
- paused or deleted projects
- audit timeline per project

Indexes MUST support uniqueness for slugs and active domains. If domain reuse after deletion is allowed, uniqueness SHOULD be partial on active records only.

## Data Retention

Project-level retention policy SHOULD define separate defaults for production deployments, staging deployments, previews, failed builds, and logs. Retention MUST be evaluated against actual references: active release channels and protected rollback targets override project deletion and preview cleanup.
