# Environment Setup

## Required software

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 LTS (tested on 22.22.0) | Next.js 16, `--experimental-strip-types` for tests |
| npm | 10+ | lockfile v3 |
| Git | any | |
| Python 3 + `cfn-lint` | optional | `pip install cfn-lint` to lint exported templates |

## Installation

```bash
git clone https://github.com/Jaimin-chavda/AWS-Architecture-And-Cost-Estimation-Tool.git
cd AWS-Architecture-And-Cost-Estimation-Tool
npm ci                 # exact versions from package-lock.json
cp .env.example .env.local   # optional
npm test               # 353 tests, offline
npm run dev            # http://localhost:3000
```

## Environment variables

All are optional. With none set, the app runs in **rules-only** mode with fallback prices.

| Variable | Purpose | Notes |
|---|---|---|
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | Enables Gemini (AI-enhanced mode) | First non-blank wins |
| `GOOGLE_MODEL` | Gemini model id | Default `gemini-3.8-flash` is **unverified**, so set one your key can use |
| `OPENROUTER_API_KEY` | Enables OpenRouter failover | |
| `OPENROUTER_MODELS` | Comma-separated model ids | Defaults to free models in `llmClient.ts` |
| `GITHUB_TOKEN` | GitHub REST 60 → 5,000 req/h | Use a fine-grained, read-only token. Never commit it. |
| `PRICE_SOURCE` | `bulk` (default) or `sdk` | `sdk` needs AWS credentials |
| `AWS_PRICING_REGION` | Price List API endpoint region | `us-east-1` (default) or `ap-south-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Only for `PRICE_SOURCE=sdk` | Use an IAM identity allowed **only** `pricing:GetProducts` (+ `pricing:DescribeServices`) |

`.env*` files are git-ignored (except `.env.example`). `DEEPSEEK_API_KEY` and `GROQ_API_KEY` do nothing: those providers are not implemented.

## Local execution

```bash
npm run dev            # development server
npm run build && npm start   # production
```

API smoke test:

```bash
curl -s -X POST localhost:3000/api/analyze -H 'content-type: application/json' \
  -d '{"input":{"kind":"description","value":"Express API with PostgreSQL in Docker"}}' | head -c 400
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run build` fails: "Failed to fetch Geist from Google Fonts" | Build machine is offline. Allow fonts.googleapis.com, or switch `src/app/layout.tsx` to `next/font/local`. |
| "GitHub API rate limit reached" (HTTP 429) | 60 unauthenticated requests/hour per IP. Set `GITHUB_TOKEN`. |
| "Repository not found" (404) for a repo you can see | It is private. Private repositories are not supported. |
| Banner says "AI failed — rules baseline used" | Open "Show pipeline diagnostics": usually an invalid key, a wrong model id (`GOOGLE_MODEL`), or a 429 from the provider. |
| All cost rows say `fallback · us-east-1` | No network to the Price List, or the service's bulk file is over 8 MB (EC2/RDS). Use `PRICE_SOURCE=sdk` with read-only pricing credentials. |
| A service appears under "Not included in the total" | No pricing baseline, no live price and no reference price, or the service has no charge (VPC, IAM). |
| Tests fail with `ERR_MODULE_NOT_FOUND` for a `.ts` import | Run them with `node --experimental-strip-types` (Node 22+), as `npm test` does. |
| `cfn-lint` warns "Parameter … not used" | Only for placeholder templates (no supported services in the plan). This is expected. |
