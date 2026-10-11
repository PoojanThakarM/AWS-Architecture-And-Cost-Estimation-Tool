# Bug Fix Report: October 2026 Audit

Scope: the whole repository as supplied (zip of `main`), audited and fixed offline in a sandbox. There was no network access to the AWS Price List, no LLM key, and the GitHub REST API was rate-limited. Every claim below is backed by a test, a probe output, or a tool run; where something could not be verified, this report says so.

## 1. Results at a glance

| Check | Before | After |
|---|---|---|
| `npm test` | 281 / 281 pass | **353 / 353 pass** (+72 new tests) |
| `npx tsc --noEmit` | 13 errors (diagram.ts, ruleEngine.ts) | **0** |
| `npm run lint` | 38 errors, 36 warnings | **0 errors**, 32 warnings (unused imports) |
| cfn-lint on 7 generated templates | 7 errors + 4 hardcoded-password warnings | **0 errors, 0 warnings** |
| cfn-lint on all 17 fixture templates (`npm run cfn:templates`) | n/a | 0 errors; 2 "unused parameter" warnings on the intentional placeholder |
| `npm audit --omit=dev` | 1 critical (Next 16.3.4), 3 high | **0** (`npm audit fix`, lockfile only; Next 16.4.0) |
| `next build` | fails offline (Google Fonts) | compiles + type-checks with fonts stubbed; still needs fonts.googleapis.com on a real build |
| `npm run test:baseline` | not runnable: needs LLM key + GitHub API | not runnable here (see §7) |

Raw evidence: [`audit-evidence/before-after-probes.txt`](audit-evidence/before-after-probes.txt), [`audit-evidence/cfn-lint-before-after.txt`](audit-evidence/cfn-lint-before-after.txt).

## 2. Audit findings by area

| Area | Findings (C = confirmed, S = suspected/not fixed) |
|---|---|
| Architecture | C: the documented single-path design matched the code, but the rules path skipped the Decision-19 confidence cap; the UI never showed which path ran. |
| Runtime errors | C: empty `detectedPattern` crashed diagram title generation; `null` JSON body → unhandled 500 in `/api/prices` and `/api/export/cft`. |
| Incorrect recommendations | C: description input produced nothing; Next.js SSR → static S3; MERN client unhosted; `static` keyword → static site; Route 53 without domain; compose `web` → CloudFront; SQS beside a Redis broker; alternate added DynamoDB beside RDS; AI mapping gave unknown DBs "high" RDS and any auth "high" Cognito. |
| Cost calculations | C: Lambda 10× high; CloudFront 10× low; live per-request prices 10⁶× low; four services priced at $0; VPC unit error; MSK 1 vs 2 brokers; truncated bulk JSON never parsed; tier order arbitrary; client/server Cognito mismatch; API Gateway priced as REST while the export created an HTTP API. |
| Validation | C: AI summary lists bypassed evidence checks; export accepted any `environment`; Mode A skipped validation; validator passed invalid templates. |
| Diagram generation | C: rule relationships gave impossible edges and were drawn as confirmed (solid); 110 catalog services fell into the data subnet. |
| CloudFormation | C: hardcoded passwords; ECS without network config; ALB without subnets; EC2 without AMI; SageMaker role = policy ARN; Redshift missing ClusterType; MSK fake subnets; CloudFront→private S3 without OAC (403); Lambda/SQS trigger without SQS permissions; empty plans filled with unrecommended resources. |
| Security | C: no per-file size cap (30 MB read into memory); no owner/repo validation; provider errors could carry keys into diagnostics; vulnerable Next.js. No secrets or `.env` were committed (scanned). |
| Testing | C: no fixtures for SSR/MERN/contradictory/invalid-URL cases; several tests pinned defective values. |
| Maintainability | C: README described providers (DeepSeek/Groq), env vars and auth that do not exist; CLAUDE/AGENTS said "leave tsc errors alone". S: very large files (`diagram.ts` 2.2k lines, `repoAnalyzer.ts` 2.1k) and duplicated tier/compute lists. |

## 3. Confirmed bugs (prioritised), root cause, fix, files, tests

