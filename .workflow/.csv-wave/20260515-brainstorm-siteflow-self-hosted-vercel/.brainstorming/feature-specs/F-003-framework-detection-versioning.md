# F-003 Framework Detection and Versioning

## Summary

Framework Detection and Versioning chooses a deterministic build profile and records immutable deployment lineage. Detection reduces setup work, while versioning makes every deployment explainable by commit, branch, framework preset, package manager, commands, output directory, builder image, detector version, and artifact checksum.

## User Value

Project owners get sensible defaults on import without surprise changes. Developers and release managers can identify exactly what was built, how it was built, and whether a rollback candidate matches the expected source and artifact.

## Requirements

- MUST inspect package manifests, lockfiles, framework config files, and known output conventions.
- MUST prefer explicit project configuration over inferred defaults.
- MUST persist resolved build profile once a build starts.
- MUST record commit SHA, branch, tag, framework preset, package manager, install command, build command, output directory, builder image version, detector version, project config revision, and artifact checksum.
- MUST NOT silently switch framework presets without audit and deployment metadata.
- SHOULD maintain monotonically increasing deployment sequence per project.

## Data/State

Use `framework_detection_runs` for evidence, confidence, selected preset, selected package manager, selected commands, output directory, detector version, and ambiguity reason. Store queryable selected values directly on `deployments`. Project-level deployment sequences and channel sequences SHOULD be transactionally allocated, not inferred only from timestamps.

## Operations

Detection runs after source checkout and before container build. Multiple lockfiles or conflicting framework signals require explicit configuration unless a stable project override exists. Unsupported frameworks fail as configuration issues, not opaque worker failures.

## Acceptance Criteria

- First setup proposes a preset and output directory when confidence is high.
- Ambiguous detection requires explicit selection before automatic deployment.
- Every deployment shows human-readable sequence plus immutable source and artifact identifiers.
- Preset changes appear in audit and deployment history.
- The worker uses the captured profile even if project settings change mid-build.

## Open Questions

- Which framework presets are mandatory for first release?
- Is monorepo path detection in MVP or P1?
- Should generic static output mode be the fallback for unsupported frameworks?

