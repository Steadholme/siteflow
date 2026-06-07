# Framework Build Settings Detection

Date: 2026-05-27
Issue: `ISS-20260527-021`
Artifact: `EXC-029`

## Objective

Continue Vercel parity by resolving framework/build settings from checked-out source projects during worker execution, without changing build job persistence.

## Implemented

- Added `worker/frameworkDetector.ts`.
- Reads Vercel-compatible build settings from `vercel.json`:
  - `framework`
  - `installCommand`
  - `buildCommand`
  - `outputDirectory`
  - `rootDirectory`
- Detects framework presets from `package.json` dependencies:
  - `next` -> `next`, `.next`
  - `vite` or `@vitejs/*` -> `vite`, `dist`
  - `astro` -> `astro`, `dist`
  - `react-scripts` -> `create-react-app`, `build`
  - fallback -> `static`, `dist`
- Applies detection when requested framework is missing, `auto`, or default `static`.
- Preserves explicit framework/output/build command choices when project settings disagree with detection.
- Updated `worker/buildWorker.ts` to use resolved build settings for install/build commands, output directory, and artifact metadata.
- Added worker tests for Vite detection, `vercel.json` overrides, and explicit setting preservation.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed: 6 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npm test -- --run` passed: 18 files, 172 tests.
- `npm run build` passed.

## Notes

- Detection intentionally stays worker-side so checked-out source can be inspected without DB schema changes.
- Next.js detection now resolves preset metadata and output path, but the current static artifact publisher still expects an `index.html` entrypoint. A later Next.js/static export or function/SSR adapter task should address full Next.js runtime support.