| ID | Sev. | Bug | Root cause | Fix | Files | Regression test |
|---|---|---|---|---|---|---|
| BUG-01 | **Critical** | Description in rules-only mode → **zero services** ("React + Express + PostgreSQL" returned nothing, `LIBRARY_REPO`) | Rules read technologies from a `ProjectProfile` that only existed for GitHub input | New deterministic `descriptionAnalyzer.ts` (named tech only, quoted citations, `unresolved` questions); description terminal state `INSUFFICIENT_SIGNAL`; library rule skipped for descriptions | `descriptionAnalyzer.ts`, `ruleEngine.ts`, `analyze/route.ts`, `repoAnalyzer.ts` | matrix J, `BUG-01` |
| BUG-02 | **Critical** | Lambda cost 10× too high ($83.33 vs $8.33) | Request count (5M) used as GB-seconds | 500,000 GB-s + separate requests line | `SERVICE_DEFAULTS.ts` | `BUG-02..04` Lambda |
| BUG-03 | High | Live prices for API Gateway/SQS/SNS/EventBridge 10⁶× too low; large bulk files never parsed; tiered price chosen arbitrarily; RDS SKU ignored engine | No unit conversion; `JSON.parse` on first 2 MB; first dimension wins; no attribute filters | `livePriceMultiplier`, 8 MB skip, first-paid-tier selection, attribute filters, streaming decoder | `prices.ts`, `SERVICE_DEFAULTS.ts` | `BUG-03` (5 tests) |
| BUG-04 | High | CloudFront fallback 10× low; MSK/OpenSearch/Secrets/WAF shown as **$0**; VPC $0.01 "endpoint"; MSK priced 1 broker; EC2 t2 price; old DynamoDB price; REST vs HTTP API mismatch; fallback region unlabelled | Wrong constants; missing fallback returned 0; unit/label errors | Corrected values (verified ones marked), `null` → unpriced, VPC no-charge, 2 brokers, labels `priceRegion`/`fallbackStatus`/`priceUnit`/`excludes`, Fargate memory and RDS storage lines | `prices.ts`, `cost.ts`, `SERVICE_DEFAULTS.ts`, `CostCalculator.tsx` | `BUG-02..04` |
| BUG-05 | High | Next.js SSR → S3 static; MERN React client unhosted; AI path: unknown DB → RDS "high", SQLite/Firebase → RDS, JWT → Cognito "high" | SSR frameworks counted as "frontend-only"; separate-SPA rule never fired; catch-all mappings | SSR detection (+ `next.config.*` fetched, static-export check); separate-SPA hosting rule; AI mapping table fixed | `ruleEngine.ts`, `architecture.ts`, `repoFetcher.ts` | matrix B/B2/C, `BUG-05` |
| BUG-06 | High | Diagram/plan edges "ALB reads/writes RDS", "Route53 reads/writes S3", reversed CloudFront→Route53; missing ALB→ECS, API GW→Lambda | Relationship builder treated every `api`-typed component (ALB, Route 53, API GW) as compute | Role-based builder; edges tagged `inferred:` and drawn dashed | `ruleEngine.ts`, `diagram.ts` | `BUG-06`, matrix invariant |
| BUG-07 | Medium | Java CLI → "static site" (S3+CloudFront+Route 53); Route 53 added without a domain; compose `web` → CloudFront; SQS added when Redis is the Celery broker | Bare keyword `static`/`astro` substrings; unconditional Route 53; `web` name heuristic | Specific static-site evidence; domain-gated Route 53; `web` = backend; broker check | `ruleEngine.ts`, `repoAnalyzer.ts` | matrix A/F/Java |
| BUG-08 | High | CloudFormation: 7 cfn-lint errors, hardcoded passwords, no OAC, Lambda/SQS IAM gap, fabricated resources for unsupported plans, invalid `environment` default | Generator had no networking prerequisites/secrets; validator too shallow | VPC prerequisite (2 AZ public+private, IGW routes), generated Secrets Manager credentials, compute-only data-tier SGs, OAC + bucket policy, scoped IAM, SSM AMI, placeholder + `UnsupportedServices`, sanitised names, stronger validator | `cftExport.ts`, `export/cft/route.ts` | `BUG-08` (8 tests), cfn-lint evidence |
| BUG-09 | High | Nonexistent/private/rate-limited repo → ~110 requests then "describe it instead" | 404/403 swallowed; probe fallback ran anyway | `fetchError` classification after 1 request; specific HTTP errors in the route | `repoFetcher.ts`, `analyze/route.ts` | matrix I, `BUG-09` |
| BUG-10 | High (security) | No per-file cap: 30 MB file read fully; owner/repo unvalidated; paths not URL-encoded | Cap removed ("without payload limits") | 64 KB streaming cap, truncated manifests → filename-only, strict owner/repo regex, encoded paths | `repoFetcher.ts` | `BUG-10` |
| BUG-11 | Medium | AI summary lists could add services with no evidence (e.g. `databases: ["DynamoDB"]`); description-path citations not checked | Gating applied to components only | Lists filtered against register/description; quoted phrases verified | `architecture.ts`, `llmClient.ts` | `BUG-11` |
| BUG-12 | Medium | AI reliability: README env vars not read (`GOOGLE_GENERATIVE_AI_API_KEY`), no model override, fenced JSON failed, errors could carry keys, mode not shown in UI | Docs/code drift; no repair; no redaction; UI ignored `engine` | Env aliases + `GOOGLE_MODEL`/`OPENROUTER_MODELS`, `repairText`, `redactSecrets`, EngineBanner + diagnostics, test seam | `llmClient.ts`, `inference.ts`, `Banners.tsx`, `page.tsx` | `BUG-12` (7 tests) |
| BUG-13 | Medium | Description results on the rules path showed "high" confidence | Grounding cap only on the AI path | Cap applied to both paths and to proposals | `inference.ts` | `BUG-13` |
| BUG-14 | Medium | Slider: Cognito at 200k users $550 (client) vs $825 (server) | Client scaled the post-free-tier quantity | `usageQuantity` + free tier re-applied | `cost.ts` | `BUG-14` |
| BUG-15 | Low | Empty pattern crashed diagram; unlisted services drawn in data subnet; 13 tsc errors | `w[0]` on empty string; `?? "vpc_data"`; loose types | `tierOf()` by category, safe title, type fixes | `diagram.ts`, `ruleEngine.ts` | `BUG-15` |
| BUG-16 | Medium | Serverless alternate added DynamoDB beside RDS, or to apps with no DB; kept ECR | Unconditional additions | Alternate swaps compute only; removes ECR | `patternAlternates.ts` | `BUG-16` |
| BUG-17 | High (security) | Next.js 16.3.4 critical advisory; undici/sharp high | Outdated lockfile | `npm audit fix` (in-range, lockfile only) | `package-lock.json` | `npm audit` = 0 (prod) |
| BUG-18 | Low | `null` body → 500; prices userCount unclamped; export Mode A unvalidated; unbounded `diagram_xml` | Missing guards | Body-shape guards, clamp 1–10M, validation, 2 MB cap | 3 route files | manual curl (§5) |
| BUG-19 | Low | React lint errors (setState in effect, ref read during render, memoization) | Patterns flagged by React compiler rules | Derived state / plain handlers | `page.tsx`, `AnalysisVisualizer.tsx`, `DiagramViewer.tsx`, `CostCalculator.tsx` | `npm run lint` |

