# F-005 Product Management: Artifact Storage Management

## Product Intent

Artifacts are the product's rollback and audit foundation. SiteFlow MUST treat each artifact as immutable, verifiable, and traceable to source, build settings, and deployment state.

## P0 Scope

- Publish immutable artifacts with checksum verification.
- Store metadata: project ID, deployment ID, commit SHA, checksum, size, file count, content type summary, storage location, and creation time.
- Write artifact manifest before a deployment becomes routable.
- Protect artifacts referenced by active release channels or rollback candidates.
- Provide local filesystem or S3-compatible backend as the first supported storage adapter.
- Expose retention policy defaults for active releases and recent previews.

## P1 Scope

- Both local and S3-compatible backends behind a stable adapter.
- Artifact browsing or manifest inspection in the operator console.
- Storage usage reporting by project.
- Manual retention exceptions for important releases.

## Acceptance Criteria

- A deployment MUST NOT become routable until its artifact manifest exists and checksum verification passes.
- Artifact deletion MUST be blocked when the artifact is active in production, staging, or protected rollback history.
- Operators SHOULD see storage location, size, checksum, and retention status for every deployment.
- Retention policy MUST distinguish production/staging artifacts from preview artifacts.
- Failed artifact publication MUST fail the deployment before routing or promotion.

## Product Risks

Artifact storage can become invisible until something breaks. The product MUST make artifact state visible in release and rollback screens because rollback confidence depends on artifact availability. If storage cost controls are too aggressive, SiteFlow may delete the exact artifact needed during an incident. Default retention SHOULD favor safety over storage savings.

## Dependencies

F-005 receives build output from F-004 and provenance from F-003. It gates F-006 routing, F-007 previews, and F-008 promotion/rollback. Its retention rules MUST coordinate with release channels and preview lifecycle.
