# AWS Architect — Pipeline & Code Flow

How a request moves through the code, stage by stage — including the boundaries, gates, and fallbacks defined by flaw resolutions 1–8 (`Problems.md`). Mirrors the module layout in `.planning/ARCHITECTURE.md`.

**Scope:** this is the Module A (AI Architecture Advisor) pipeline, which is the entire project. Modules B/C/D are descoped (2026-09-05) and have no pipeline here.

Stage 3's output contract was rewritten after decisions I-22/I-23 removed the closed pattern-template slots and the 12-service cap. If you are reading an older copy that says `pattern: <1 of 5–8 templates>` or `services:≤12`, it is stale.

<!-- GSD:flow-start -->

## Big picture

```
 User input (repo URL | freeform description)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  POST /api/analyze  (voice of input + validation@boundary)  │
└───────────────┬─────────────────────────────────────────────┘
                ▼
  Stage 1: INPUT NORMALISATION       (parse URL | take description)
                ▼
  Stage 2: EVIDENCE EXTRACTION       (repo: RepoFetcher; freeform: none)
                │   ┌─ insufficient-signal gate (flaw 8) ─┐
                │   │   no key files + README < 100 chars  │──► return advisory:
                │   └──────────────────────────────────────┘   "describe instead" (prefill)
                ▼
  Stage 3: INFERENCE                  RuleEngine (baseline, never fails)
                │                     LLM enhance (if key) → schema gate (flaw 5)
                │                     single path wins → grounded, catalog-validated ServicePlan
                │                     + optional curated alternate (patternAlternates.ts)
                ▼
  Stage 4: DIAGRAM (pure fn)          ServicePlan → deterministic mxGraph XML
                ▼
  Stage 5: COST                       PriceService (region, cache) → CostService rows + formulas
                ▼
                │───────────────────────────┐
                ▼                           ▼
  Stage 6: RESPOND                   7. CLIENT RENDER
   {service_plan, diagram_xml,        draw.io iframe · cost table · slider (client math) ·
    cost_rows, alternate?,             .drawio download · CFT YAML download · alternate compare ·
    cft_yaml?}                         region switch (re-fetch) · save/reopen
```

---

## Stage 1 — Input normalisation

**Code:** `routes/analyze.ts` (validation at the HTTP boundary)
**Stage 2–6 in `Problems.md` terms:** input choice.

- Accept `{ input: { kind: 'github_url' | 'description', value: string } }`.
- Validate: URL format, host allowlist (github.com only — SSRF guard), input length caps (e.g. description ≤ 8,000 chars; URL ≤ 2,000).
- Set `input_kind` here — it is frozen for the whole request and stored with history (flaw 7 decision: `input_kind` ≠ `grounding`).

---

## Stage 2 — Evidence extraction

**Code:** `services/repoFetcher.ts` → emits `RepoSignals`

### Repo path (flaw 1 bounds applied here)

```
repo URL
  → GET /repos/{owner}/{repo}          (default branch; 1 call)
  → GET .../git/trees/{ref}?recursive=1 (1 call, full path list; cap 50k paths)
  → select key files (allowlist, root or depth ≤1):
       README* · package.json · requirements.txt · pyproject.toml · go.mod ·
       Cargo.toml · Gemfile · composer.json · pom.xml · build.gradle · *.csproj ·
       Dockerfile · docker-compose.{yml,yaml} · serverless.{yml,yaml} ·
       .github/workflows/*.yml · vercel.json · netlify.toml · terraform/*.tf · template.yaml
  → cap: 20 files; skip over-limit by priority (README → manifests → container/CI)
  → fetch each via GET /contents/{path} (.raw media type) — 64KB raw read cap per file
```

**Post-fetch processing (flaws 1):**
- **Structured files (JSON/YAML/TOML, XML):** *compact, never raw-truncate.*
  - JSON: stdlib `JSON.parse` → keep first ~40 top-level keys → re-stringify (well-formed).
  - YAML: `yaml` lib — `parseDocument` → first ~40 top-level entries → `stringify` (well-formed).
  - TOML/XML: line trim (~200 lines) + drop final line if mid-tag/table.
  - Unparseable → keep only `{ name, sizeBytes }`, set `parse_errors[]`.
