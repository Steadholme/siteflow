# Roadmap Generation Report

Date: 2026-05-25
Mode: light
Topic: SiteFlow Vercel parity

## Summary

SiteFlow already has a self-hosted prebuilt deploy path, API auth, wildcard preview routing, and installer groundwork. The next iteration should target the highest-leverage Vercel parity gap: Git-connected project environments and source deployments. This creates the product loop users expect: import project, push branch, receive preview URL, promote/rollback production.

## Sources

- Vercel deployment methods: Git, CLI, Deploy Hooks, REST API.
- Vercel Git deployments: automatic preview deployments, production branch deployments, instant rollback.
- Vercel environments: Local, Preview, Production, custom environments, env pull.
- Vercel CLI deploy: source deploy and `--prebuilt` behavior.
- Vercel managing deployments: filter, inspect, promote, assign domains.
- Vercel rolling releases: staged traffic rollout and canary/current comparison.

## Priority Decision

Do not start with rolling releases. Route state, real deployments, logs, and production alias semantics must exist first. Rolling releases become safe only after promotion/rollback and observability are reliable.

## Output

- Roadmap: `.workflow/design/siteflow-vercel-parity/roadmap.md`
- Task breakdown: `.workflow/design/siteflow-vercel-parity/tasks.md`
- Issues: `.workflow/issues/issues.jsonl`

