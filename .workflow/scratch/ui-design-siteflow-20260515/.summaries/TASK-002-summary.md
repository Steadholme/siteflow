# TASK-002 Summary

Status: completed

Implemented the projects feature routes and replaced the project placeholders with fixture-backed project inventory and project detail views.

## Delivered

- `projectRoutes` now exports `/projects` and `/projects/:projectId` route elements without importing `RoutePlaceholder`.
- Project inventory page with summary metrics, stale-data notice, filter toolbar, horizontally scrollable inventory table, operations lanes, and recent control-plane events.
- Project detail page with project header, production/staging/previews environment matrix, deployment history, repository metadata, domains, redacted secret policy metadata, and recent events.
- Feature-scoped components and CSS under `src/features/projects/**`.
- Runtime guards for fixture responses where repeated read-model references are replaced by redaction placeholders.
- Project tests covering list/detail route rendering, empty projects, paused projects, queued builds, route drift, API errors, and secret canary absence.

## Verification

- `npm test -- --run src/features/projects/projects.test.tsx`: passed, 1 test file and 8 tests.
- `npm run build`: passed, strict TypeScript and Vite production build completed.

## Notes

- The project UI consumes `SiteFlowClient` through injectable page props for tests and defaults to `FixtureSiteFlowClient` in route usage.
- Secret values and provider payload internals are not rendered; the page shows only redacted metadata and policy summaries.
- Repeated object references from fixture read models can be redacted into placeholders, so project activity and deployment-history components filter invalid rows before rendering.