- **Prose** (README, plain lists): line truncation at 64KB (no structure to preserve).
- Set `truncated` flag if any cap was applied.

**Emits:** `{ input_kind:'repo', keyFiles:[{path, kind, content|compact}], truncated, parseErrors[], readmeLength }`

### Freeform path

- No fetch. `RepoSignals` is empty; the description text itself is the evidence for Stage 3.
- `grounding` is set to `'description'` here (flaw 4).

### Insufficient-signal gate (flaw 8)

```
if (input_kind == 'repo'
    && keyFiles has NO manifest/container/CI file
    && readmeLength < 100 chars)
  → NOT an inference-failure fallback: abort at extraction
  → response: { status:'insufficient_signal',
                message:"Couldn't extract enough from this repo — describe it instead",
                prefill: { repoName, readmeSnippet } }
```

The user is prompted (not silently guessed) to switch to freeform, pre-filled. A result is never produced from near-zero signal.

---

## Stage 3 — Inference

**Code:** `services/ruleEngine.ts`, `services/llmClient.ts`, `services/inference.ts`

```
evidence (RepoSignals | description)
   │
   ├─► RuleEngine.analyze(evidence) ───────────► baseline ServicePlan (never fails, zero keys)
   │
   ├─► if !llmConfigured() → skip LLM (silently)
   │
   ├─► LLMClient.structured(evidence, SCHEMA)    temp 0, ≤3 retries, generateObject(zod)
   │        └─► output must conform to the single zod `ServicePlan` schema (flaw 5)
   │
    ▼
    Single-path result (no merge layer — Decision 51): LLM success →
    deterministic mapping of the ArchitectureModel; LLM absent/failed →
    rules baseline.
```

**Schema + validation gate (flaw 5) — provider-agnostic:**
- One fixed contract: the zod `ServicePlan` schema. Every provider runs through the *same* `generateObject(schema)`.
- `generateObject` uses `LlmOutputSchema` (shape only, no `.refine()` guards) so retries are spent on shape errors, not semantics (I-8).
- Single explicit gate: `ServicePlanSchema.safeParse()` — catalog-allowlist check against the **155-entry** `ServiceId` catalog, plus the soft >25-service ceiling warning and the `componentId` uniqueness auto-dedupe refine.
- Any failure → **discard LLM result, return baseline**. No provider-specific thresholds.
- A provider that can't emit the schema via `generateObject` is out of rotation — never tuned around.

**Grounding & confidence (flaw 4):**
- `grounding: 'repo' | 'description'` rides on `service_plan.metadata`.
- Repo-grounded → confidence tier High/Medium from rules↔LLM consensus.
- Description-grounded → **capped at "Low confidence"** regardless of internal agreement → UI banner: *"Inferred from your description only — not verified against code."*

**Output contract — current state (post I-22 / I-23):** validated `ServicePlan`:
```
{ input_kind,
  detectedPattern,            // one of the closed 8-value PATTERN_IDS enum (architecture.ts):
                              // static-site · serverless-api · containerised-app · event-driven ·
                              // ml-pipeline · full-stack-web · data-pipeline · generic
                              // UI label + sanity lookup ONLY — it does NOT constrain which
                              // components or how many services the plan may contain
  components: [{ id, name, type, technology, details, evidence[], confidence }],
  awsMappings: [{ componentId, serviceId, confidence, evidence, category }],
  relationships: [...],
  proposalTitle?, tradeOffDimension?, tradeOffDescription?,   // set when an alternate exists
  metadata: { grounding, truncated, parseErrors } }
```

Four things changed from the original design and are load-bearing:

