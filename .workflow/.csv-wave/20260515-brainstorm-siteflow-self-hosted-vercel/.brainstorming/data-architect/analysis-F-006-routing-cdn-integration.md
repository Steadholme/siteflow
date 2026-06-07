# F-006 Routing and CDN Integration - Data Architecture

## Routing State

Routing state SHOULD be generated from normalized records:

- `domain_bindings`: hostname ownership and verification
- `release_channels`: production or staging pointer to active deployment
- `preview_deployments`: preview URL to deployment mapping
- `route_bindings`: resolved host/path to channel or preview target
- `routing_config_revisions`: generated Nginx config version, checksum, validation result, apply result, and timestamps
- `cdn_operations`: provider, operation type, target paths, status, response summary, and retry metadata

Nginx configuration MUST be derived from validated database state. Hand-edited runtime config MUST NOT be the authoritative source.

## Atomic Application Model

SiteFlow SHOULD create a `routing_config_revision` in `pending` state inside the same transaction that updates release channel state or preview route state. A router worker then renders config, validates it, applies it, reloads Nginx, and marks the revision `applied` or `failed`.

If validation or reload fails, the previous known-good revision MUST remain active. The failed revision SHOULD retain validation output and generated checksum for diagnosis.

## CDN Operation History

CDN purge or prewarm operations MAY be asynchronous, but they SHOULD be linked to the triggering routing revision and channel event. CDN failures MUST NOT erase the release channel change, but the UI/API SHOULD expose CDN status so operators understand cache freshness risk.

CDN operation records SHOULD include idempotency key to prevent duplicate purges on retry.

## Consistency Boundaries

Domain activation MUST validate uniqueness before generating routes. Release-channel promotion MUST use the channel transaction as the source of routing intent. Preview creation MUST reserve the preview URL before exposing it externally.

Routing generation SHOULD be deterministic: identical database inputs produce identical config checksum. This allows drift detection and safer rollbacks to previous config revisions.

## Indexing

Indexes SHOULD support:

- `domain_bindings(hostname)` unique for active domains
- `route_bindings(hostname, path_prefix)` unique where applicable
- `routing_config_revisions(status, created_at)`
- `routing_config_revisions(project_id, channel_name, created_at)`
- `cdn_operations(routing_revision_id)`
- `cdn_operations(status, next_retry_at)`

## Audit Trail

Domain changes, route generation, Nginx validation, Nginx reload, CDN purge, CDN prewarm, and fallback to previous config SHOULD emit audit or operational events. The audit event for promotion or rollback MUST reference the routing revision that attempted to apply it.
