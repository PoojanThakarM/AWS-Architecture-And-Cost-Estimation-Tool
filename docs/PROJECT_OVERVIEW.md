# Project Overview — AWS Architect (Module A: AI Architecture Advisor)

## The problem

Students and small teams often know *what* they built (a React app, an Express API, a Postgres database) but not *how* to put it on AWS, or what that would cost. Reading a codebase and turning it into a sensible AWS architecture, a diagram, a price and an infrastructure template takes real cloud experience.

This tool does that first pass for you. You give it a public GitHub repository or a short description, and it gives back:

1. the AWS services your application actually needs, each with the evidence that justifies it,
2. a draw.io architecture diagram,
3. a monthly cost estimate you can scale by user count and region,
4. a CloudFormation starting template.

## Objectives

- **Evidence first.** Every recommended service points to something real: a dependency, a config file, an IaC resource, or a phrase you wrote.
- **Deterministic service selection.** An AI model may *describe* the application, but AWS services are always chosen by explicit rules (`architecture.ts`, `ruleEngine.ts`).
- **One model, four outputs.** The diagram, the cost estimate and the CloudFormation template are all generated from the same validated `ServicePlan`, so they cannot disagree.
- **Honest uncertainty.** Description-only results are capped at low confidence. Unknown prices are listed as unpriced instead of $0. The UI shows whether AI was used.

## Users and use cases

| User | Use case |
|---|---|
| Student / developer | "I have this repo, how would I host it on AWS and what will it cost?" |
| Team in a design review | Compare the primary architecture with a curated alternative (e.g. containers vs. serverless) and their costs. |
| Instructor | Show how application evidence maps to cloud services, with the reasoning visible. |

## Current features (as implemented)

- GitHub input: up to 60 key files (README, manifests, Docker/Compose, CI, IaC), 64 KB each, via GitHub REST. Missing, private, empty and rate-limited repositories each get a specific error.
- Description input: a deterministic analyzer extracts the technologies you name, and lists what you left open (for example, which database).
- Inference modes: **AI-enhanced** (Google Gemini or OpenRouter), **Rules-only** (no key configured), or **AI failed — rules baseline used**. The mode is shown in the UI and the API response.
- Diagram: deterministic mxGraph XML with tiers (edge, public, compute, data, cross-cutting, external). Edges inferred from service roles are dashed.
- Cost: AWS Price List lookup with labelled us-east-1 fallbacks, multiple billing lines per service, free tiers applied only where a row says so, and client-side rescaling that matches the server.
- CloudFormation: a cfn-lint-clean template with a VPC prerequisite, generated DB secrets, least-privilege security groups and IAM, plus a list of the services it does not cover.
- Curated alternate proposal for some patterns (serverless OLTP vs. analytics pipeline; containers vs. serverless).

## Limitations (be aware of these)

- **Not a bill.** On-demand rates, fixed usage baselines, and most data transfer excluded. Fallback prices are us-east-1 references, and most were not re-verified in this audit.
- **Not a deployment.** Templates are starting points. There is no HTTPS listener, no NAT Gateway, and a placeholder container image. Nothing has been deployed or validated by AWS itself.
- **Evidence is partial.** Only ~60 key files are read, never the full source, so business logic, traffic volume and data size are unknown.
- **Keyword heuristics remain** in parts of the rule engine (for example, the word `kubernetes` in a code comment can suggest EKS).
- **Not implemented**, despite earlier docs: login/saved history (better-auth), DeepSeek and Groq providers, live cost monitoring, security scanning, resource optimisation (Modules B–D are descoped).

## Where to go next

- How the pieces fit: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)
- Reading the code: [CODEBASE_GUIDE.md](CODEBASE_GUIDE.md)
- What was fixed in the audit: [BUG_FIX_REPORT.md](BUG_FIX_REPORT.md)