- **Open 155-entry catalog, not a ~30–40 enum.** `ServiceId` in `schema.ts` is a deliberately-open allowlist of 155 AWS services. It is safe to extend. The **PATTERN_IDS enum (8 values) is a separate thing and must NOT be widened** — the two are distinct (see `.planning/ARCHITECTURE.md`, "Two-Enum Distinction").
- **Soft ceiling, no hard 12-service cap (I-22).** The old "≤ 12 distinct services by construction" template-slot cap is gone. A plan with more than 25 services emits a **warning and still passes** `safeParse`. Nothing in the pipeline hard-rejects on service count.
 - **`componentId` uniqueness enforced, non-fatally (I-23).** A `.refine()` guard on `ServicePlanSchema` detects duplicate component IDs and auto-deduplicates (keeps the first, logs a warning) — never a `safeParse` rejection. Multi-service mappings that would collide get semantic suffixes: `-storage` (S3), `-registry` (ECR), `-alb` (ALB), `-gateway` (APIGateway), `-scheduler` (EventBridge). (The former union-find merge clustering was deleted with the merge layer, Decision 51.)
- **Every component and mapping must cite real evidence (commit 6286583).** `normalizeArchitectureModel()` drops components whose `evidence[]` is empty. When an `evidenceRegister` is present, citations are resolved against it and citations failing `isEvidenceSupportingComponent()` are dropped. Nothing may be emitted from prose alone where repo-grounded evidence is expected.

Single-deployable rule (flaw 2) still holds: only root/depth-≤1 manifests reach the fetcher, so classification picks **one** pattern — the strongest root-level deployable. No composition.

### Alternate proposal path

**Code:** `services/patternAlternates.ts`

After the primary `ServicePlan` is validated, `buildAlternateProposal(primaryPlan, input)` may emit a **second** plan for side-by-side trade-off comparison. Trade-offs are **curated and hardcoded — never inferred from score proximity or heuristics.** `CURATED_ALTERNATE_PAIRS` is keyed by `detectedPattern`; a pattern with no entry returns `null` and the analysis produces exactly one proposal.

Currently curated:

| Primary pattern | Alternate | Trade-off dimension |
|-----------------|-----------|---------------------|
| `serverless-api` (DynamoDB OLTP) | `data-pipeline` (S3 + Redshift + Kinesis) | Low-latency transactions vs. ad-hoc query flexibility |
| `containerised-app` (ECS/Fargate) | `serverless-api` (Lambda) | Predictable latency & concurrency vs. scale-to-zero idle cost |

The alternate is built by applying `serviceModifications` (remove/add) to the primary's mappings, then re-running `buildServicePlan()` — so the alternate is a full `ServicePlan` and flows through Stages 4–6 identically (its own diagram XML and cost rows). Both plans get `proposalTitle` / `tradeOffDimension` / `tradeOffDescription` stamped.

> **Ground-truth constraint.** Any evidence-triggered alternate must be checked against `aws-architect/testing baseline.md`'s per-repo **"Do not infer"** lists before it is treated as correct. That file is a live evaluation spec, not documentation. Concretely: for a public-testnet + RPC-provider evidence pattern (Solidity/Hardhat/ethers.js/Sepolia), the blockchain layer is an **external service ($0, non-AWS)** and **Managed Blockchain must not be proposed**, not even as an alternate.

---

## Stage 4 — Diagram

**Code:** `src/lib/diagram.ts` — pure function `generateDiagramXml(plan, sdkEvidence?) → mxGraph XML`

Transforms a validated `ServicePlan` into standard, production-ready `.drawio` XML with collision-free layout, Well-Architected color-coded containers, orthogonal edge routing, and mathematical viewport centering.

