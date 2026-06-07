# F-003 Framework Detection and Versioning - Data Architecture

## Detection Records

Framework detection SHOULD be persisted as a first-class record, not just a build log line. A `framework_detection_run` SHOULD include project ID, build job ID, inspected commit SHA, detected framework preset, package manager, confidence, evidence files, selected build command, selected output directory, detector version, and ambiguity reason when applicable.

Explicit project configuration MUST override inferred defaults. The deployment record MUST still capture both the configured override and the detector evidence so future operators can explain why a build used a specific preset.

## Versioned Deployment Metadata

Each deployment MUST record:

- project ID
- deployment sequence number
- release channel sequence number when promoted
- commit SHA, branch, tag if present
- framework preset and detector version
- package manager and lockfile hash when available
- build command and output directory
- builder image version
- artifact checksum and manifest schema version
- source event ID and build job ID

SiteFlow MUST NOT silently change framework preset for an existing project. A change from one preset to another SHOULD create a project setting audit event and a deployment metadata record showing old value, new value, actor, and reason.

## Sequence Numbers

Deployment sequence numbers SHOULD be monotonically increasing per project. Release channel sequence numbers SHOULD be monotonically increasing per project plus channel. Human-readable versions MAY use these sequences, for example `project-42-deploy-103` and `production-17`.

Sequences SHOULD be database-generated or transactionally allocated. SiteFlow MUST NOT rely on wall-clock timestamps as the only ordering mechanism for deployment lineage.

## Ambiguity Handling

Ambiguous detection MUST result in a clear state such as `requires_configuration` or `failed_detection`. The system SHOULD avoid creating a routable deployment from an ambiguous framework unless a previous explicit project configuration exists.

The detector MAY preserve ranked candidates in JSON, but the selected preset and selected output directory MUST be queryable columns.

## Indexing

Indexes SHOULD support:

- deployments by project plus sequence
- deployments by project plus commit SHA
- detection runs by project plus framework preset
- deployments by builder image version for incident analysis
- deployments by artifact checksum for dedupe and verification

## Retention

Detection records SHOULD follow deployment retention, but selected metadata MUST remain on deployment rows even if verbose detector evidence is compacted later.
