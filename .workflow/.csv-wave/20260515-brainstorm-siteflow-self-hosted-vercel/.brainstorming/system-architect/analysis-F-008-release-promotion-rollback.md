# F-008 Release Promotion and Rollback

## Architectural Scope

Release promotion and rollback MUST be implemented as transactional movement of release-channel pointers between immutable deployments. They MUST NOT rebuild source code or mutate artifacts.

The release service SHOULD own channel locks, eligibility checks, audit records, route outbox creation, and operation status.

## Promotion Requirements

Promotion MUST require:

- Deployment status is successful or artifact-ready.
- Artifact manifest exists and checksum verification passed.
- Target project and channel are enabled.
- Domain and route validation passes for the target channel.
- Operator or automation identity is recorded.

Optional branch policy, approval gates, and Git provider checks MAY be added after the MVP.

## Transaction Model

The database transaction SHOULD lock the release channel row, validate the target deployment, update `active_deployment_id` and `previous_deployment_id`, write an audit record, and create a routing outbox record with a new `route_revision`.

The routing applier SHOULD process the outbox after commit. If route apply fails, the release operation MUST expose failed materialization while retaining enough state to retry or explicitly revert the channel pointer.

## Rollback

Rollback MUST select a previous successful deployment with a retained artifact. The UI/API SHOULD present deployment lineage, previous active deployment, operator, timestamp, source commit, artifact checksum, and reason.

Rollback MUST NOT require the original Git repository or build dependencies to be available. This is the main reason artifact retention MUST protect active and recent release-channel deployments.

## Failure Modes

Concurrent promotion attempts MUST serialize per project/channel. If Nginx reload fails after the channel pointer changed, operators SHOULD be able to retry route apply or perform a compensating rollback to the previous active deployment. All attempts MUST be audited.
