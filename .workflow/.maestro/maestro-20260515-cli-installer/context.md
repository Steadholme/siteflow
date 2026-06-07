# Maestro Session Report: SiteFlow CLI Installer

Date: 2026-05-15
Session: `maestro-20260515-cli-installer`
Intent: design a Vercel-like self-hosted SiteFlow CLI installer.

## Summary

The CLI installer design is now captured as implementation-ready workflow artifacts. The target MVP is a real single-host production path: bundled Postgres, local artifacts, local Docker worker, managed Nginx, TLS, install-state manifest, doctor checks, backup/restore, upgrade, uninstall, and status/logs commands.

The design explicitly rejects mock-backed production behavior. Existing frontend fixtures remain acceptable for tests and isolated UI demos only. Production install and runtime paths must use real API, database, worker, artifact storage, and routing adapters.

## Artifacts

- Analysis: `.workflow/design/siteflow-cli-installer/analysis.md`
- Specification: `.workflow/design/siteflow-cli-installer/specification.md`
- Roadmap: `.workflow/design/siteflow-cli-installer/roadmap.md`
- Tasks: `.workflow/design/siteflow-cli-installer/tasks.md`
- Source brainstorm: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel`

## Decisions

- MVP topology is single-host.
- Installer state lives in `/etc/siteflow/install-state.json`.
- Operation checkpoints live under `/var/lib/siteflow/operations`.
- Mutating commands use plan/render/diff/apply/verify/commit phases.
- Nginx changes use validate-and-swap with previous known-good config.
- Secrets are file-backed and never printed after generation.
- Worker Docker access is treated as a high-trust boundary until stronger isolation is implemented.
- External DB, S3, CDN, and distributed workers are later phases.

## Verification

- `npm test -- --run`: passed, 56 tests.
- `npm run build`: passed.
- Runtime client rollback check: temporary runtime API client files are absent; current UI default client is back to fixtures.

## Recommended Next Command

Use this design as the seed for implementation planning:

`$maestro-plan --dir .workflow/design/siteflow-cli-installer "Implement SiteFlow production CLI installer MVP without mock-backed runtime paths"`

