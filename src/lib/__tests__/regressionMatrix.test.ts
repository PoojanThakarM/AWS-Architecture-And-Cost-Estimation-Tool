/**
 * regressionMatrix.test.ts — Phase K regression matrix.
 *
 * Every case runs the REAL offline pipeline on a controlled fixture:
 *   fixture → analyzeProject / analyzeDescription → runInference (rules)
 *           → diagram → cost → CloudFormation
 * and asserts architectural PROPERTIES rather than exact output strings:
 *   - required services (any one of each "acceptable" group must be present)
 *   - prohibited services (must never appear)
 *   - diagram ⊆ plan and plan ⊆ diagram
 *   - no impossible data-flow edges (load balancer / DNS "reading" a database)
 *   - every priced cost row has a positive price; unpriceable services are
 *     listed, not shown as $0
 *   - the CloudFormation export validates and accounts for every service
 *
 * No network, no LLM keys, no AWS account. Run:
 *   node --experimental-strip-types --test src/lib/__tests__/regressionMatrix.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { REPO_FIXTURES } from "./fixtures/repoFixtures.ts";
import { analyzeProject } from "../repoAnalyzer.ts";
import type { ProjectProfile } from "../repoAnalyzer.ts";
import { analyzeDescription } from "../descriptionAnalyzer.ts";
import { signalsToRuleInput, parseGitHubRepoUrl, fetchRepoSignals } from "../repoFetcher.ts";
import type { RepoSignals } from "../repoFetcher.ts";
import { runInference, deriveGrounding } from "../inference.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { buildDiagramElements, generateSingleDiagramXml } from "../diagram.ts";
import { computeCostRows } from "../cost.ts";
import { clearPriceCache } from "../prices.ts";
import { generateCftYaml, validateCloudFormationTemplate, cftCoverage } from "../cftExport.ts";
import type { ServicePlan } from "../schema.ts";

// All price lookups must use the offline fallback path.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => {
    throw new Error("network disabled in regression matrix");
  }) as typeof fetch;
  clearPriceCache();
});
after(() => {
  globalThis.fetch = realFetch;
  clearPriceCache();
});

async function planForRepo(signals: RepoSignals) {
  const profile = analyzeProject(signals);
  const grounding = deriveGrounding({ fetchedFiles: signals.keyFiles });
  const ruleInput = signalsToRuleInput(signals, "github_url", grounding);
  const result = await runInference({ ruleInput, signals, description: "", profile, llmProviders: [] });
  return { ...result, profile };
}

async function planForDescription(text: string) {
  const profile = analyzeDescription(text);
  const ruleInput: RuleInput = {
    description: text,
    fileContent: "",
    fileNames: [],
    inputKind: "description",
    grounding: "description",
    truncated: false,
    parseErrors: [],
    profile,
  };
  const result = await runInference({ ruleInput, signals: null, description: text, profile, llmProviders: [] });
  return { ...result, profile };
}

const services = (plan: ServicePlan) => new Set(plan.awsMappings.map((m) => m.serviceId as string));

const COMPUTE = ["ECS", "Fargate", "EKS", "EC2", "Lambda", "AppRunner", "ElasticBeanstalk", "Lightsail"];
const INGRESS_OR_DNS = new Set(["ALB", "NLB", "APIGateway", "Route53", "CloudFront"]);
const DATA = new Set(["RDS", "Aurora", "DynamoDB", "DocumentDB", "ElastiCache", "OpenSearch", "Redshift"]);

interface Expectation {
  /** Each inner array is a set of acceptable alternatives; one must be present. */
  required: string[][];
  prohibited: string[];
  terminalState?: string;
}

