# Codebase Guide

## Directory structure

```text
src/
├─ app/
│  ├─ page.tsx                 Main UI: input tabs, results tabs, report export
│  ├─ layout.tsx               Root layout (Google "Geist" fonts — needs network at build)
│  └─ api/
│     ├─ analyze/route.ts      POST: full pipeline
│     ├─ prices/route.ts       POST: re-price a plan for another region/user count
│     └─ export/cft/route.ts   POST: CloudFormation from a plan or a diagram
├─ components/
│  ├─ AnalysisVisualizer.tsx   Loading animation
│  ├─ Banners.tsx              EngineBanner, GroundingBanner, WarningsBanner, …
│  ├─ CostCalculator.tsx       Cost table, user slider, region picker
│  ├─ DiagramViewer.tsx        draw.io iframe + downloads
│  └─ ArchitectureStack.tsx    Detected stack view
└─ lib/
   ├─ schema.ts                ServicePlan contract + 155-service catalog
   ├─ repoFetcher.ts           GitHub fetch, file selection, size caps
   ├─ repoAnalyzer.ts          Manifest/IaC parsing → ProjectProfile
   ├─ descriptionAnalyzer.ts   Description → ProjectProfile (origin "description")
   ├─ inference.ts             Orchestrator (AI path or rules path)
   ├─ llmClient.ts             Providers, prompts, repair, redaction
   ├─ architecture.ts          LLM model validation + deterministic mapping
   ├─ ruleEngine.ts            Deterministic rules + relationships
   ├─ patternAlternates.ts     Curated alternate proposals
   ├─ diagram.ts               mxGraph XML generation + validators
   ├─ SERVICE_DEFAULTS.ts      Usage baselines and billing lines
   ├─ prices.ts                Price lookup (bulk / SDK) + fallbacks
   ├─ cost.ts                  Cost rows, unpriced rows, rescaling
   ├─ cftExport.ts             CloudFormation generator + validator
   └─ __tests__/               node:test suites, fixtures/, baseline-check.ts
scripts/
├─ cfn-templates.ts            Writes fixture templates for cfn-lint
└─ e2e-test/run.ts             Live 10-repo evaluation (network)
docs/                          This guide
```

## The 12 functions to know first

| Function | File | What it does |
|---|---|---|
| `POST` | `app/api/analyze/route.ts` | Top of the request; read this first |
| `parseGitHubRepoUrl` | `repoFetcher.ts` | Accepts only `github.com/<owner>/<repo>` |
| `fetchRepoSignals` | `repoFetcher.ts` | Network side of evidence extraction |
| `selectWorkspaceAware` | `repoFetcher.ts` | Which 60 files are read (manifests get half the budget) |
| `analyzeProject` | `repoAnalyzer.ts` | Files → languages, frameworks, databases, infra, components, evidence register |
| `analyzeDescription` | `descriptionAnalyzer.ts` | Prose → the same profile shape |
| `runInference` | `inference.ts` | Chooses the path; applies the confidence cap |
| `analyzeArchitecture` | `llmClient.ts` | AI call with failover → `ArchitectureModel` or a typed failure |
| `mapArchitectureModelToServicePlan` | `architecture.ts` | AI model → AWS services (deterministic) |
| `runRuleEngine` / `detectServices` | `ruleEngine.ts` | Rules path |
| `computeCostRows` / `scaleCostRows` | `cost.ts` | Server pricing / client rescaling |
| `generateCftYaml` / `validateCloudFormationTemplate` | `cftExport.ts` | Export + structural checks |

## How the frontend talks to the backend

1. `page.tsx` → `handleSubmit` sends `{ input: { kind, value } }` to `/api/analyze`.
2. The response (type `AnalyzeResponse` in `page.tsx`) holds `service_plan(s)`, `diagram_xml(s)`, `cost_rows(_list)`, `warnings`, `engine`, `diagnostics`, and optionally `project_profile` / `architecture_model`.
3. The user-count slider calls `scaleCostRows` **in the browser** (pure arithmetic, no request).
4. Changing region calls `/api/prices` with the current plan, because prices differ by region.
5. "Download CloudFormation" in `DiagramViewer.tsx` generates YAML in the browser from the plan (same `cftExport.ts` code). `/api/export/cft` is the server equivalent and also returns `coverage`.

## Tracing a request yourself

Run the pipeline without the UI (no keys needed):

```bash
node --experimental-strip-types -e '
import("./src/lib/descriptionAnalyzer.ts").then(async ({ analyzeDescription }) => {
  const { runInference } = await import("./src/lib/inference.ts");
  const text = "React frontend, Express API, PostgreSQL database";
  const profile = analyzeDescription(text);
  const r = await runInference({
    ruleInput: { description: text, fileContent: "", fileNames: [], inputKind: "description",
                 grounding: "description", truncated: false, parseErrors: [], profile },
    signals: null, description: text, profile });
  console.log(r.engine, r.plan.awsMappings.map(m => `${m.serviceId}: ${m.evidence}`));
});'
```

Then follow one service backwards: find its `evidence` string, search for that text in `ruleEngine.ts` (`add("RDS", …)`), and you will land on the rule that produced it.

For a repository, the offline fixtures in `src/lib/__tests__/fixtures/repoFixtures.ts` are the easiest starting point. Pass one through `analyzeProject` and then `runInference`, exactly as `regressionMatrix.test.ts` does.

## Conventions

- Files use `.ts` import extensions so `node --experimental-strip-types` can run tests without a build step. Type-only imports must use `import type`.
- Every recommendation carries an `evidence` string. If you add a rule, write a real evidence string (Decision 52/`6286583`).
- `PATTERN_IDS` stays at 8 values (UI label only); the 155-entry `SERVICE_IDS` catalog is what can grow.
- Add a regression test for every bug you fix (see `auditFixes.test.ts` for the style).