```
ServicePlan (components, awsMappings, relationships)
   │
   ├─► Step 4.1: Deduplication & Normalization
   │      - Duplicate generic mappings in same tier (e.g. multi-ALB/SecretsManager)
   │        consolidated into master nodes; relationships re-routed.
   │      - normalizeServiceName: maps IDs to official names ("Amazon ECS", "AWS Secrets Manager").
   │      - wrapServiceName: wraps labels >16 chars into balanced lines (width ≤100px).
   │
   ├─► Step 4.2: Tier Classification & Layout (computeLayout)
   │      - Partitions services into 5 Well-Architected tiers:
   │        edge (banner) | vpc_public (DMZ) | vpc_compute (private) | vpc_data (isolated) | external.
   │      - Dynamic bucketHeight(rows) computes container dimensions wrapping children with padding.
   │      - Subnet columns: 4 for VPC subnets, 6 for edge, 2 for external.
   │
   ├─► Step 4.3: Mathematical Centering
   │      - Computes tight bounding box (minX, minY, maxX, maxY) of all containers & nodes.
   │      - Sets canvas size with uniform padding (CANVAS_PAD_X=64, CANVAS_PAD_Y=56).
   │      - Translates every container and node by exact offset (shiftX, shiftY) → 0px margin differential.
   │
   ├─► Step 4.4: Orthogonal Edge Routing (routeEdges)
   │      - Stepped gutter waypoints: midY = (srcBot + dstTop) / 2 prevents node pass-throughs.
   │      - Horizontal branching bus: cleanly splits compute-to-data connections across tier gutters.
   │      - Solid edges (#232F3E, 1.5px) for explicit evidence; dashed (#6B7280, 8 8) for inferred topology.
   │      - Staggered label offsets with opaque white badges (labelBackgroundColor=#FFFFFF) prevent strikethrough.
   │
   ▼
Emits: valid .drawio mxGraph XML (<mxfile>, <diagram>, <mxGraphModel>, containers, nodes, edges)
```

---

## Stage 5 — Cost

**Code:** `services/prices.ts` (PriceService), `services/cost.ts` (CostService)

### At analysis time (flaw 3)
- **On analysis:** fetch Price List API **once per (region, service)** for the distinct services in the plan; cache raw unit prices server-side (in-memory, keyed `region:serviceCode:usageType`, TTL 24h). The old "≤12 services" bound no longer comes from a template slot cap (I-22) — batch size is now whatever the plan contains, typically well under the soft ceiling of 25.
- Defaults from `SERVICE_DEFAULTS.ts` (each with a `source` annotation — free-tier limit or stated "small-app baseline", flaws 6) fall back when the API is unavailable. Baseline quantities are **never derived from repo content** — always labeled assumptions.

### Quantity formulas
- CostService returns per-service `{ unit, unitPrice, quantityFormula, monthly }` where `quantityFormula` is like `users * 5000` (requests), `log2(users) * 1GB` (storage), or a fixed floor.
- Client keeps the formulas + prices to recompute live (Stage 7 slider).

### Region switch (flaw 3 — on-demand, bounded)
```
region changed on cost tab
  → cost panel shows "Loading prices…", slider disabled
  → POST /api/prices { services (distinct services in plan), region }
  → PriceService: cache hit? → instant
    miss? → fetch only the planned services (GetProducts batch, within token-bucket burst) → ~1-2s typical
  → enable slider with new prices
```
- No pre-warming of other regions; default region = analysis region (us-east-1) → common path never re-fetches.

---

## Stage 6 — Response

**Code:** `routes/analyze.ts`, `routes/prices.ts`

Response to the client (all server-side compute, no secrets):
```
{
  input_kind, grounding,
  service_plan,             // validated ServicePlan (no service cap; detectedPattern is a label)
  diagram_xml,              // mxGraph XML for the iframe + .drawio download
  cost_rows: [{service, unit, unitPrice, quantityFormula, monthly}],
  alternate?: {             // present only when patternAlternates has a curated pair
    service_plan,           // full alternate ServicePlan
    diagram_xml,
    cost_rows,
    proposalTitle, tradeOffDimension, tradeOffDescription
  },
  cft_yaml?,                // CloudFormation template (cftExport.ts) when requested
  warnings: [truncated, parse_errors, grounding disclaimer, soft-ceiling (>25 services),
             duplicate-componentId auto-dedupe, insufficient?]
}
```

**CloudFormation export — `services/cftExport.ts`:** deterministic `ServicePlan → CFT YAML`. Covers Lambda, ECS (cluster/task-def/service), API Gateway REST, ALB, VPC + public/private subnets, S3, DynamoDB, RDS, SQS, SNS, EventBridge. Injects least-privilege IAM execution roles, `AppName`/`Environment` parameters, and output ARNs, with a review disclaimer. Like the diagram, it is a pure deterministic function of the plan — the LLM never emits YAML (Decision 4).

