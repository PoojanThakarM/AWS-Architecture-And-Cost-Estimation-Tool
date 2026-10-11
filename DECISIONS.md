# AWS Architect — Decisions Log

Every decision made for this project, with the "why". Source of truth: `.planning/PROJECT.md` (Key Decisions), `.planning/research/*` for the stack/architecture research, and Resolutions of the 8 pipeline flaws (`Problems.md`).

<!-- GSD:decision-start -->

## How to read

- **Status**: `Locked` = decided and not expected to change (research-backed); `Pending` = committed to, but will be validated in its phase; `Out of Scope` = consciously not built, boundary stated.
- Decisions are grouped: Pipeline & Architecture · Diagram · Inference & LLM · Input & Fetch · Cost · Auth & History · Stack.

---

## Pipeline & Architecture

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 1 | **Thin-client SPA + one monolith server; the pipeline never runs in the browser** | LLM keys, GitHub token, and price caching must stay server-side. Saved history needs a backend anyway. A "client-side proxy" is just a server with CORS pain. | Locked |
| 2 | **One JSON contract `ServicePlan` drives both diagram and cost** | Diagram and cost can never diverge. One shared zod schema module prevents shape drift across every boundary (rules, LLM, diagram, cost, history). | Locked |
| 3 | **Rules-first, LLM-enhances (fallback direction inverted)** | Deterministic rule engine gives a guaranteed no-key baseline; the LLM only improves it. No API key, no budget, no LLM network → the demo still works. | Locked |
| 4 | **LLM never emits diagram XML or prices** | XML is structurally unforgiving (one bad `<` = draw.io rejects the file). LLM outputs only a validated `ServicePlan`; diagram XML and prices are generated deterministically. | Locked |
| 5 | **LLM failure silently degrades to the rules baseline — ≤3 retries, never an error page** | Demo survivability: provider down/unconfigured/malformed output must not break the app. | Locked |
| 6 | **Frontend state = one `useAnalysis()` hook (`useState`/`useMemo`), no state library** | Results are ephemeral component state; a global store is added complexity for nothing. | Locked |
| 7 | **Server-side-only secrets, github.com host allowlist, timeouts, content caps, rate limiting** | SSRF and secret leaks are security boundaries — never simplified away. | Locked |

## Diagram & Visualization

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 8 | **Deterministic tier hierarchy & container sizing** | Resources map into Well-Architected security zones (Edge, Public DMZ, Compute, Isolated Data, External). Containers wrap their children with calculated padding; subnet titles sit top-left to avoid crossing vertical edges. | Locked |
| 9 | **Full-label bounding boxes (`CELL_W=116px`, `CELL_H=80px`, `GAP=32px`) & multi-line wrapping (`wrapServiceName`)** | AWS service names up to 32 chars (`Application Load Balancer (ALB)`) collide if cells only accommodate the 56px icon. Word-wrapping at ≤16 chars/line keeps text width within ~100px, guaranteeing ≥40px horizontal and ≥28px vertical clearance. | Locked |
| 10 | **Redundant service deduplication with semantic subtitle retention** | Multiple generic mappings to the same service in a tier (e.g. multi-ALB or Secrets Manager) clutter the diagram. Consolidating into a single master node with re-routed edges while retaining specific role subtitles (e.g. `(Static Assets)`) produces publication-grade diagrams. | Locked |
| 11 | **Orthogonal gutter waypoints & opaque edge label badges (`routeEdges`)** | Direct lines cut across intermediate nodes. Routing edges through the midpoint gutter between tiers (`midY = (srcBot + dstTop) / 2`) creates a clean branching bus. Staggering edge labels with opaque white badges (`#FFFFFF`, padding, border) eliminates wire strikethrough. | Locked |
| 12 | **Solid vs dashed edge semantics** | Explicitly confirmed connections (from manifests, compose, SDK calls) render as solid lines (`#232F3E`, 1.5px). Pattern-inferred topology hints render as dashed lines (`#6B7280`, 8 8, 1px) with tooltips, clearly distinguishing verified code connections from heuristics. | Locked |
| 13 | **Mathematical diagram bounding box centering** | Prevents random diagram positioning and huge empty margins. Computes content bounding box `(minX, minY, maxX, maxY)` and translates all containers and nodes by exact offset `(shiftX, shiftY)` with uniform padding (`64px` X, `56px` Y), achieving 0px margin differential. | Locked |
| 14 | **Responsive bounded workspace with viewport fit/center and fullscreen mode** | Stretching draw.io edge-to-edge on ultra-wide screens causes eye strain. Bounding to `max-w-7xl` with `mx-auto` provides comfortable margins while maximizing height (`h-[74vh]`). PostMessage `load` with `autosize: 1` and `{ action: 'center' }` on load and window resize ensures immediate centering. A fullscreen toggle provides an immersive workbench. | Locked |

