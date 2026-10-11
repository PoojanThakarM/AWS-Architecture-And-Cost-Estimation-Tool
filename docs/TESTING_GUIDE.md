# Testing Guide

## Commands

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | All 16 `node:test` suites (353 tests) | nothing (offline) |
| `npx tsc --noEmit` | Type check of app + libs (tests excluded by tsconfig) | nothing |
| `npm run lint` | ESLint (next/core-web-vitals + TS). Currently 0 errors, 32 warnings (unused imports) | nothing |
| `npm run cfn:templates` then `cfn-lint out/cfn/*.yaml` | Writes a template per regression fixture; cfn-lint validates them against the CloudFormation schema | `pip install cfn-lint` |
| `npm run build` | Production build incl. type check | network to fonts.googleapis.com (`next/font/google`) |
| `npm run test:baseline -- --rules-only` | Live 8-repo diagnostic, rules engine | GitHub API access (+ `GITHUB_TOKEN` advisable) |
| `npm run test:baseline` | Same, rules vs. AI column | GitHub + an LLM key; hard-fails without a key by design |
| `npm run test:e2e-repos` | Live 10-repo evaluation (`scripts/e2e-test/run.ts`) | network |

Run a single suite:

```bash
node --experimental-strip-types --test src/lib/__tests__/regressionMatrix.test.ts
```

## Test architecture

| Suite | Tests | Focus |
|---|---|---|
| `regressionMatrix.test.ts` | 18 | **Phase K matrix**: fixtures A–J through the whole offline pipeline; property assertions |
| `auditFixes.test.ts` | 54 | One `describe` per audit bug (BUG-01…BUG-16) |
| `ruleEngine.test.ts` | 38 | Rule-engine detection, terminal states |
| `diagram.test.ts` | 80 | Layout, containment, edges, semantics |
| `architecture.test.ts` | 22 | AI-model normalisation + mapping |
| `stage1Regression.test.ts` / `stage1Generalization.test.ts` / `masterFixes.test.ts` | 21 / 20 / 17 | Earlier benchmark repos as fixtures |
| `prices.test.ts` | 17 | Price lookup, fallback, SDK path (mocked client) |
| `cftExport.test.ts` | 15 | Templates per pattern, validator |
| `repoFetcher.test.ts` / `fetchCoverage.test.ts` | 15 / 4 | File selection |
| `patternAlternates.test.ts` | 11 | Curated alternates |
| `inference.test.ts`, `ecosystemParsers.test.ts`, `llmPrompt.test.ts` | 10 / 9 / 2 | Grounding, parsers, prompt shape |

### Principles

- **No network, no paid AI, no AWS.** `globalThis.fetch` is replaced with mocks; LLMs are `MockLanguageModelV4` from `ai/test`, injected via `runInference({ llmProviders })`.
- **Properties, not strings.** The matrix accepts any of several valid architectures (`required: [["ECS","Fargate","AppRunner",…]]`) and lists prohibited services instead of matching exact output.
- **Hand-computed numbers.** Cost tests write the arithmetic in comments (e.g. `500,000 GB-s × $0.0000166667 = $8.33335`).

## Fixtures

`src/lib/__tests__/fixtures/repoFixtures.ts` holds `RepoSignals` objects exactly as the fetcher would return them:

| Id | Fixture | Expected (acceptable) | Prohibited |
|---|---|---|---|
| A | `STATIC_REACT` (React + Vite) | S3, CloudFront | any compute, RDS, ALB, Route 53 |
| B | `NEXT_SSR` (`next start`, API route) | one compute host | RDS, DynamoDB, API Gateway |
| B2 | `NEXT_STATIC_EXPORT` (`output: 'export'`) | S3, CloudFront | compute, ALB |
| C | `MERN` (`client/` + `server/`) | DocumentDB, compute, S3, CloudFront | RDS, DynamoDB, API Gateway |
| D | `NODE_PG` (Express + pg + compose) | RDS/Aurora, compute | DynamoDB, DocumentDB, Lambda |
| E | `DJANGO_PG` | RDS/Aurora, compute | DynamoDB, DocumentDB |
| F | `COMPOSE_WORKER` (FastAPI + Celery + Redis) | ElastiCache, ECS | SQS, CloudFront, RDS |
| G | `SERVERLESS_AWS` (serverless.yml) | Lambda, API Gateway, DynamoDB | ECS, EC2, RDS, ElastiCache, ALB |
| H | `CONTRADICTORY` (README MongoDB/Kafka/K8s vs `pg`) | RDS | DocumentDB, MSK, EKS |
| — | `JAVA_CLI` ("public static void main") | nothing | S3, CloudFront, Route 53 |
| I | invalid / nonexistent URLs | rejected before requests; 404 after **one** request | — |
| J | ambiguous / explicit descriptions | INSUFFICIENT_SIGNAL with questions; full plan for explicit ones | invented services |

Every matrix case also checks these invariants:

- diagram nodes = plan services
- no ingress/DNS/CDN → database edges
- every diagram edge has both ends
- every service is either priced (price > 0) or listed as unpriced
- the total equals the sum of rows
- the CloudFormation template validates and lists every service as rendered or unsupported
- no hardcoded passwords

## Regression tests per confirmed bug

See the `BUG-xx` headers in `auditFixes.test.ts` and the table in [BUG_FIX_REPORT.md](BUG_FIX_REPORT.md). Some older tests encoded defective behaviour and were updated. Each change is commented in place:

- `prices.test.ts`: four pinned fallback prices corrected (EC2, DynamoDB, CloudFront, API Gateway); row counts 3 → 5 because of the extra billing lines.
- `ruleEngine.test.ts`: an empty *description* is `INSUFFICIENT_SIGNAL`, not `LIBRARY_REPO`.
- `stage1Generalization.test.ts`: Astro static site no longer requires Route 53 without a domain.
- `stage1Regression.test.ts`: the dedupe test uses a React SPA; the Kuzma02 Next.js App Router frontend now maps to compute.

## Manual verification steps

1. `npm run dev`, open http://localhost:3000.
2. **Description, rules-only**: paste "A simple React frontend with a Node.js Express backend API connected to a PostgreSQL database". Expect the banner "Mode: Rules-only", services RDS, ECS, ALB, S3, CloudFront, CloudWatch (all *low*), and a warning that the result is description-only.
3. **Vague description**: "Something for my college project" → no services, plus a warning listing what to specify.
4. **Bad URL**: `https://github.com/onlyowner` → HTTP 400 with an explanation. A nonexistent repo → 404 "Repository not found…".
5. **Cost tab**: check that each row shows unit, price unit, `fallback · us-east-1` or `live aws`, and its exclusions. Move the slider to 200k and check the total changes smoothly. Change the region and check the rows re-fetch.
6. **CloudFormation**: download it, run `cfn-lint template.yaml`, and expect no errors. A Bedrock-only plan should produce a placeholder plus a `NOT INCLUDED` comment.
7. **AI mode** (with a key): expect the "AI-enhanced" banner. Then set an invalid key and expect "AI failed — rules baseline used" with expandable diagnostics and no key visible.

These steps 2–6 were performed against a production build during the audit (see the BUG_FIX_REPORT evidence). Step 7 needs a real key and was covered only with mocked providers.
