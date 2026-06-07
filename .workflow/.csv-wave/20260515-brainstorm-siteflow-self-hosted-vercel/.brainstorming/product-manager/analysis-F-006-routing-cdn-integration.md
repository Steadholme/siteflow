# F-006 Product Management: Routing and CDN Integration

## Product Intent

Routing is the moment SiteFlow changes user traffic. The product MUST make this operation deterministic, validated, observable, and reversible. Nginx integration is the MVP routing anchor; CDN support is a value-add adapter, not a platform dependency.

## P0 Scope

- Map hostnames and paths to production, staging, or preview targets.
- Generate Nginx configuration from validated deployment state.
- Run dry-run validation before reload.
- Apply Nginx updates atomically and preserve previous known-good configuration.
- Expose routing status, last reload time, active deployment, and last error per domain.
- Support production and staging channels.

## P1 Scope

- Preview routing at scale with wildcard DNS or path-based rules.
- CDN purge after promotion or rollback when configured.
- CDN prewarm for critical paths.
- Multi-domain project management improvements.

## Acceptance Criteria

- A promotion MUST NOT make traffic changes if generated Nginx configuration fails validation.
- If Nginx reload fails, the previous known-good routing config MUST remain active.
- A domain MUST resolve to exactly one active channel or preview target at a time.
- Operators SHOULD be able to dry-run routing changes before applying them.
- CDN operations MAY fail independently, but their status MUST be visible and MUST NOT hide routing state.

## Product Risks

Routing errors are high-severity product failures. MVP SHOULD constrain routing patterns before adding flexibility. A simple host-to-channel mapping is preferable to complex path rewrites until validation and rollback are proven. CDN integration MUST be marketed as optional because self-hosted buyers may use Cloudflare, Fastly, internal CDNs, or none.

## Dependencies

F-006 depends on project domains from F-001, artifacts from F-005, preview records from F-007, and transactional release state from F-008. It is the primary operational risk area and should be tested in every release gate.