/** Shared invariants every plan must satisfy, whatever the architecture. */
async function assertPlanInvariants(name: string, plan: ServicePlan, sdk?: RepoSignals["sdkEvidence"]) {
  const svc = services(plan);

  // 1. Diagram represents exactly the plan's services.
  const { nodes, routedEdges } = buildDiagramElements(plan, sdk ?? null);
  const nodeServices = new Set(nodes.map((n) => n.serviceId as string));
  assert.deepEqual([...nodeServices].sort(), [...svc].sort(), `${name}: diagram nodes must equal plan services`);
  const xml = generateSingleDiagramXml(plan, sdk ?? null);
  assert.ok(xml.startsWith("<?xml") && xml.trim().endsWith("</mxfile>"), `${name}: diagram XML must be complete`);

  // 2. No impossible flows: ingress/DNS/CDN never talk to a data store directly.
  const svcOfComp = new Map(plan.awsMappings.map((m) => [m.componentId, m.serviceId as string]));
  for (const r of plan.relationships) {
    const from = svcOfComp.get(r.from);
    const to = svcOfComp.get(r.to);
    if (from && to) {
      assert.ok(
        !(INGRESS_OR_DNS.has(from) && DATA.has(to)),
        `${name}: impossible edge ${from} → ${to} (${r.type})`
      );
    }
  }
  // Edges in the diagram reference existing nodes.
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of routedEdges) {
    assert.ok(nodeIds.has(e.sourceId) && nodeIds.has(e.targetId), `${name}: dangling diagram edge`);
  }

  // 3. Cost: priced rows have positive prices; every service is either
  //    priced or explicitly listed as unpriced.
  const cost = await computeCostRows(plan, "us-east-1", 10_000);
  for (const row of cost.rows) {
    assert.ok(row.unitPrice > 0, `${name}: ${row.serviceId} priced at ${row.unitPrice}`);
    assert.ok(Number.isFinite(row.monthlyUsd) && row.monthlyUsd >= 0);
  }
  const accounted = new Set([...cost.rows.map((r) => r.serviceId), ...cost.unpricedRows.map((u) => u.serviceId)]);
  for (const s of svc) assert.ok(accounted.has(s), `${name}: ${s} missing from cost output`);
  const total = cost.rows.reduce((a, r) => a + r.monthlyUsd, 0);
  assert.ok(Math.abs(total - cost.totalMonthlyUsd) < 1e-9, `${name}: total must equal the sum of rows`);

  // 4. CloudFormation export is valid and accounts for every plan service.
  const yaml = generateCftYaml(plan);
  const v = validateCloudFormationTemplate(yaml);
  assert.ok(v.valid, `${name}: CFN invalid: ${v.errors.join("; ")}`);
  const cov = cftCoverage([...svc]);
  assert.deepEqual(
    [...cov.rendered, ...cov.unsupported].sort(),
    [...svc].sort(),
    `${name}: every service must be rendered or listed as unsupported`
  );
  assert.ok(!/MustBeChanged|MasterUserPassword:\s+[A-Za-z0-9!]+\s*$/m.test(yaml), `${name}: hardcoded password`);
}

const REPO_CASES: Array<[string, RepoSignals, Expectation]> = [
  ["A. static React site", REPO_FIXTURES.STATIC_REACT, {
    required: [["S3"], ["CloudFront"]],
    prohibited: [...COMPUTE, "RDS", "DynamoDB", "ALB", "APIGateway", "Route53"],
  }],
  ["B. Next.js with SSR", REPO_FIXTURES.NEXT_SSR, {
    required: [["ECS", "Fargate", "AppRunner", "Lambda", "EC2", "Amplify"]],
    prohibited: ["RDS", "DynamoDB", "DocumentDB", "APIGateway"],
  }],
  ["B2. Next.js static export", REPO_FIXTURES.NEXT_STATIC_EXPORT, {
    required: [["S3"], ["CloudFront"]],
    prohibited: [...COMPUTE, "ALB", "RDS"],
  }],
  ["C. MERN", REPO_FIXTURES.MERN, {
    required: [["DocumentDB"], ["ECS", "Fargate", "EC2", "AppRunner"], ["S3"], ["CloudFront"]],
    prohibited: ["RDS", "Aurora", "DynamoDB", "APIGateway"],
  }],
  ["D. Node.js API + PostgreSQL", REPO_FIXTURES.NODE_PG, {
    required: [["RDS", "Aurora"], ["ECS", "Fargate", "EC2", "AppRunner"]],
    prohibited: ["DynamoDB", "DocumentDB", "Lambda", "APIGateway"],
  }],
  ["E. Django + PostgreSQL", REPO_FIXTURES.DJANGO_PG, {
    required: [["RDS", "Aurora"], ["ECS", "Fargate", "EC2", "AppRunner", "ElasticBeanstalk"]],
    prohibited: ["DynamoDB", "DocumentDB"],
  }],
  ["F. docker-compose web + Celery/Redis worker", REPO_FIXTURES.COMPOSE_WORKER, {
    required: [["ElastiCache"], ["ECS", "Fargate", "EKS"]],
    // Redis is already the Celery broker; a "web" service is not a CDN frontend.
    prohibited: ["SQS", "CloudFront", "RDS", "DynamoDB"],
  }],
  ["G. existing serverless AWS app", REPO_FIXTURES.SERVERLESS_AWS, {
    required: [["Lambda"], ["APIGateway"], ["DynamoDB"]],
    prohibited: ["ECS", "EKS", "EC2", "RDS", "ElastiCache", "ALB"],
  }],
  ["H. contradictory README vs manifests", REPO_FIXTURES.CONTRADICTORY, {
    required: [["RDS", "Aurora"]],
    // README-only claims (MongoDB, Kafka, Kubernetes) must not become services.
    prohibited: ["DocumentDB", "MSK", "EKS"],
  }],
  ["Java CLI with 'static' keyword", REPO_FIXTURES.JAVA_CLI, {
    required: [],
    prohibited: ["S3", "CloudFront", "Route53"],
  }],
];

