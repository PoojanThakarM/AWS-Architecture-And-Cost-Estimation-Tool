# CLAUDE.md — AWS Architect (Module A)

AI architecture advisor: repo URL or freeform description → validated
`ServicePlan` → draw.io diagram + cost estimate + CloudFormation export.

## Pipeline (single-path inference, no merge layer)

1. **Evidence extraction** — `src/lib/repoFetcher.ts`, `src/lib/repoAnalyzer.ts`.
   GitHub REST (README + allowlisted key files), never a full clone.
   `selectWorkspaceAware` reserves half the 60-file budget for service
   manifests (two-segment round-robin buckets under monorepo container
   dirs) so IaC/CI files cannot starve them (Decision 53).
2. **Inference** — `src/lib/inference.ts` (`runInference`):
   - LLM configured and successful → `llmClient.ts` builds an
     `ArchitectureModel` (real tech names, every component cites real
     evidence per commit `6286583`), then `architecture.ts`
     `mapArchitectureModelToServicePlan` maps it deterministically.
   - Otherwise → `ruleEngine.ts` deterministic baseline.
   - Exactly one path wins. There is no rules↔LLM merge step
     (`mergeSingleServicePlan`/`mergeServicePlans` deleted, Decision 51).
   - Non-code grounding (`description`, `filenameOnly`, `unfounded`) caps all
     confidence to `low` (Decision 19).
   - Optional curated second proposal via `patternAlternates.ts`
     (hand-written pairs only, never score proximity).
3. **Diagram** — `src/lib/diagram.ts` (pure function, has pre-existing
   `tsc` errors; out of scope, do not touch).
4. **Cost** — `src/lib/prices.ts` + `src/lib/cost.ts` + `SERVICE_DEFAULTS.ts`
   (defaults carry disclosed sources, never derived from repo content).

## Contracts and invariants

- One contract: `ServicePlanSchema` in `src/lib/schema.ts` (155-service
  `ServiceId` catalog, soft >25-service warning, `componentId`
  uniqueness auto-dedupe). LLM never emits diagram XML, prices, or CFT YAML.
- `PATTERN_IDS` (`architecture.ts`) is a closed 8-value `appType` UI label.
  Never widen it; it is separate from the `ServiceId` catalog.
- Evidence mandate: every component/mapping carries a real evidence string.
  `normalizeArchitectureModel` drops evidence-free components.
  `applyPatternBaselines` emits no unconditional injections (Decision 52).
- Source of truth docs: `DECISIONS.md` (decisions #1–53, log I-1–I-25),
  `FLOW.md` (pipeline), `testing baseline.md` (live evaluation spec).

## Commands

- `npm test` — full unit suite (currently 278/278).
- `npm run test:baseline -- --rules-only` — 8-repo rules diagnostic.
- Merged-column diagnostic requires an LLM key; without one the script
  hard-fails by design rather than silently re-measuring rules.
