# F-006 Routing and CDN Integration

## Architectural Scope

Routing MUST be derived from validated SiteFlow state. The routing applier SHOULD render complete Nginx config fragments from projects, domains, release channels, preview deployments, and artifact manifests.

Nginx and CDN state are materialized state. If they drift, the system MUST be able to regenerate desired configuration from the database and artifact manifests.

## Route Resolution

Production and staging hostnames SHOULD resolve through release-channel pointers. Preview routes SHOULD resolve through preview deployment records and MUST NOT replace production release channels.

The route key SHOULD include hostname, optional path prefix, channel or preview identifier, and artifact root. Route generation MUST reject duplicate host/path combinations before writing config.

## Atomic Apply

Route changes SHOULD follow this sequence:

1. Read a consistent database snapshot and target route revision.
2. Render config files into a staging directory.
3. Run dry-run validation such as `nginx -t` against staged config.
4. Atomically swap or activate the new config.
5. Reload Nginx.
6. Mark the route revision applied and record result metadata.

If validation or reload fails, the previous known-good config MUST remain active. The failure MUST be visible on the related channel or preview operation.

## CDN Adapter

CDN integration MAY be configured per project or domain. The adapter SHOULD support purge and optional prewarm after promotion or rollback. CDN failures SHOULD NOT roll back a successful local route apply by default, but they MUST be reported and retryable.

## Preview Compatibility

Even if preview deployments are P1, the P0 routing model SHOULD reserve route primitives for previews: wildcard host patterns, branch-safe slugs, and commit-specific artifact roots. This avoids a later route model migration.

## Observability

Routing operations MUST emit route revision, generated config checksum, validation result, reload result, and last known-good revision. Operators SHOULD be able to compare desired routes against active config.
