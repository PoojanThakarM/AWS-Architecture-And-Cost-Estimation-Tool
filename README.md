# AWS Architect

Paste a GitHub repo URL or describe a project idea, get back an AWS architecture: a deployment diagram, a monthly cost estimate, and a downloadable CloudFormation template.

## What it does

1. **Input** — a public GitHub repo URL or a freeform text description.
2. **Evidence extraction** — for repo input, fetches README + key manifest/container/CI/IaC files (bounded: 60 files, 64 KB/file) via GitHub REST. No full clone. Missing/private/rate-limited repos get a clear error. For description input, `descriptionAnalyzer.ts` extracts only the technologies you name, each citing your phrase.
3. **Inference** — single path. With an AI provider configured, the LLM describes the *application* (components + evidence citations); citations are verified, then `architecture.ts` maps it to AWS services deterministically. Without a provider (or if it fails), the deterministic rule engine answers. The UI always shows which mode ran: **AI-enhanced**, **Rules-only**, or **AI failed — rules baseline used**.
4. **Diagram** — a `.drawio` (mxGraph XML) deployment diagram, generated deterministically from the validated plan, viewable/downloadable via an embedded draw.io workspace.
5. **Cost** — a monthly *estimate* (not a bill) from the AWS Price List API when reachable, otherwise clearly labelled us-east-1 reference prices. Every row states its unit, price unit, source, region and exclusions; services that cannot be priced are listed, never shown as $0.
6. **Export** — a CloudFormation (YAML) starting template generated from the same validated plan (no hardcoded secrets; passes cfn-lint offline). Services without a CFN mapping are listed in the template metadata.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Vercel AI SDK v7 (`generateObject`) + zod 4, providers: Google Gemini → OpenRouter (failover)
- `@aws-sdk/client-pricing` for the optional SDK pricing path
- draw.io iframe embed for diagram rendering/editing
- (Login/saved history from the original plan is **not implemented** in this codebase.)

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The app runs fully with zero configuration — the rule engine needs no API keys. Copy `.env.example` to `.env.local` to enable optional features:

```bash
GOOGLE_API_KEY=...        # or GOOGLE_GENERATIVE_AI_API_KEY; model via GOOGLE_MODEL
OPENROUTER_API_KEY=...    # models via OPENROUTER_MODELS
GITHUB_TOKEN=...          # 60 → 5,000 GitHub requests/hour
PRICE_SOURCE=sdk          # optional; needs AWS credentials with pricing:GetProducts
```

DeepSeek and Groq are not implemented (earlier docs listed them). See `docs/ENVIRONMENT_SETUP.md`.

## Testing

```bash
npm test                         # 353 offline tests (node:test), incl. the regression matrix
npx tsc --noEmit                 # type check (clean)
npm run lint                     # 0 errors
npm run cfn:templates            # write fixture templates to out/cfn, then: cfn-lint out/cfn/*.yaml
npm run test:baseline -- --rules-only   # live 8-repo diagnostic (needs GitHub API access)
```

Full guide: `docs/TESTING_GUIDE.md`. Audit results: `docs/BUG_FIX_REPORT.md`.

## Scope

This is Module A (AI Architecture Advisor) only. In scope: architecture inference, diagram generation, cost estimation, CloudFormation export. Out of scope: in-app diagram editing, public shared links, full source-code scanning (evidence extraction only, never a clone), CI/CD pipeline automation, multi-tenant production hosting.

See `docs/` for the learning guide (start with `docs/PROJECT_OVERVIEW.md`), `DECISIONS.md` for the decision log, `FLOW.md` for the stage-by-stage pipeline contract.