describe("Regression matrix — repository fixtures (rules engine, offline)", () => {
  for (const [name, signals, exp] of REPO_CASES) {
    it(name, async () => {
      const { plan, engine } = await planForRepo(signals);
      assert.equal(engine, "rules", "no LLM provider is injected, so the mode must be rules-only");
      const svc = services(plan);
      for (const group of exp.required) {
        assert.ok(group.some((s) => svc.has(s)), `${name}: expected one of [${group}] — got [${[...svc]}]`);
      }
      for (const s of exp.prohibited) {
        assert.ok(!svc.has(s), `${name}: prohibited ${s} present — got [${[...svc]}]`);
      }
      if (exp.terminalState) assert.equal(plan.terminalState, exp.terminalState);
      await assertPlanInvariants(name, plan, signals.sdkEvidence);
    });
  }

  it("D. PostgreSQL is priced as PostgreSQL, not MySQL", async () => {
    const { plan } = await planForRepo(REPO_FIXTURES.NODE_PG);
    assert.equal(plan.metadata.dbEngine, "postgres");
    const cost = await computeCostRows(plan, "us-east-1", 10_000);
    const rds = cost.rows.find((r) => r.serviceId === "RDS" && !r.lineId)!;
    assert.match(rds.unitLabel, /PostgreSQL/);
    assert.equal(rds.unitPrice, 0.018); // db.t3.micro PostgreSQL reference
  });

  it("H. detected technologies come from manifests, not README claims", async () => {
    const { profile } = await planForRepo(REPO_FIXTURES.CONTRADICTORY);
    const dbs = profile.databases.map((d) => d.name);
    assert.ok(dbs.includes("PostgreSQL"));
    assert.ok(!dbs.includes("MongoDB"), "MongoDB appears only in the README");
  });
});

describe("Regression matrix — I. invalid / unreachable GitHub input", () => {
  it("rejects non-repository URLs before any request", () => {
    for (const bad of [
      "https://gitlab.com/a/b",
      "https://github.com/onlyowner",
      "https://github.com/%2e%2e/%2e%2e/orgs",
      "https://user:pw@github.com/a/b",
      "ftp://github.com/a/b",
      "not a url",
      "https://github.com/-bad/repo",
    ]) {
      assert.equal(parseGitHubRepoUrl(bad), null, bad);
    }
    assert.deepEqual(parseGitHubRepoUrl("https://github.com/vercel/next.js.git"), { owner: "vercel", repo: "next.js" });
    assert.deepEqual(parseGitHubRepoUrl("https://github.com/a/b/tree/main/src"), { owner: "a", repo: "b" });
  });

  it("reports a nonexistent repository as not-found after ONE request", async () => {
    let calls = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
    try {
      const s = await fetchRepoSignals("https://github.com/nobody/does-not-exist");
      assert.equal(s.fetchError, "not-found");
      assert.equal(s.keyFiles.length, 0);
      assert.equal(calls, 1, "previously ~110 speculative requests were made");
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("Regression matrix — J. descriptions (rules engine, offline)", () => {
  it("ambiguous description → INSUFFICIENT_SIGNAL, no invented services, open questions listed", async () => {
    const { plan, profile } = await planForDescription("Something for my college project");
    assert.equal(plan.awsMappings.length, 0);
    assert.equal(plan.terminalState, "INSUFFICIENT_SIGNAL");
    assert.ok((profile as ProjectProfile & { unresolved: string[] }).unresolved.length > 0);
  });

  it("React + Express + PostgreSQL description produces a full architecture (was empty)", async () => {
    const { plan } = await planForDescription(
      "A simple React frontend with a Node.js Express backend API connected to a PostgreSQL database"
    );
    const svc = services(plan);
    for (const group of [["RDS", "Aurora"], ["ECS", "Fargate", "EC2", "AppRunner"], ["S3"], ["CloudFront"]]) {
      assert.ok(group.some((s) => svc.has(s)), `expected one of [${group}] — got [${[...svc]}]`);
    }
    for (const s of ["DynamoDB", "DocumentDB", "Cognito"]) assert.ok(!svc.has(s), `prohibited ${s}`);
    // Decision 19: description-only results are capped at low confidence.
    assert.ok(plan.awsMappings.every((m) => m.confidence === "low"));
    await assertPlanInvariants("J. React+Express+PG", plan);
  });

  it("serverless description with an API gets API Gateway in front of Lambda", async () => {
    const { plan } = await planForDescription(
      "Serverless image processing API with AWS Lambda, S3 bucket trigger, and DynamoDB."
    );
    const svc = services(plan);
    for (const s of ["Lambda", "APIGateway", "S3", "DynamoDB"]) assert.ok(svc.has(s), `missing ${s}`);
    assert.ok(!svc.has("ECS") && !svc.has("RDS"));
    await assertPlanInvariants("J. serverless", plan);
  });

  it("a login requirement alone does not add Cognito; it is reported as an open question", async () => {
    const { plan, profile } = await planForDescription("A Django blog that stores data in a database and has user login");
    assert.ok(!services(plan).has("Cognito"));
    const unresolved = (profile as ProjectProfile & { unresolved: string[] }).unresolved.join(" ");
    assert.match(unresolved, /authentication/);
  });
});
