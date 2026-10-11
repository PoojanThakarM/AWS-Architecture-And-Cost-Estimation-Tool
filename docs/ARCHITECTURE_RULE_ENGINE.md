# Architecture Rule Engine

The rule engine is the authority on **which AWS services** a project gets. The AI, when configured, only describes the application. Service selection then happens in one of two deterministic places:

- `ruleEngine.ts`: rules path (no AI, or AI failed)
- `architecture.ts` → `mapComponentToAws`: AI path (component → service table)

## 1. Technology detection (the evidence model)

`repoAnalyzer.ts` reads manifests and config files and produces a `ProjectProfile`:

| Field | Source examples | Evidence format |
|---|---|---|
| `languages` | `package.json`, `requirements.txt`, `pom.xml`, `go.mod` | file path |
| `frameworks` | dependency tables (`NPM_FRAMEWORK_MAP`, `PYTHON_PACKAGE_MAP`, …) | `server/package.json → dependencies.express` |
| `databases` | drivers/ORMs (`pg`, `mongoose`, `psycopg2`, …) | same |
| `infrastructure` | Dockerfile, compose, k8s, Terraform resources | file path or `main.tf → resource "aws_db_instance" "x"` |
| `awsUsage` | AWS SDK clients | `package.json → @aws-sdk/client-s3` |
| `discoveredComponents` | compose services, serverless functions, IaC, client instantiation | per-component evidence list |
| `evidenceRegister` | everything above with stable ids `ev-1…` | used to verify AI citations |

`descriptionAnalyzer.ts` produces the same shape with `origin: "description"`. It records only technologies **you named**, cites your phrase (`description: '… PostgreSQL database'`), and lists what is missing in `unresolved`.

**README prose is not evidence.** It is removed from the keyword text the rules scan (`codeOnlyText`). The `CONTRADICTORY` fixture proves this: its README claims MongoDB, Kafka and Kubernetes, but only the PostgreSQL in `package.json` is used.

## 2. Rules and service mappings (rules path)

`detectServices` in `ruleEngine.ts`, grouped:

| Concern | Rule (simplified) | Confidence |
|---|---|---|
| Serverless | Lambda handler/SAM/serverless.yml → Lambda; serverless file → API Gateway | high |
| Containers | Dockerfile/compose → ECS (+ ECR); explicit ECS/Fargate/EKS references | medium / high |
| Kubernetes | k8s manifests / EKS resources → EKS | high |
| Backend framework, no compute found | Express/Django/Spring/… → ECS + ALB | medium (inference) |
| **SSR meta-framework** (Next.js, Nuxt, Remix, SvelteKit) without `output: 'export'` | → ECS + ALB (server rendering needs a process) | medium |
| Frontend-only framework, no backend/DB | → S3 + CloudFront | medium |
| **Separate SPA + backend** (frontend and backend manifests in different directories, e.g. `client/` + `server/`) | → S3 + CloudFront for the SPA, plus the backend's own host | medium |
| Relational DB | driver + corroboration (connection string, same-language ORM, migrations, compose DB image) → RDS; engine from evidence | medium |
| MongoDB | → DocumentDB | from component |
| Redis | with connection/caching/worker evidence → ElastiCache | medium |
| Celery/Bull | → SQS **only if Redis is not already the broker** | medium |
| Kafka | → MSK | high |
| Search | OpenSearch/Elasticsearch → OpenSearch | high |
| Static-site generators | Gatsby/Hugo/Jekyll/Astro (as declared frameworks), Vite without a backend, hosting configs → S3 + CloudFront | medium |
| Route 53 | only with custom-domain evidence (CNAME file, "custom domain") | medium |
| Observability | CloudWatch when any compute exists | medium (recommendation) |
| Terraform | each `resource "aws_*"` → that service, high confidence, replaces weaker guesses | high |

Then, in order:

1. **Compute exclusivity**: exactly one compute service wins (Lambda > EKS > ECS > …, weighted by k8s/container evidence). IaC-declared pairs survive together.
2. **Negative rules** ("do not infer"): serverless-first repos don't get ECS/RDS; ML-training repos get no ingress; admin/monitoring stacks get no app tiers; pure libraries get nothing. Description profiles skip the library rule.
3. **Plan building**: components, role-based relationships, deployment model, dedupe, terminal state, schema validation.

### Relationships (data flow)

Edges are derived from **service roles**, not from component types. Every edge carries `evidence: "inferred: …"`, so the diagram draws it dashed.

