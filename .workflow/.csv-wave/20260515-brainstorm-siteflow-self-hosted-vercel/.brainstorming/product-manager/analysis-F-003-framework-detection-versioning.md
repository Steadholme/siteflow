# F-003 Product Management: Framework Detection and Versioning

## Product Intent

Framework detection reduces setup friction, while versioning creates deployment trust. SiteFlow SHOULD feel smart on first import, but explicit configuration MUST win whenever inference is uncertain.

## P0 Scope

- Detect initial framework and package manager from manifest files, lockfiles, and known config files.
- Support manual override for framework preset, build command, install command, and output directory.
- Record commit SHA, branch, tag, framework preset, package manager, build command, output directory, builder image version, artifact checksum, and deployment sequence.
- Surface detection confidence and ambiguity to the project owner.
- Prevent silent preset changes by recording every change in deployment metadata.

## P1 Scope

- More framework presets and monorepo path support.
- Suggested fixes for missing output directories or unsupported modes.
- Detection regression tests for common repository fixtures.
- Project-level version labels or release notes derived from Git metadata.

## Acceptance Criteria

- On first project setup, SiteFlow SHOULD propose a detected preset and output directory before the first build.
- If multiple presets match, SiteFlow MUST ask for explicit selection or require configuration before automatic deployment.
- Every deployment MUST show human-readable sequence plus immutable source and artifact identifiers.
- Changing a framework preset MUST be visible in audit and deployment history.
- Unsupported frameworks MUST fail as configuration issues, not as unexplained worker errors.

## Product Risks

Overpromising framework support creates churn. The MVP SHOULD support a small, documented preset list and a generic static output mode. Product messaging MUST distinguish "detected and supported" from "custom command accepted." Automatic version control must be framed as deployment lineage, not replacement for Git tags or release management.

## Dependencies

F-003 depends on repository source from F-002 and project settings from F-001. It supplies build commands to F-004, artifact provenance to F-005, user-visible version labels to F-007, and rollback candidate clarity to F-008.
