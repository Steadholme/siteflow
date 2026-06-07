# VP-019 Routing Rules

Issue: `ISS-20260527-019`

Completed at: `2026-05-27T18:20:41+08:00`

## Scope

- Added project-level routing rule domain/read-model/API contracts for redirects, rewrites, and response headers.
- Added Postgres persistence for routing rules with upsert/disable audit events.
- Added project API routes:
  - `GET /api/projects/:projectId/routing-rules`
  - `GET /api/projects/:projectId/routing-rules/match`
  - `PUT /api/projects/:projectId/routing-rules`
  - `DELETE /api/projects/:projectId/routing-rules/:ruleId`
- Added SDK, HTTP client, fixture client, and CLI support:
  - `siteflow routing-rules list`
  - `siteflow routing-rules upsert`
  - `siteflow routing-rules disable`
- Applied routing rules at request time after firewall decisions:
  - redirects return before artifact/function serving
  - rewrites change the internal artifact/function lookup path
  - header rules attach to artifact/function responses

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
  - 4 files, 107 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 169 tests passed.
- `npm run build`

## Notes

- The first implementation supports exact paths, suffix wildcard paths, global `/(.*)` headers, and named parameter substitutions such as `/blog/:slug -> /posts/:slug`.
- A future iteration can import `vercel.json` routing config directly during build/deploy.
