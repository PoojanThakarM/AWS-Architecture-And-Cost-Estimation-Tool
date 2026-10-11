# Cost Estimation

> An estimate for planning, **not a bill**. Real charges depend on region, configuration, utilisation, data transfer, taxes, discounts and free-tier eligibility.

## Pipeline

```mermaid
flowchart LR
  SP[ServicePlan] --> L[linesFor(service)<br/>primary + extraLines]
  L --> P[getUnitPrice<br/>live → fallback → null]
  P -->|price| R[CostRow]
  P -->|null| U[UnpricedRow]
  NC[NO_CHARGE_SERVICES<br/>VPC, IAM, CloudFormation…] --> U
  R --> T[totalMonthlyUsd = Σ rows]
```

Files: `SERVICE_DEFAULTS.ts` (what is used), `prices.ts` (what it costs), `cost.ts` (the arithmetic).

## Pricing data sources

1. **Live, bulk mode (default)**: the public AWS Price List file `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<serviceCode>/current/<region>/index.json`. A SKU is chosen by `usagetype` prefix plus optional attribute filters (`databaseEngine`, `deploymentOption`, `operatingSystem`, …). For tiered prices, the **first paid tier** (lowest `beginRange`) is used. Files over 8 MB are skipped (EC2 and RDS index files are hundreds of MB). This used to fail silently with a truncated `JSON.parse`; now it is a clean "no live price".
2. **Live, SDK mode** (`PRICE_SOURCE=sdk`): `@aws-sdk/client-pricing` `GetProducts`, which needs credentials with `pricing:GetProducts` only. This is the practical way to get live EC2/RDS prices.
3. **Fallback**: `FALLBACK_PRICES` (us-east-1 reference values). Every fallback row is labelled with `priceRegion: "us-east-1"` and a `fallbackStatus`:
   - `verified-2026-10`: checked against published AWS pricing in this audit (EC2 t3.small, Fargate vCPU/GB, CloudFront US egress, DynamoDB on-demand)
   - `reference`: the original 2024-12 figures, not re-verified
   - `unverified`: known to be doubtful (DocumentDB, SageMaker)
4. **No price**: if neither live nor fallback exists, the service goes to `unpricedRows` with a reason, **never $0**.

Caching: live prices for 24 h, fallbacks for 10 min (so a transient outage is retried), keyed by mode + region + line.

## Units and conversion

`unitPrice` is always expressed in **the row's own unit**, and `priceUnit` says which:

| Service line | Quantity unit | Price unit | Live conversion |
|---|---|---|---|
| Lambda | GB-seconds | per GB-second | ×1 |
| Lambda (requests) | millions of requests | per million | ×1,000,000 (Price List is per request) |
| API Gateway | millions of HTTP API calls | per million | ×1,000,000 |
| SQS / SNS / EventBridge | millions | per million | ×1,000,000 |
| ECS / Fargate | vCPU-hours; (memory) GB-hours | per hour | ×1 |
| EC2 / RDS / ElastiCache / ALB / NAT / EKS | hours | per hour | ×1 |
| S3 / EBS / EFS / ECR / RDS storage | GB-months | per GB-month | ×1 |
| CloudFront | GB | per GB | ×1 |
| DynamoDB | request units | per request unit | ×1 |
| Cognito | MAU | per MAU | ×1 |

Before the audit, the live path for request-based services was off by 10⁶ (5M API calls → $0.0000175).

## Formulas

For each billing line:

```text
usageQuantity    = baseQuantity × (fixed ? 1 : userCount / 10,000)
billableQuantity = max(usageQuantity − freeTierQuantity, 0)
monthlyUsd       = unitPrice × billableQuantity
total            = Σ monthlyUsd          (rounded only when displayed)
```

- `fixed` lines are provisioned capacity (instances, clusters, load balancers, hosted zones, storage you allocate, CloudWatch custom metrics). They don't scale with users.
- Free tiers are applied **only** where `freeTierQuantity` is set (currently Cognito: 10,000 MAU for user pools created after 2024-11-22). Elsewhere the always-free allowances (Lambda 400k GB-s/1M requests, SQS 1M, CloudFront 1 TB) are **not** applied, and each row's `excludes` says so.
- The browser's user slider uses `scaleCostRows`, which rescales `usageQuantity` and re-applies the free tier, so it matches the server exactly. A test checks this at 5k, 100k and 200k users.

## Usage assumptions (baseline = 10,000 monthly active users)

| Service | Baseline |
|---|---|
| Lambda | 5M invocations × 200 ms × 512 MB = 500,000 GB-s, + 5M requests |
| ECS/Fargate | 2 tasks × 0.5 vCPU × 1 GB × 720 h |
| EC2 | 1 × t3.small Linux × 720 h |
| RDS | 1 × db.t3.micro Single-AZ × 720 h (engine from evidence) + 20 GB gp2 |
| DynamoDB | 1M reads + 250k writes (on-demand) |
| S3 | 50 GB Standard |
| CloudFront | 100 GB US egress |
| API Gateway | 5M HTTP API calls |
| ALB | 1 × 720 h (LCU excluded) |
| CloudWatch | 10 custom metrics (fixed) + 5 GB logs (scales) |
| MSK | 2 × kafka.m5.large brokers × 720 h |
| Cognito | MAU = user count, 10k free |

Global assumptions are returned in `cost_rows.assumptions` and shown under "Cost assumptions".

## Regional pricing

- Live prices are fetched per region.
- Fallbacks are us-east-1 values used everywhere, and the UI labels them `fallback · us-east-1`. In the sandbox used for the audit there was no network, so every row was a fallback. Expect different live numbers in other regions.

## Worked examples (us-east-1 fallbacks, 10,000 users)

**Serverless API (Lambda + API Gateway + DynamoDB)**

```text
Lambda compute   500,000 GB-s × $0.0000166667   = $8.33
Lambda requests  5 M × $0.20/M                    = $1.00
API Gateway      5 M × $1.00/M                    = $5.00
DynamoDB reads   1,000,000 × $0.000000125         = $0.125
DynamoDB writes  250,000 × $0.000000625           = $0.156
                                          total  ≈ $14.61
```

**Container app (ECS + ALB + RDS PostgreSQL)**

```text
ECS vCPU     720 × $0.04048     = $29.15
ECS memory   1,440 × $0.004445  = $6.40
ALB          720 × $0.0225      = $16.20
RDS PG       720 × $0.018       = $12.96
RDS storage  20 × $0.115        = $2.30
                       total   = $67.01  (+ ECR, CloudWatch if present)
```

**Cognito at 200,000 users**: (200,000 − 10,000) × $0.0055 = $1,045.00.

## Limitations

- Fixed baselines, not your real traffic. Use the slider as a scale knob, not as a forecast.
- Data transfer, NAT data processing, ALB LCUs, request charges for some services, backups, taxes, Support and Savings Plans are excluded.
- Each service is priced once even if two components map to it (two databases → one RDS line).
- Most fallback values are `reference` (2024-12) and must be checked against the AWS Pricing Calculator before you rely on them.
