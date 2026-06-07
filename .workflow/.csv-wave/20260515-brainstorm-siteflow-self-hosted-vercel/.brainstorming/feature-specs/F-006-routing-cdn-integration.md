# F-006 Routing and CDN Integration

## Summary

Routing and CDN Integration materializes validated SiteFlow state into Nginx configuration and optional CDN cache operations. Routing resolves hostnames and paths to release channels or preview deployments and preserves the previous known-good configuration on failure.

## User Value

Operators can move traffic with confidence because route changes are generated, validated, observable, and reversible. CDN integration is optional and does not hide local routing truth.

## Requirements

- MUST resolve hostnames and paths deterministically to one channel or preview target.
- MUST generate Nginx configuration from validated database records and artifact manifests.
- MUST run dry-run validation before reload.
- MUST preserve previous known-good config if validation or reload fails.
- SHOULD expose routing status, last reload time, active deployment, last error, and last CDN operation per domain.
- MAY purge or prewarm CDN paths when provider adapter is configured.
- SHOULD reserve preview-compatible route keys during P0 even if full previews are P1.

## Data/State

Records include `domain_bindings`, `route_bindings`, `release_channels`, `preview_deployments`, `routing_config_revisions`, and `cdn_operations`. Config revisions store generated checksum, validation output, apply result, timestamps, and last known-good reference. CDN operations link to route revision and channel event with idempotency key.

## Operations

Route apply reads a consistent state snapshot, renders staged config, runs `nginx -t`, atomically activates config, reloads Nginx, and marks revision applied or failed. CDN failures are reported and retryable but do not automatically undo a successful local route apply.

## Acceptance Criteria

- Failed Nginx validation does not change live traffic.
- Reload failure preserves previous known-good config and surfaces failure on the operation.
- Domain plus path maps to exactly one active target.
- Operators can dry-run routing changes.
- CDN status is visible separately from routing state.

## Open Questions

- Should previews use wildcard DNS, path-based routing, or both?
- What Nginx deployment topology is the reference: local config, sidecar, or remote applier?
- Which CDN adapters, if any, are required for MVP?

