# F-003 Framework Detection and Versioning

## Architectural Scope

Framework detection SHOULD be implemented as a deterministic detector service used by the build worker after source checkout. The detector MUST produce a resolved build profile that is persisted on the deployment record.

Explicit project configuration MUST take precedence over inferred settings. Inference SHOULD be used to reduce setup effort, not to surprise operators.

## Detection Inputs

The detector SHOULD inspect:

- `package.json`, lockfiles, and package manager metadata.
- Framework config files such as `next.config.*`, `vite.config.*`, `astro.config.*`, `nuxt.config.*`, and Hugo config.
- Static output conventions such as `dist`, `build`, `out`, or `public`.
- Project-level overrides for install command, build command, output directory, and framework preset.

Ambiguous results MUST produce a clear actionable error or require manual override. The system MUST NOT silently switch framework presets for an existing project without recording the change in deployment metadata.

## Versioning Model

Each deployment MUST persist commit SHA, branch, tag, framework preset, package manager, install command, build command, output directory, worker image version, detector version, artifact checksum, and project config revision.

The system SHOULD maintain project-level monotonically increasing deployment sequence numbers. Release-channel sequence numbers MAY be separate so operators can distinguish "deployment 42" from "production release 17".

## Reproducibility

The resolved build profile MUST be immutable once the build starts. If project settings change during a build, the active job SHOULD continue with its captured profile, and later jobs SHOULD use the new project config revision.

Package manager detection SHOULD prefer lockfiles. If multiple lockfiles exist, the detector MUST either follow explicit project configuration or fail with an ambiguity error.

## Integration Points

The resolved profile feeds Docker worker execution, artifact validation, deployment metadata, and UI/API presentation. Artifact manifests SHOULD include detector version and resolved output directory for auditability.