Error paths:
- Insufficient signal (Stage 2 gate) → advisory payload, no plan/diagram/cost.
- LLM failure → baseline plan still returned (Stage 3).

---

## Stage 7 — Client render (in browser)

**Code:** `src/components/*`, `src/app/page.tsx`

| UI element | Behavior |
|------------|----------|
| **Architecture Workspace** | Embedded draw.io iframe (`embed.diagrams.net/?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json&fit=1`). Handshake: `init` event triggers `{action:'load', xml, autosize:1}` followed by `{action:'center'}`. Re-centers automatically on window resize. |
| **Workspace Sizing** | Responsive container bounded at `max-w-6xl xl:max-w-7xl` with `mx-auto` on desktop to prevent edge-to-edge stretching, with large vertical viewport (`h-[74vh] min-h-[580px] max-h-[860px]`). |
| **Fullscreen Mode** | Toolbar toggle switches the diagram workspace into an immersive `100vw × 100vh` modal canvas. |
| **Download .drawio** | Client-side Blob download of `diagram_xml` string; opens directly in Diagrams.net / draw.io desktop without server round-trip. |
| **External Editor** | Direct link button to `https://app.diagrams.net` for advanced external editing. |
| **Alternate proposal compare** | Shown only when `alternate` is present. Renders the alternate's title, trade-off dimension, and description beside the primary, with its own diagram and cost rows for side-by-side evaluation. |
| **Download CloudFormation** | Client-side Blob download of `cft_yaml` (`cftExport.ts` output) with the accompanying architectural-review disclaimer. |
| **Loading Visualizer** | Calm central breathing core orb with `Layers` icon, ambient glow, concentric ripple rings, orbital SVG dashes, and live progress percentage counter. |
| **User slider (100→1M)** | **Pure client math** from cached `cost_rows` formulas — no network per tick. |
| **Region picker** | Triggers `POST /api/prices` (Stage 5); spinner + disabled slider while loading. |
| **Grounding banner** | If `grounding='description'`: *"Inferred from your description only — not verified against code."* |
| **Assumptions disclosure** | Expandable list of every cost default + its `source` (flaw 6). |
| **Insufficient-signal UI** | Prompt + button switching input to freeform, pre-filled. |

## Side flows — Auth & History

**Code:** `routes/auth.ts`, `routes/history.ts`, `services/auth.ts`, `db.ts`

### Save
```
logged-in, "Save analysis"
  → POST /api/history
     { input_kind, input, grounding, service_plan, diagram_xml, cost_snapshot }
  → cost_snapshot = frozen { region, generated_at,
        services:[{code, unitPrice, quantityFormula, monthly}], grandTotal }
  → INSERT analyses(id, user_id, input_kind, input, grounding,
                    service_plan, diagram_xml, cost_snapshot, created_at)
```

### Reopen (flaw 7 — frozen, never recomputed)
```
  → GET /api/history → list of user's own rows (user-scoped)
  → open one → return stored service_plan + diagram_xml + cost_snapshot verbatim
  → slider/region recompute client-side over the FROZEN snapshot units ONLY
  → no Price List call, no LLM call, no inference re-run
```

### Auth
- `better-auth` email/password; sessions in SQLite; guest generation totally unchanged (Phase 6 adds zero to the core loop).

---

## Rate / cache / external notes (how the flow stays within bounds)

| Resource | Guard |
|----------|-------|
| GitHub API | PAT via env (5k req/hr) + per-`owner/repo@sha` evidence cache; unauthenticated path still works (60/hr). |
| LLM | ≤3 retries; no key → rules-only. |
| AWS Pricing | 24h TTL cache; one fetch per (region, service) for the plan's distinct services; burst ~10 (5/s refill) covers a typical batch. |
| draw.io embed | Server sends XML; iframe does the rendering — no bundling of mxGraph. |

<!-- GSD:flow-end -->

---
*Last updated: 2026-09-27 — Stage 3 is single-path (merge layer deleted, Decision 51); pattern baselines evidence-gated (Decision 52). Prior merge/baseline-injection wording is superseded.*