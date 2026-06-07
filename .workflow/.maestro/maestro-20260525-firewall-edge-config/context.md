# VP-014 Firewall And Edge Config

Status: completed
Issue: `ISS-20260525-014`
Execution: `EXC-022`

## Scope

- Added project firewall rule domain/read models for allow/block/challenge actions with IP, path, header, and user-agent conditions.
- Added Edge Config key/value domain/read models for boolean, number, string, and JSON values.
- Added Postgres migration and repository support for firewall rules, Edge Config entries, audit events, rule disabling, Edge Config deletion, and firewall evaluation.
- Applied firewall evaluation before static artifact serving and before deployed function invocation.
- Added management HTTP routes, SDK methods, fixture client behavior, and CLI commands for `siteflow firewall` and `siteflow edge-config`.
- Kept Edge Config management reads behind read authorization and mutating firewall/config routes behind admin authorization.

## Files

- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `server/readRepository.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.ts`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`
- `cli/siteflowCli.test.ts`

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm run build`

## Notes

- Firewall evaluation now runs before both static artifact routing and function module loading, so block/challenge decisions prevent runtime execution.
- IPv4 firewall matching supports exact values, wildcard prefixes such as `203.0.113.*`, and CIDR ranges such as `10.0.0.0/24`.
- Edge Config values are redacted through the existing secret redaction path before they leave fixture/Postgres read models.