```text
Route53 → (CloudFront | first ingress)          "resolves"
CloudFront → S3 (static), → ALB/APIGateway       "origin"
APIGateway → Lambda                              "invokes"
ALB/NLB → server compute                         "routes"
compute → databases/caches/search                "reads/writes"
compute → queues/streams                         "sends/receives"
compute → S3                                     "reads/writes"
ECR → container compute                          "image pull"
```

Load balancers, DNS and CDNs never connect directly to a database. The regression matrix asserts this for every fixture.

## 3. AI-path mapping (`mapComponentToAws`)

| Component type + technology | Service | Notes |
|---|---|---|
| database: dynamo / mongo / postgres / mysql / sql server | DynamoDB / DocumentDB / RDS | high |
| database: cassandra / neo4j | Keyspaces / Neptune | medium |
| database: sqlite, firebase, supabase, atlas | *(none)* | embedded or external |
| database: unidentified | RDS | **low**, "engine not identified" |
| frontend: Next/Nuxt/Remix/SvelteKit (not static export) | ECS + ALB | alternatives named |
| frontend: other | S3 + CloudFront | |
| backend/worker: ML training | SageMaker | |
| backend/worker: serverless / k8s / container / VM / unknown | Lambda+APIGW / EKS+ECR / ECS+ECR / EC2 / ECS (low) | |
| api: framework only (Express, FastAPI…) | ECS (low) + ALB | never API Gateway without serverless evidence |
| queue/messaging: Kafka / Kinesis / SNS / EventBridge / RabbitMQ / other | MSK / Kinesis / SNS / EventBridge / MQ / SQS | |
| auth: Cognito | Cognito (high) | |
| auth: Keycloak/OAuth/SSO | Cognito (medium, recommendation) | managed replacement |
| auth: Auth0/Okta/Clerk | *(none)* | external SaaS |
| auth: JWT/sessions | Cognito (**low**, recommendation) | in-app auth is equally valid |

`isMappingCompatible` then rejects impossible pairs (Kafka→SQS, Postgres→DynamoDB, Express→API Gateway, …).

## 4. Validation and explanations

- **AI citations**: on the repository path, each `evidence` entry must match a register record that supports the claimed technology (`isEvidenceSupportingComponent`). On the description path, a quoted phrase must actually be in the description. Components with no valid evidence are dropped. If all of them are dropped, the model is rejected.
- **Summary lists** (`databases`, `frameworks`, …) are filtered to entries the evidence corroborates, so an invented "DynamoDB" cannot add a service.
- **Schema gate**: `ServicePlanSchema` allows only the 155 catalogued services. If a mapped plan fails it, the result becomes an explicit placeholder plus an error diagnostic.
- **Grounding cap**: description, filename-only and unfounded results are capped at `low` confidence on both paths.
- **Every mapping** has `confidence`, `category` (repository-evidence / deployment-requirement / inference / recommendation) and an evidence sentence that the UI shows under "Inference Rationale".

## 5. Correct vs. incorrect recommendations (from the regression matrix)

| Project | Correct | Incorrect (now prohibited by tests) |
|---|---|---|
| Static React + Vite | S3 + CloudFront | Lambda, ECS, RDS, Route 53 without a domain |
| Next.js with `next start` | ECS + ALB (or Amplify/App Runner) | S3-only static hosting |
| Next.js `output: 'export'` | S3 + CloudFront | any compute |
| MERN (`client/` + `server/`) | S3 + CloudFront (client), ECS + ALB (API), DocumentDB | RDS, DynamoDB, API Gateway |
| Express + `pg` + compose | ECS + ECR + ALB, RDS (PostgreSQL) | DynamoDB, Lambda |
| FastAPI + Celery + Redis | ECS, ElastiCache | SQS (Redis is the broker), CloudFront for a "web" service |
| Serverless Framework app | Lambda, API Gateway, DynamoDB | ECS, RDS, ALB |
| README says MongoDB, manifest says `pg` | RDS | DocumentDB, MSK, EKS |
| Java CLI ("public static void main") | nothing | S3 + CloudFront "static site" |
| "Something for my college project" | nothing, INSUFFICIENT_SIGNAL, questions | any guessed service |

## 6. Known heuristic weaknesses (not yet fixed)

- Some bare keywords still count as evidence in non-README files: `s3`, `cdn`, `kubernetes`/`k8s`, `kafka`, `load balancer`. A code comment can trigger them.
- `dedupe by service`: two separate PostgreSQL databases become one RDS mapping (and one cost row).
- No traffic, data-size or availability requirements are inferred; Multi-AZ is a recommendation flag only.