## 4. Before → after evidence (same probes, same fixtures)

```text
                       BEFORE                                  AFTER
NEXT_SSR        S3 CloudFront (static!)                 ECS ALB CloudWatch
MERN            DocumentDB ECS ALB CloudWatch           + S3 CloudFront (client hosted)
COMPOSE_WORKER  … SQS CloudFront …                      ECS ECR ElastiCache ALB CloudWatch
JAVA_CLI        S3 CloudFront Route53                   (nothing)
STATIC_REACT    S3 CloudFront Route53                   S3 CloudFront
DESC "React + Express + PostgreSQL"  (nothing)          RDS ECS ALB S3 CloudFront CloudWatch (all low)
DESC "Containerized microservices…"  (nothing)          ECS ECR RDS ALB SQS CloudWatch (all low)

404 repo            110 requests, "insufficient signal"   1 request, fetchError=not-found (HTTP 404)
30 MB file          31,457,280 chars read                 65,536 chars, truncated=true

Lambda              5,000,000 GB-s  → $83.33             500,000 GB-s → $8.33 + requests $1.00
CloudFront 100 GB   $0.85                                 $8.50
API GW (live 1e-6)  $0.0000175                           $5.00
MSK/OpenSearch/…    $0.00 "fallback"                      listed as unpriced
Cognito @200k       server $825 / client $550             server = client (both re-apply free tier)

CFN validator       valid=true for templates with 7 schema errors + literal passwords
cfn-lint            7 errors                               0 errors, 0 warnings
```

