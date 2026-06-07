# F-008 Product Management: Release Promotion and Rollback

## Product Intent

Promotion and rollback are the clearest business value for self-hosted SiteFlow: release managers can move traffic between known immutable deployments without rebuilding source. This feature MUST be P0 because it converts build artifacts into controlled releases.

## P0 Scope

- Promote only successful deployments with verified artifacts.
- Maintain release channels where each channel points to exactly one active deployment.
- Support production and staging channels.
- Perform promotion and rollback transactionally across channel state, routing generation, and audit logging.
- Select rollback targets from previously successful deployments.
- Record previous active deployment, new deployment, operator, timestamp, reason, and routing result.

## P1 Scope

- Approval gates.
- Branch policy checks before promotion.
- Scheduled promotion windows.
- Release notes or changelog from Git metadata.
- Canary or percentage traffic is out of MVP unless routing architecture explicitly supports it safely.

## Acceptance Criteria

- A failed or unverified deployment MUST NOT be promotable.
- Rollback MUST NOT rebuild source code.
- A release channel MUST have one active deployment pointer after every successful operation.
- If routing update fails, channel state and audit outcome MUST make the failure explicit and MUST preserve the previous known-good route.
- Release history MUST show enough context for incident response: commit SHA, artifact checksum, actor, timestamp, reason, and previous channel target.

## Product Risks

Rollback that is fast but opaque will not earn operator trust. The product MUST show what changed and why, not only provide a button. Approval gates are attractive but should be P1 because the MVP risk is lower-level correctness: verified artifacts, atomic channel movement, and routing validation.

## Dependencies

F-008 depends on F-003 version metadata, F-005 artifact verification, and F-006 atomic routing. It also writes audit records tied to F-001 project management. This feature should be the final gate for MVP readiness.
