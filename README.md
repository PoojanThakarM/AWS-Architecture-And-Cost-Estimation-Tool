# AWS Architect

Paste a GitHub repo URL or describe a project idea, get back an AWS architecture: a deployment diagram, a monthly cost estimate, and a downloadable CloudFormation template.

## What it does

1. **Input** — a public GitHub repo URL or a freeform text description.
2. **Evidence extraction** — for repo input, fetches README + key manifest/container/CI files (bounded: 20 files, 64KB/file) via GitHub REST. No full clone.
3. **Inference** — a deterministic rule engine (keyword scoring) produces a baseline `ServicePlan`; an LLM (DeepSeek, with Gemini Flash / Groq as fallbacks) enhances it. LLM output is validated against a 155-service AWS catalog allowlist — nothing gets to the diagram or cost estimate without passing that gate. No configured LLM key → rules-only baseline, app still works.
4. **Diagram** — a `.drawio` (mxGraph XML) deployment diagram, generated deterministically from the validated plan, viewable/downloadable via an embedded draw.io workspace.
5. **Cost** — a monthly cost estimate from the real AWS Price List API (public bulk JSON by default; `@aws-sdk/client-pricing` as an optional IAM-credentialed path), with a region picker and a 100–1M user-count slider that recalculates client-side.
6. **Export** — a deployable CloudFormation (YAML) template generated from the same validated plan.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Vercel AI SDK v7 (`generateObject`) + zod 4, providers: DeepSeek → Google Gemini Flash → Groq
- `@aws-sdk/client-pricing` for the optional SDK pricing path
- `better-auth` + `better-sqlite3` for optional login and saved-history (guest usage requires neither)
- draw.io iframe embed for diagram rendering/editing

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The app runs fully as a guest with zero configuration — the rule-engine baseline needs no API keys. To enable LLM-enhanced inference, set one of:

```bash
DEEPSEEK_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
GROQ_API_KEY=...
```

Optional: `GITHUB_TOKEN` raises the GitHub REST rate limit from 60/hr to 5,000/hr. `PRICE_SOURCE=sdk` (plus AWS IAM credentials) switches the cost engine from the public bulk-pricing JSON to the official `@aws-sdk/client-pricing` API.

## Testing

```bash
npm test            # Node's built-in test runner, src/lib/__tests__/*.test.ts
npm run test:baseline  # accuracy check against a fixed multi-repo benchmark
```

## Scope

This is Module A (AI Architecture Advisor) only. In scope: architecture inference, diagram generation, cost estimation, CloudFormation export. Out of scope: in-app diagram editing, public shared links, full source-code scanning (evidence extraction only, never a clone), CI/CD pipeline automation, multi-tenant production hosting.

See `DECISIONS.md` for the full decision log and rationale, `FLOW.md` for the stage-by-stage pipeline contract.