## Inference & LLM

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 15 | **Inference = LLM-based with rule-based keyword fallback** | Best accuracy with a deterministic safety net. | Locked |
| 16 | **Output contract = the single zod `ServicePlan` schema, identical for every provider via `generateObject`** | Provider-agnostic. A uniform `safeParse` + catalog-allowlist gate precedes any use; failure → rules baseline. **No provider-specific tuning thresholds.** | Locked |
| 17 | **Catalog allowlist (expanded 150+ AWS service enum with soft ceiling warning)** | A hallucinated service never reaches the diagram or cost. Strict enum across 10-tier AWS catalog (155 services) prevents non-AWS hallucinations while removing artificial accuracy caps. Soft ceiling at >25 services appends a warning without failing safeParse. | Locked |
| 18 | **Primary LLM = DeepSeek `deepseek-v4-flash` via `@ai-sdk/deepseek`; Gemini Flash / Groq free tiers as fallbacks** | Cheapest usable API for a demo's worth of calls. The official provider handles DeepSeek's `json_object` quirks (naive openai-compatible path hits vercel/ai#7913). Provider swap = env key/model only. | Locked |
| 19 | **Freeform/description results are capped at the "Low confidence" tier** | Freeform has no code to verify against. `grounding='description'` results show a banner "Inferred from your description only — not verified against code". Repo-grounded results show High/Medium per consensus. | Pending |
| 20 | **Insufficient-signal = explicit advisory, not a silent guess** | If extraction yields **no allowlist manifest/container/CI file AND README < 100 chars**, no inference is attempted: prompt the user to switch to the freeform path, pre-filled with repo name + README snippet. | Pending |
| 21 | **LLM retries capped at 3; temperature 0; JSON mode / responseSchema** | Bounded cost, deterministic-ish output, no runaway loops. | Locked |

## Input & Fetch

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 22 | **Repo analysis = README + key files via GitHub REST, never a full clone** | Fast, cheap, catches the majority of infra signals (80%). One `git/trees?recursive=1` call for the file list + targeted `contents` fetches. | Pending |
| 23 | **Key-file fetch bounded by allowlist + caps** | Depth/size bounds must be deterministic. Key files = fixed allowlist at root or depth ≤1 (README; `package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle, *.csproj`; `Dockerfile, docker-compose.{yml,yaml}, serverless.{yml,yaml}, .github/workflows/*.yml, vercel.json, netlify.toml, terraform/*.tf, template.yaml`). **Caps: 20 files, 64KB raw read/file, 50k-path cap on the tree.** Over-limit files skipped by priority (README → manifests → container/CI), flagged `truncated`/`parse_errors`. | Pending |
| 24 | **Structured files (JSON/YAML) are compacted, never raw-truncated mid-structure** | Compact to the first ~40 top-level entries and re-serialise as well-formed output (stdlib `JSON.parse` for JSON; `yaml` lib for YAML). Unparseable files degrade to **filename-only signal** (`{name, sizeBytes}`) — still feeds the rules baseline. Never feed malformed YAML/XML to the LLM. | Locked |
| 25 | **Freeform description is the default input; guided questionnaire optional** | Both paths converge on one pipeline; keep the default frictionless. | Pending |
| 26 | **Server-side GitHub PAT via env (5,000 req/hr) + per-`owner/repo@sha` evidence cache; unauthenticated path still works (60 req/hr)** | The shared server IP hits the unauthenticated limit first during classroom demos (~7 analyses/hr). | Locked |
| 27 | **SSRF protection: host allowlist (github.com), timeouts, response caps** | Boundary security, not simplified away. Private-repo access is out of scope (needs a token). | Locked |

## Cost

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 28 | **Cost from the real AWS Price List API, on-demand + defaults + region picker** | Free API, accurate prices, minimal user input. Bulk files are public (no credentials) — corrects the earlier assumption that IAM creds are required. | Pending |
| 29 | **Unit prices cached server-side (in-memory, keyed `region:serviceCode:usageType`, TTL 24h)** | Prices change at most weekly; a 24h cache keeps the API out of the hot path. Slider recalculation is a pure function of cached prices. | Pending |
| 30 | **Region switch = on-demand re-fetch of only the plan's distinct services — ~1–2s typical** | Batch size is whatever the plan actually contains. (The original "≤12, bounded by template slots" wording is superseded by Decision 50 / I-22 — there is no service cap; plans typically stay under the 25-service soft ceiling, so one ~10-token burst still covers a batch.) No pre-warming of other regions (wastes API calls). Cost panel shows "Loading prices…" and the slider is disabled during the fetch. Default region = analysis region (us-east-1), so the common path never re-fetches. | Pending |
| 31 | **Cost simulator = client-side math over cached prices/formulas** | Server returns unit price *and* the quantity formula (`users × perUser`); slider ticks recompute 100% client-side — zero network round-trips. | Locked |
| 32 | **Cost baselines are sourced + disclosed, never silent** | Every per-service default carries a `source` in `SERVICE_DEFAULTS.ts` (+ documented in `DEFAULTS.md`): an AWS free-tier limit (Lambda 1M req/mo, S3 5GB, API Gateway 1M req/mo, DynamoDB 25GB, CloudFront 1GB egress, nano/micro instances…) or an explicit "small-app baseline" assumption. The cost screen shows an expandable **Assumptions** list; defaults are **never derived from repo content** and always labeled as assumptions — an unsourced cost number would undermine the whole core value. | Locked |
| 33 | **"Not a bill" disclaimer; on-demand rates only; stated assumptions (no data transfer, no NAT, no free tier)** | Honest estimate framing; validated that a known EC2+RDS+S3 stack lands within ~2x of AWS Pricing Calculator. | Pending |
| 34 | **Unpriced services shown separately with a note — never silently missing from the total** | Transparency over silent omission. | Pending |

## Auth & History

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 35 | **Optional login; generation works fully as a guest; auth built last (Phase 6)** | Guest path is a hard requirement; auth multiplies test surface and adds zero to the core loop. | Locked |
| 36 | **better-auth email/password (declarative); never hand-rolled sessions/hashing/CSRF** | Security is exactly what you never simplify away. next-auth's Credentials provider is fiddly, so better-auth wins for email/password-first. | Locked |
| 37 | **SQLite via better-sqlite3 (pin ^12) + built-in Kysely adapter; two tables, no ORM** | One file, zero ops. `better-auth@1.6.26` declares peer `better-sqlite3@^12`, so pin ^12, not 13. Prisma/Postgres/Redis/Docker are order-of-magnitude overkill. | Locked |
| 38 | **History = exact frozen snapshot stored at save time** | Schema: `analyses(id, user_id?, input_kind, input, grounding, service_plan JSON, diagram_xml TEXT, cost_snapshot JSON, created_at)`. Reopening **never** re-queries prices or re-runs inference; the slider scales client-side from snapshot quantities only. Re-analysis = a new row. | Pending |
| 39 | **`input_kind` (what was pasted) and `grounding` (what inference ran on) are separate fields** | They can differ — a repo whose repo-content path failed and fell back to its description is `input_kind='repo', grounding='description'`. Separating them avoids the "user chose freeform" vs "repo degraded" ambiguity without a third enum state. | Locked |

## Stack

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 40 | **Next.js 16 (App Router) + React 19 + TypeScript on Node 22 LTS** | One process serves UI + API routes; server-side code is mandatory (keys). Node 22 satisfies every dependency's engine constraint (AI SDK v7, `@ai-sdk/*` v4, `better-sqlite3`). | Locked |
| 41 | **Vercel AI SDK v7 + zod 4** | `generateObject` + zod schema = structured JSON with schema enforcement and auto-retry in one code path for every provider. zod 4 satisfies the `ai@7` peer range. | Locked |
| 42 | **`@aws-sdk/client-pricing` (GetProducts, Query API)** | Official SDK; server-side only. Preferred for on-demand lookups; public bulk files are the zero-credential alternative. | Locked |
| 43 | **Native `fetch` for GitHub; no octokit/axios/isomorphic-git** | GitHub REST does everything (README + key files); a clone is slower and heavier. | Locked |
| 44 | **tailwindcss 4 optional for UI (CSS-first config); not load-bearing** | Fine default; plain CSS is acceptable — this is not a decision that matters. | Locked |
| 45 | **Deployment = hosted for real use** (revised 2026-09-05; was "local/university-hosted demo", Out of Scope) | The tool is useful outside the demo, so it should be reachable rather than localhost-only. Constraints unchanged in kind: free/near-free tier, single tenant, low traffic, all secrets (LLM keys, AWS pricing keys, GitHub token) server-side in the hosted environment. **Still Out of Scope within this decision:** CI/CD pipeline automation and multi-tenancy work. | Locked |

## Scope & Post-W8 Additions

Decisions taken after Module A reached feature-complete (2026-09-05). These supersede parts of the original plan — where they conflict with an earlier row, these win.

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 46 | **Scope = Module A (AI Architecture Advisor) only; Modules B/C/D descoped** (2026-09-05) | Depth on one capability beats four shallow modules. Module B (Cost Monitoring), C (Resource Optimization), and D (Security Scanner) all require reading a live customer AWS account, which the architecture advisor never needs — dropping them removes that entire credential and ingestion surface (Cost Explorer, TimescaleDB, CIS scanning, SES alerting) instead of shrinking it. `TIMELINE.md` W9–W14 are retained as historical planning record and marked descoped, not upcoming. | Locked |
| 47 | **Alternate architecture proposals = curated pairs keyed by detected pattern, never inferred from score proximity** | Heuristic "second-best score" comparisons produce nonsense pairings. `CURATED_ALTERNATE_PAIRS` in `patternAlternates.ts` holds explicit hand-written trade-offs; a pattern with no entry yields exactly one proposal. Every alternate must be checked against `aws-architect/testing baseline.md`'s per-repo "Do not infer" lists before being treated as correct — that file is a live evaluation spec, not documentation. | Locked |
| 48 | **CloudFormation (CFT YAML) export generated deterministically from the validated ServicePlan** | Same reasoning as Decision 4 for diagram XML: YAML is structurally unforgiving and the LLM must never emit it. `cftExport.ts` is a pure function of the plan, with least-privilege IAM roles, `AppName`/`Environment` parameters, output ARNs, and a review disclaimer. | Locked |
| 49 | **Web3/blockchain evidence maps to an external service ($0, non-AWS); Managed Blockchain is never proposed** | For a public-testnet + RPC-provider evidence pattern (Solidity/Hardhat/ethers.js/MetaMask/Sepolia), the chain is not AWS-hosted infrastructure. `aws-architect/testing baseline.md` §2 states "Blockchain RPC: external provider; **no AWS blockchain service required**" and lists Managed Blockchain under "Do not infer" — so it is barred as a primary *and* as an alternate. Any alternate for such a repo must target the parts that are AWS-hosted (e.g. App Runner vs. Fargate + ALB for the contract-relay backend). | Locked |
| 50 | **Closed pattern-template output contract retired** (supersedes the "pattern-first, template-driven" row in `.planning/PROJECT.md` Key Decisions) | Recorded here because several planning docs still described it: the "5–8 pattern templates with named node slots, ≤12 distinct services by construction, ~30–40 service enum" contract was removed by I-22/I-23. Current contract: open 155-entry `ServiceId` catalog, soft >25-service warning (never a `safeParse` failure), component/relationship model, `componentId` uniqueness via non-breaking refine + merge-time union-find clustering, and a mandatory evidence citation per component and mapping. `PATTERN_IDS` survives as an 8-value UI label and must NOT be widened. | Locked |
| 51 | **Rules↔LLM merge layer deleted; single-path inference is the architecture** (2026-09-27) | `runInference` calls either the rules engine or the LLM→deterministic-mapping path, never both. `mergeSingleServicePlan`/`mergeServicePlans` therefore had zero production call sites. Wiring a union-merge would have grown over-inference (union adds services) while the diagnostic demanded fewer invented services. Deleted the functions and their tests; I-10 confidence tiers and I-23 clustering notes below are historical record of removed code, not current behavior. LLM-path confidence comes from the model's own evidence-backed citations plus the grounding cap (Decision 19). | Locked |
| 52 | **Pattern baselines are evidence-gated: no component evidence, no service** (2026-09-27) | `applyPatternBaselines` injected Route53/CloudFront+S3/ALB/ECS/CloudWatch/SecretsManager with fabricated justification strings, a primary driver of the 8-repo over-inference failures. Per the evidence-citation mandate (commit `6286583`), a baseline service is only emitted when a real component cites real evidence for it. Component-derived mappings in `mapComponentToAws` already cover frontend/backend/compute tiers with genuine evidence, so the baseline function now returns no injections. `PATTERN_IDS` stays a closed 8-value `appType` UI label, separate from the 155-service `ServiceId` catalog. | Locked |
| 53 | **Monorepo fetch→detection chain fixed end-to-end (Redis correctly detected for IaC-heavy monorepos)** (2026-09-27) | Single root problem, three causal stages: structured stack detection silently failed for monorepo/IaC-heavy repos at the fetch-selection stage, not the analysis stage as earlier reviews assumed — service manifests never reached the analyzer, so no detector could fire. Stage 1, `selectWorkspaceAware` bucket fix (`repoFetcher.ts`): Pass-2 round-robin bucketed by first path segment only, collapsing every `src/<service>/` manifest into one `src` bucket; manifests under container dirs (`src`, plus the existing `packages`/`apps`/`services`/`modules`/`libs`/`internal`/`cmd` convention from `NESTED_MANIFEST_PATTERNS`, the single source of truth) now bucket two segments deep. Necessary but insufficient on its own. Stage 2, budget reservation (`repoFetcher.ts`): Pass 1 took README + workspace-root + root manifests + ALL `container_ci` files uncapped, consuming 57 of 60 slots on microservices-demo and leaving 2 manifest slots regardless of bucketing; the cap is now split — README/workspace-root unconditional, manifests guaranteed `MANIFEST_RESERVE` = floor(cap/2) (root first, then round-robin), `container_ci` fills only the remainder, Pass 3 takes the rest by score. This was the fix that actually mattered: manifests selected went 2 → 14 on microservices-demo. Stage 3, `DOTNET_PACKAGE_MAP` gap fix (`repoAnalyzer.ts`): exact-name matching (plus token fallback) recognized only bare `StackExchange.Redis` / `Npgsql.EntityFrameworkCore.PostgreSQL`; added `Microsoft.Extensions.Caching.StackExchangeRedis` → Redis, bare `Npgsql` → PostgreSQL, `Google.Cloud.Spanner.Data` → Cloud Spanner, plus sibling variants found on the same pass (`MySql.Data`/`MySqlConnector` → MySQL, `Microsoft.EntityFrameworkCore.SqlServer`/`Microsoft.Data.SqlClient`/`System.Data.SqlClient` → SQL Server, `MongoDB.Driver`/`MongoDB.Driver.Core` → MongoDB). Matching logic itself untouched. Verification chain on `GoogleCloudPlatform/microservices-demo` (live fetch+analyze): before — 60 keys (1 readme + 57 `container_ci` + 2 manifests), stack showed Go, Java/JVM, Gorilla Mux, 4 infra lines, zero databases; after — 14 manifests including `src/cartservice/src/cartservice.csproj`, stack adds Node.js/TypeScript, Python, C#/.NET, Flask, Database PostgreSQL (`productcatalogservice/go.mod` → `jackc/pgx/v5`), Database SQLAlchemy ORM, Database Redis (`src/cartservice/src/cartservice.csproj` → `Microsoft.Extensions.Caching.StackExchangeRedis`), Database Cloud Spanner (same csproj → `Google.Cloud.Spanner.Data`). Open flags, recorded exactly: (a) Cloud Spanner detected in stack profile but has no ServiceId in `schema.ts`, so it's a silent dead end downstream with no corresponding AWS service ever proposed — needs a product decision (add a mapping, or filter it from Detected Codebase Stack output) not just a code fix; (b) bare Npgsql evidence is correctly shadowed by label dedup when pgx/v5's PostgreSQL entry is also present — confirmed correct behavior, not a bug, noted so it isn't mistaken for one later. | Locked |

<!-- GSD:decision-end -->

---

## Implementation Log

### Stage 1 — Rules-based inference (BuildOrder step 1) · 2026-08-18

| # | Decision | Why |
|---|----------|-----|
| I-1 | **`type: "module"` added to `aws-architect/package.json`** | Node 26 ESM resolution requires explicit module type when using `--experimental-strip-types` for test-running `.ts` files directly. Next.js is unaffected (it has its own bundler). |
| I-2 | **Test runner = Node built-in `node:test` + `--experimental-strip-types`** | Zero extra dependencies for Stage 1 tests. Works on Node 26. `import type` must be used for TypeScript type-only exports or strip-types will error at runtime. |
| I-3 | **`src/lib/schema.ts` is the single ServicePlan contract module** | Matches Decision 2 (one contract). All pipeline stages import from here. The two `.refine()` guards enforce the expanded 150+ catalog allowlist gate and a soft ceiling (>25 services warning, no hard safeParse rejection) on every `safeParse` call. |
| I-4 | **`src/lib/ruleEngine.ts` — pattern scoring via additive keyword scoring, highest score wins** | Deterministic, testable, zero external calls. Ties broken by specificity order (more-specific patterns listed first). A floor of 0 for `generic` ensures it is always available as last resort. |
| I-5 | **`/api/analyze` route stubs Stage 2 (RepoFetcher) with empty `fileContent`/`fileNames`** | Stage 2 is not built yet. The route is functional end-to-end for freeform descriptions and gives a basis for integration testing. The stub is clearly marked with a comment so Stage 2 knows where to wire in. |
| I-6 | **Route returns `diagram_xml: null` and `cost_rows: null` for Stages 4–5 not yet built** | Explicit nulls instead of omitting the fields keeps the response shape stable — the frontend can always destructure without defensive checks for field presence vs. null. |

### Stage 2 — LLM inference + schema gate + evidence extraction (BuildOrder step 2) · 2026-08-18

| # | Decision | Why |
|---|----------|-----|
| I-7 | **RepoFetcher included in Stage 2 (not a separate stage)** | LLM inference is useless without real repo content; both are needed before the pipeline produces meaningful results for the github_url path. BuildOrder stage 2 ("LLM inference + schema gate") implicitly requires evidence extraction. |
| I-8 | **`LlmOutputSchema` for `generateObject` excludes `.refine()` guards; full `ServicePlanSchema.safeParse()` is the explicit gate** | `generateObject` retries on shape errors (wrong types, missing fields). Catalog violations are our explicit gate — we don't want the LLM to burn retries on them. Separation is cleaner: LLM handles shape, gate handles semantics. |
| I-9 | **Provider chain: DeepSeek → Google Gemini Flash → Groq; first env key wins** | Matches Decision 18. `resolveProvider()` checks env vars in priority order; if none set, `llmConfigured()` returns false and LLM is silently skipped (Decision 5). |
| I-10 | **Merge confidence rules: both agree → "high"; LLM only → min(llm, "medium"); baseline only → "low"** | Consensus = high confidence. LLM without rules confirmation is capped at medium (it may hallucinate). Rules without LLM confirmation are low (weak signal). Transparent, predictable tiers. |
| I-11 | **Slot name collision resolution: second occupant gets `additional_N` overflow slot name** | Two services can't share a slot. The priority order (high > medium > low) means the better-evidenced service keeps the semantic slot name; the lower-confidence one overflows. |
| I-12 | **Evidence cap to LLM: 16 KB total prompt evidence, 3 KB per file** | Prevents context overflow on large repos. The rule engine already runs on the full content; the LLM cap is only for prompt length, not signal extraction. |
| I-13 | **`fetchRepoSignals` uses `raw.githubusercontent.com` for file content, GitHub Contents API as fallback** | The raw URL returns plain text; the Contents API returns base64-encoded JSON which requires decoding. Raw is faster and cleaner. Redirect following disabled (SSRF guard). |
| I-14 | **`capConfidence` comparison: `ci >= mi ? c : max`** | `CONFIDENCE_ORDER = ["high","medium","low"]`; lower index = better. To cap at `max`, return `c` only if `c` is already worse-or-equal (`ci >= mi`); otherwise clamp to `max`. (Fixed off-by-one bug caught by tests.) |

### Stage 3 — Diagram generation, layout engine & workspace UX (BuildOrder step 3) · 2026-08-30

| # | Decision | Why |
|---|----------|-----|
| I-15 | **`src/lib/diagram.ts` dynamically nests subnets inside VPC and anchors external column to VPC right extent** | Replaces rigid fixed-coordinate templates with dynamic packing (`computeLayout`) that auto-sizes containers around placed children. |
| I-16 | **Orthogonal waypoint synthesis through mid-tier gutters (`midY = (srcBot + dstTop) / 2`)** | Guarantees connection wires do not pass through intermediate service nodes; creates a clean horizontal branching bus for compute-to-data edges. |
| I-17 | **Dynamic cell allocation (`CELL_W = 116px`, `CELL_H = 80px`, `GAP = 32px`) with multi-line label wrapping (`wrapServiceName`)** | Resolves label collisions between adjacent nodes by guaranteeing ≥40px horizontal clearance and ≥28px vertical clearance without over-inflating canvas size. |
| I-18 | **Mathematical diagram centering via bounding box translation (`shiftX`, `shiftY`)** | Eliminates asymmetric canvas whitespace; centers the complete architecture inside the canvas with uniform margins (0px left/right and top/bottom diff). |
| I-19 | **Draw.io postMessage protocol with `autosize: 1` and `{ action: "center" }` on init and resize** | Ensures draw.io immediately fits and centers the diagram within the user's viewport without manual panning or unreadable down-scaling. |
| I-20 | **Responsive workspace bounded at `max-w-7xl` with fullscreen workbench toggle** | Prevents wide desktop monitors from stretching the editor edge-to-edge; maintains large vertical workspace (`h-[74vh]`) and offers a dedicated 100vw × 100vh workbench. |
| I-21 | **Focused loading visualizer removing orbiting badges while preserving breathing core orb** | Minimizes visual distraction during inference while maintaining clear progress feedback through central glow, rings, icon, and numeric percentage. |
| I-22 | **Expanded 155-service AWS catalog allowlist & soft ceiling (>25 services warning)** | Eliminates artificial 12-service cap and narrow catalog enum constraints while maintaining strict zero-hallucination guarantees. Plans with >25 services emit a warning without failing `safeParse`. |
| I-23 | **Component ID collision resolution, multi-service mapping disambiguation & schema uniqueness guard** | Resolves `Duplicate service component` diagram warnings. Merging unifies identical components across baseline and LLM preserving subtitles (Decision 10), disambiguates multi-service mapping component IDs (`-storage`, `-registry`, `-alb`), and enforces `componentId` uniqueness via a non-breaking auto-dedupe refine guard on `ServicePlanSchema`. |

### Dead-merge removal & baseline gating · 2026-09-27

| # | Decision | Why |
|---|----------|-----|
| I-24 | **Deleted `mergeSingleServicePlan`/`mergeServicePlans` and their tests (Decision 51)** | Grep confirmed zero production call sites outside `__tests__/`. `runInference` runs rules baseline OR LLM deterministic mapping, never both, so the ~360-line union-merge (I-10, I-11, I-23) was dead code. Deletion over repair: union-merge adds services while the 8-repo diagnostic demanded fewer invented ones. `inference.ts` now holds only `deriveGrounding`, `applyGroundingCap`, and `runInference`. |
| I-25 | **Gated `applyPatternBaselines` to zero unconditional injections (Decision 52)** | Every baseline entry carried a fabricated evidence string, violating commit `6286583`. The function now emits nothing; `mapComponentToAws` component mappings (each carrying genuine evidence) already cover the tiers. Unit expectations updated: no CloudWatch/S3-from-baseline without evidence (architecture, stage1Regression). Full suite 274/274 (4 removed merge tests account for the 278→274 delta). Rules-only 8-repo diagnostic: 0/8 — unchanged, since the rules engine was not touched; merged-column comparison was not measurable (no LLM key configured). |

*Last updated: 2026-09-27 — Decision 53 consolidates the monorepo fetch→detection chain (bucket fix + budget reservation + .NET map variants). 278/278 tests pass; `tsc` shows only pre-existing diagram.ts/ruleEngine.ts errors (untouched, out of scope).*