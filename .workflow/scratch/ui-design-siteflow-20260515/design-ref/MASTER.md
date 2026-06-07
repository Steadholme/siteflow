# SiteFlow Design Reference

Selected style: Operations Ledger  
Stack target: standalone HTML/CSS reference, suitable for React/Tailwind translation later.  
Source brainstorm: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel`

## Design Position

SiteFlow's UI should feel like a control-plane operations tool: compact, factual, auditable, and fast to scan. The first screen in the product should be an actual operational workspace, not a marketing landing page.

The interface must prioritize:

- Current production state.
- Build and artifact evidence.
- Route revision health.
- Safe promotion and rollback.
- Audit reasons and actor history.
- Fast filtering across projects and deployments.

## Selected Style

Operations Ledger uses a light neutral surface, restrained teal primary actions, orange attention accents, semantic status colors, compact tables, and low-radius panels. It is designed for repeated platform operations rather than brand expression.

6D attributes:

- color_saturation: 0.34
- visual_weight: 0.46
- formality: 0.82
- organic_geometric: 0.72
- innovation: 0.42
- density: 0.84

## Color Palette

- Primary: `oklch(42% 0.13 168)`
- Primary hover: `oklch(36% 0.13 168)`
- Accent: `oklch(58% 0.17 35)`
- Background: `oklch(97% 0.006 250)`
- Surface: `oklch(100% 0 0)`
- Text primary: `oklch(22% 0.025 250)`
- Border default: `oklch(86% 0.012 250)`
- Success: `oklch(48% 0.14 152)`
- Warning: `oklch(58% 0.15 78)`
- Error: `oklch(52% 0.18 28)`
- Info: `oklch(48% 0.13 235)`

All colors are stored in OKLCH in `design-tokens.json`.

## Typography

- Heading/body: Inter.
- Monospace: JetBrains Mono.
- Page titles use 22-24 px equivalent sizing.
- Dashboard body text stays around 14 px for dense scanning.
- Letter spacing remains `0` throughout the system.

## Layout System

The app shell uses a left navigation rail on desktop and a single-column shell on mobile. Operational pages use full-width work surfaces, compact panels, tables, inspector rails, and timeline evidence blocks.

Cards are reserved for repeated items, metrics, panels, and inspectors. Sections should not become nested decorative card stacks.

## Components

- Buttons use icon + text for primary commands and icon-only only for familiar quick actions.
- Status pills use semantic colors and short labels.
- Tables keep stable column widths with horizontal overflow on small screens.
- Build logs use a dark monospace panel inside the otherwise light workspace.
- Audit forms should keep the reason field visible near destructive or release-moving actions.

## Animation

Motion is minimal. Hover states use 100-180 ms transitions for color, border, shadow, and small `translateY(-1px)` movement. Reduced-motion media query is mandatory and included in `animation-tokens.json` and prototype CSS.

## Anti-Patterns

- Do not use oversized hero sections.
- Do not use decorative gradient blobs or abstract backgrounds.
- Do not hide production state behind marketing copy.
- Do not make rollback a low-context destructive button.
- Do not show secret values in project settings, logs, manifests, or route config.
- Do not use purely monochrome status language; state must be visible through text and semantic color.

## Reference Prototypes

- `prototypes/project-list-style-1-layout-1.html`
- `prototypes/project-list-style-1-layout-2.html`
- `prototypes/project-detail-style-1-layout-1.html`
- `prototypes/project-detail-style-1-layout-2.html`
- `prototypes/deployment-detail-style-1-layout-1.html`
- `prototypes/deployment-detail-style-1-layout-2.html`
- `prototypes/release-rollback-console-style-1-layout-1.html`
- `prototypes/release-rollback-console-style-1-layout-2.html`
- `compare.html`
