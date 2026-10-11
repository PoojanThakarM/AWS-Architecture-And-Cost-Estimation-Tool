# AGENTS.md — Operating Notes for Coding Agents

## Scope

Module A (AI Architecture Advisor) only. Modules B/C/D are descoped.
Do not build cost-monitoring, optimization, or security-scanner features.

## Before changing inference code

Read `DECISIONS.md` (decisions #51–53, log I-24–I-25) and `FLOW.md` Stage 3.
Inference is single-path by design: rules baseline OR LLM deterministic
mapping, never a merged union. Do not reintroduce a merge step without a
new decision entry.

## Invariants to preserve

- Every component and mapping must cite real evidence (commit `6286583`).
  Never invent evidence strings to justify a service.
- `PATTERN_IDS` stays at 8 values. The 155-service `ServiceId` catalog is
  the only list that may grow.
- `npx tsc --noEmit` is clean (2026-10 audit fixed the old diagram.ts/ruleEngine.ts errors). Keep it clean.
- Cost defaults are disclosed assumptions, never inferred from repo content.

## Verification

- `npm test` must stay green (353/353). If a behavior change breaks a
  fixture, report the exact expected-vs-actual diff; do not silently edit
  evaluation fixtures in `testing baseline.md` or `baseline-check.ts`.
- `npx tsc --noEmit` must stay clean; `npm run lint` must report 0 errors.
- The 8-repo diagnostic needs network + (for the merged column) an LLM key.
  Rules-only mode measures the deterministic baseline alone.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