## 5. Manual end-to-end verification (production build)

The server was built with fonts stubbed (offline sandbox), started with `next start`, and called with `curl` and Playwright:

- Description → `engine: rules`, 6 services, all low confidence, $82.16/mo, diagram 9 KB, 1 warning.
- Vague description → `INSUFFICIENT_SIGNAL`, 0 services, warning listing what to specify.
- `https://github.com/onlyowner` → **400** with explanation. A real repo while the sandbox IP was rate-limited by GitHub → **429** "rate limit reached" (previously: "describe it instead").
- `/api/export/cft` with `environment: "test"` → 400. With a valid plan → template, `coverage` listing the VPC prerequisite, and **cfn-lint exit 0** on the downloaded YAML.
- `/api/prices` with a `null` body → 400. `ap-south-1` at 250k users → priced rows labelled `fallback@us-east-1`.
- Playwright UI run: "Mode: Rules-only" banner rendered, 20 cost rows, **no console errors**.

## 6. Security issues found and resolved

| Issue | Status |
|---|---|
| Hardcoded DB passwords in exported templates | Fixed: Secrets Manager `GenerateSecretString` + dynamic references; the validator now rejects literal passwords |
| Unbounded download of untrusted repo files | Fixed: 64 KB streaming cap |
| Unvalidated owner/repo in GitHub URLs | Fixed: strict regexes, credentials/ports rejected, segments encoded |
| Provider error text (may contain keys) returned to browser | Fixed: `redactSecrets` on logs and diagnostics |
| Over-broad SGs (EC2 port 80 from anywhere even behind an ALB; DB default SG) | Fixed: compute only from the ALB SG; data tier only from the compute SG |
| SageMaker template pointing at a full-access managed *policy* | Fixed: scoped execution role |
| Lambda trigger without least-privilege queue access | Fixed: inline policy scoped to template resources |
| Next.js critical / undici / sharp advisories | Fixed for production dependencies (`npm audit --omit=dev` = 0); 5 high remain in dev tooling (need `--force`, breaking) |
| Committed secrets / `.env` | None found (pattern scan); `.env.example` added |
| XSS / unsafe HTML | No `dangerouslySetInnerHTML`; diagram XML attributes escaped (tested with `<script>`) |

No AWS resources were created, modified or deleted; no IAM was touched. Templates were only linted.

## 7. Remaining issues (not fixed or not verifiable here)

1. **Live checks not run**: `test:baseline` (needs LLM key + GitHub API), `test:e2e-repos`, real AWS Price List responses, real LLM providers. All of these were covered with mocks only.
2. **Fallback prices**: only EC2 t3.small, Fargate, CloudFront and DynamoDB were re-verified. The others are 2024-12 references, and DocumentDB/SageMaker are flagged unverified. In bulk mode, EC2 and RDS can never be priced live (files > 8 MB), so use `PRICE_SOURCE=sdk`.
3. **Default Gemini model id** (`gemini-3.8-flash`) and the OpenRouter free model ids are unverified. Set them via env.
4. **CloudFormation**: starting templates only. No HTTPS/ACM, no NAT Gateway, placeholder container image, single-AZ RDS. EKS, DocumentDB, Bedrock, AppRunner and others are listed as unsupported. Nothing was deployed or validated by AWS (cfn-lint is a schema check).
5. **Keyword heuristics** remain in `ruleEngine.ts` (`s3`, `cdn`, `kubernetes`, `kafka`, `load balancer` in non-README files). Suspected false-positive risk; no fixture reproduced it, so it was left unchanged.
6. **Service dedupe**: two databases of the same engine become one mapping and one cost line.
7. **Build needs Google Fonts** at build time.
8. **Lint warnings**: 32 unused imports/variables.
9. **Large modules** (`diagram.ts`, `repoAnalyzer.ts`, `ruleEngine.ts`) deserve splitting. That was deliberately not done, to keep the diff reviewable.

