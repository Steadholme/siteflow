# F-007 Preview Deployments

## Architectural Scope

Preview deployments SHOULD be modeled as routable deployments that are not bound to production or staging release channels. They MUST link project, source event, branch or pull request, commit SHA, build job, artifact, and preview URL.

Preview support MAY be P1, but its routing keys and deployment metadata SHOULD be considered during P0 design.

## URL Strategy

SiteFlow SHOULD support predictable preview URLs. A safe default is:

`https://{project-slug}--{branch-or-pr-slug}--{short-sha}.{preview-domain}`

The slug algorithm MUST prevent collisions across projects, branches, pull requests, and commits. If wildcard DNS is unavailable, SiteFlow MAY support path-based previews under a configured host.

## Lifecycle

Pull request preview deployments SHOULD update the "current" PR preview pointer when new commits arrive while preserving older commit-specific previews until retention removes them. Branch previews SHOULD follow branch head, and commit previews SHOULD remain immutable.

Preview expiration MUST NOT delete an artifact if that artifact is referenced by an active release channel, rollback target, or retention hold.

## Git Provider Feedback

When credentials are configured, SiteFlow MAY post build and preview statuses back to the Git provider. Callback failures MUST be retryable and MUST NOT mark the deployment failed after artifact and routing succeed.

## Safety

Preview deployments MUST NOT alter production or staging release channels unless explicitly promoted. Promotion from preview MUST verify that the artifact is still present, checksum-verified, and eligible for the target channel policy.

Preview routes SHOULD support optional access controls for private projects, but access control SHOULD NOT be required for public static preview MVP if network placement already protects the system.
