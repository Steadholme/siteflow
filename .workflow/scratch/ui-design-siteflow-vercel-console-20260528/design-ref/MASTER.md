# SiteFlow Console Design Reference

## Direction

Selected direction: Precision Operations Console.

SiteFlow should feel closer to Vercel's production dashboard than a marketing analytics page: compact, fast to scan, neutral, and built around deployments, routes, evidence, and release safety. The interface favors high information density, restrained color, crisp boundaries, and explicit state labels.

## Principles

- Use full-width operational surfaces rather than decorative sections.
- Keep cards at 8px radius or less.
- Prefer dense grids, tables, rails, and segmented toolbars.
- Reserve color for status, action, and selection.
- Avoid one-note purple/blue gradients and oversized hero composition.
- Preserve fixture/demo clarity while making the UI read like a production control plane.

## Selected Variant

Variant 1: Precision Operations Console

- Mood: formal and technical.
- Density: dense.
- Contrast: crisp but not dark-themed.
- Rounding: sharp to medium.
- Motion: minimal.
- Color temperature: neutral with cool blue command accents and green success states.

## Implementation Targets

- Global tokens.
- Shell navigation and topbar.
- Shared panels, tables, buttons, status pills, timelines.
- Project, deployment, and release workspaces.

## Vercel Interface Guidelines Pass

Reference: `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`

Applied structural rules:

- Added a visible-on-focus skip link and stable `main` anchor.
- Replaced decorative topbar search copy with a real named `type="search"` input.
- Moved project inventory search and status filters into labeled form controls.
- Synchronized project search/filter state into the URL query string.
- Replaced three-dot loading copy with the single ellipsis character.
- Removed `transition: all` from design tokens.
- Added tabular numeric treatment for metrics and numeric table cells.
- Added overflow handling for long project names and table cells.
- Preserved button/link semantic distinction for actions versus navigation.