## 8. Decisions that need your approval

Recorded as Decisions 54–61 in `DECISIONS.md`:

1. **SSR → ECS + ALB** for Next.js/Nuxt/Remix/SvelteKit without static export. Alternatives: Amplify Hosting (simpler, cheaper for small apps) or App Runner.
2. **Route 53 only with domain evidence.** One evaluation fixture expectation was changed.
3. **Cognito free tier 10,000 MAU at the Lite rate** (new pools since 2024-11-22; Essentials is the console default and costs more).
4. **CloudWatch custom metrics fixed** (not scaled with users); logs scale.
5. **API Gateway priced as HTTP API** to match the export. If you prefer REST APIs, change both the export and the price together.
6. **Serverless alternate swaps compute only** (never adds a database).
7. **Celery/Bull + Redis → no SQS.** Keep Redis (ElastiCache) as the broker; SQS is a possible alternative.
8. Whether to treat in-app JWT auth as needing Cognito at all. Currently it is a *low-confidence recommendation*.

## 9. Files changed

Modified (31): `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `DECISIONS.md`, `README.md`, `package.json` (one script), `package-lock.json`, three API routes, `page.tsx`, four components, and `src/lib/{SERVICE_DEFAULTS,architecture,cftExport,cost,diagram,inference,llmClient,patternAlternates,prices,repoAnalyzer,repoFetcher,ruleEngine}.ts`, plus four existing test files (changes explained in [TESTING_GUIDE.md](TESTING_GUIDE.md)).

Added: `src/lib/descriptionAnalyzer.ts`, `src/lib/__tests__/{auditFixes,regressionMatrix}.test.ts`, `src/lib/__tests__/fixtures/repoFixtures.ts`, `scripts/cfn-templates.ts`, `.env.example`, `docs/` (this folder).

## 10. Learning roadmap (suggested order)

1. **The contract**: `schema.ts` (`ServicePlan`), then [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md). Everything revolves around this object.
2. **One request end to end**: `app/api/analyze/route.ts` top to bottom, then run the snippet in [CODEBASE_GUIDE.md](CODEBASE_GUIDE.md).
3. **Evidence**: `repoFetcher.ts` (`selectWorkspaceAware`, `fetchRepoSignals`), then `repoAnalyzer.ts` (`analyzeProject`), then `descriptionAnalyzer.ts`.
4. **Decisions**: `ruleEngine.ts` `detectServices` with [ARCHITECTURE_RULE_ENGINE.md](ARCHITECTURE_RULE_ENGINE.md) open beside it; then `architecture.ts` `mapComponentToAws`.
5. **AI boundary**: `llmClient.ts` + [AI_INTEGRATION.md](AI_INTEGRATION.md). Notice how little the AI is trusted.
6. **Money**: `SERVICE_DEFAULTS.ts` → `prices.ts` → `cost.ts` with [COST_ESTIMATION.md](COST_ESTIMATION.md). Recompute one worked example by hand.
7. **Outputs**: `cftExport.ts` (export one template and run `cfn-lint`), then skim `diagram.ts` (`buildDiagramElements`).
8. **Tests**: read `regressionMatrix.test.ts`, then add a fixture for your own project.

AWS concepts worth studying alongside: VPC/subnets/route tables/security groups, ALB vs API Gateway, ECS on Fargate vs Lambda, RDS vs DynamoDB vs DocumentDB, CloudFront + S3 (OAC), IAM least privilege, and how AWS Price List SKUs and units work.
