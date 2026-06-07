# F-007 Product Management: Preview Deployments

## Product Intent

Preview deployments are a major Vercel-like workflow benefit, but they SHOULD be P1 after the production deployment path is reliable. Their role is to shorten review cycles by giving every relevant branch, pull request, or commit a stable URL backed by an immutable artifact.

## P1 Scope

- Generate predictable preview URLs without collisions across projects and branches.
- Link previews to project, source event, branch or pull request, commit SHA, build job, artifact, and URL.
- Update pull request preview targets when new commits arrive.
- Keep prior commit previews accessible until retention removes them.
- Optionally post status callbacks to Git provider.
- Configure preview retention per project.

## MVP Relationship

The MVP MAY include commit previews only if F-006 routing can safely support them without delaying production/staging release channels. Full pull request preview workflow SHOULD wait until webhook normalization, artifact retention, and route cleanup are stable.

## Acceptance Criteria

- A preview URL MUST never replace production or staging traffic unless explicitly promoted through F-008.
- Preview URLs SHOULD be predictable enough for reviewers and unique enough to avoid branch collision.
- A new commit on a pull request SHOULD update the current preview while preserving access to recent previous commit previews according to retention policy.
- Preview deletion MUST remove routing references before artifact retention can delete associated artifacts.
- Git status callback failures SHOULD be visible but MUST NOT invalidate the preview artifact.

## Product Risks

Preview deployments are highly visible and easy to overbuild. Product scope SHOULD start with stable URLs and clear retention, not collaboration features. Comments, approvals, visual diffs, and review annotations MAY be future features but MUST NOT distract from artifact-backed preview correctness.

## Dependencies

F-007 depends on F-002 pull request events, F-004 builds, F-005 artifacts, and F-006 preview routing. It can generate future demand for F-001 role controls and F-008 promotion from preview.
