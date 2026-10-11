/**
 * auditFixes.test.ts — regression tests for every defect confirmed in the
 * October 2026 audit (docs/BUG_FIX_REPORT.md). Each `describe` names the bug
 * ID it guards. Expected numbers are computed by hand in the comments, never
 * copied from program output.
 *
 * Offline: network is mocked; LLM calls use the AI SDK's MockLanguageModelV4.
 * Run: node --experimental-strip-types --test src/lib/__tests__/auditFixes.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { parse as parseYaml } from "yaml";

import { fetchRepoSignals, readTextCapped, MAX_FILE_BYTES } from "../repoFetcher.ts";
import { analyzeArchitecture, extractJsonObject, redactSecrets, llmConfigured } from "../llmClient.ts";
import type { ProviderConfig } from "../llmClient.ts";
import { runInference } from "../inference.ts";
import { mapArchitectureModelToServicePlan, validateArchitectureModel } from "../architecture.ts";
import type { ArchitectureModel } from "../architecture.ts";
import { runRuleEngine } from "../ruleEngine.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { analyzeDescription } from "../descriptionAnalyzer.ts";
import { computeCostRows, scaleCostRows } from "../cost.ts";
import { clearPriceCache, getUnitPrice, selectBulkPrice, fetchBulkPrice } from "../prices.ts";
import { buildDiagramElements, generateSingleDiagramXml, tierOf } from "../diagram.ts";
import {
  generateCftYaml,
  validateCloudFormationTemplate,
  extractServicesFromDiagramXml,
  sanitizeAppName,
} from "../cftExport.ts";
import type { ServicePlan, ServiceId } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    return handler(String(input));
  }) as typeof fetch;
  return () => calls;
}
function offline() {
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
}

function plan(ids: string[], extra: Partial<ServicePlan> = {}): ServicePlan {
  return {
    inputKind: "description",
    components: ids.map((id) => ({
      id: `c-${id}`, type: "backend", technology: id, evidence: ["x"], confidence: "high", status: "detected",
    })),
    awsMappings: ids.map((id) => ({
      componentId: `c-${id}`, serviceId: id as ServiceId, confidence: "high", evidence: "x", fromPattern: false,
    })),
    relationships: [],
    deploymentModel: [],
    detectedPattern: "generic",
    terminalState: "OK",
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
    warnings: [],
    ...extra,
  };
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function mockProvider(text: string | (() => never)): ProviderConfig {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      if (typeof text === "function") text();
      return {
        content: [{ type: "text", text: text as string }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { name: "mock", model: "mock-model", getModel: () => model };
}

function descriptionRuleInput(text: string): RuleInput {
  return {
    description: text, fileContent: "", fileNames: [], inputKind: "description",
    grounding: "description", truncated: false, parseErrors: [], profile: analyzeDescription(text),
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearPriceCache();
});

// ---------------------------------------------------------------------------
// BUG-09 / BUG-10 — repository fetching
// ---------------------------------------------------------------------------

describe("BUG-09 repository errors are reported, not mistaken for low signal", () => {
  it("rate limit → fetchError=rate-limited after one request", async () => {
    const calls = mockFetch(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const s = await fetchRepoSignals("https://github.com/vercel/next.js");
    assert.equal(s.fetchError, "rate-limited");
    assert.equal(calls(), 1);
  });

  it("empty repository (no commits) → fetchError=empty-repository", async () => {
    mockFetch((url) =>
      url.endsWith("/repos/a/empty")
        ? new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        : new Response("{}", { status: 409 })
    );
    const s = await fetchRepoSignals("https://github.com/a/empty");
    assert.equal(s.fetchError, "empty-repository");
  });

  it("network failure → fetchError=network", async () => {
    offline();
    const s = await fetchRepoSignals("https://github.com/a/b");
    assert.equal(s.fetchError, "network");
  });

  it("invalid URL → fetchError=invalid-url with zero requests", async () => {
    const calls = mockFetch(() => new Response("", { status: 200 }));
    const s = await fetchRepoSignals("https://github.com/only-owner");
    assert.equal(s.fetchError, "invalid-url");
    assert.equal(calls(), 0);
  });
});

describe("BUG-10 per-file size cap (64 KB) on untrusted repository content", () => {
  it("a 30 MB source file is truncated to MAX_FILE_BYTES and flagged", async () => {
    const big = "x".repeat(30 * 1024 * 1024);
    mockFetch((url) => {
      if (url.endsWith("/repos/a/b")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree: [{ path: "main.py", type: "blob" }] }), { status: 200 });
      return new Response(big, { status: 200 });
    });
    const s = await fetchRepoSignals("https://github.com/a/b");
    const f = s.keyFiles.find((k) => k.path === "main.py")!;
    assert.equal(f.content!.length, MAX_FILE_BYTES);
    assert.equal(f.truncated, true);
    assert.equal(s.truncated, true);
  });

  it("an oversized manifest degrades to a filename-only signal instead of broken JSON", async () => {
    const hugeJson = JSON.stringify({ name: "x", dependencies: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`pkg-${i}`, "^1.0.0"])) });
    assert.ok(hugeJson.length > MAX_FILE_BYTES);
    mockFetch((url) => {
      if (url.endsWith("/repos/a/b")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree: [{ path: "package.json", type: "blob" }] }), { status: 200 });
      return new Response(hugeJson, { status: 200 });
    });
    const s = await fetchRepoSignals("https://github.com/a/b");
    const f = s.keyFiles.find((k) => k.path === "package.json")!;
    assert.equal(f.content, null);
    assert.ok(s.parseErrors.includes("package.json"));
  });

  it("readTextCapped keeps multi-byte characters intact across chunk boundaries", async () => {
    const text = "é".repeat(10); // 20 bytes
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.subarray(0, 3)); // splits the 2nd "é"
        c.enqueue(bytes.subarray(3));
        c.close();
      },
    });
    const r = await readTextCapped(new Response(body), 1024);
    assert.equal(r.text, text);
    assert.equal(r.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// BUG-01 — description input in rules-only mode
// ---------------------------------------------------------------------------

describe("BUG-01 description analyzer feeds the rules engine", () => {
  it("extracts only technologies the user named, each with a quoted citation", () => {
    const p = analyzeDescription("A React frontend with a Node.js Express backend API connected to a PostgreSQL database");
    assert.deepEqual(p.frameworks.map((f) => f.name).sort(), ["Express.js", "React"]);
    assert.deepEqual(p.databases.map((d) => d.name), ["PostgreSQL"]);
    for (const f of [...p.frameworks, ...p.databases]) assert.match(f.evidence, /^description: '.+'$/);
    assert.equal(p.origin, "description");
  });

  it("does not treat a database as file storage, a season as Spring Boot, or 'login' as Cognito", () => {
    const p = analyzeDescription("Stores data in a database. Built in spring semester. Users login with email.");
    assert.ok(!p.discoveredComponents.some((c) => c.type === "storage"));
    assert.ok(!p.frameworks.some((f) => f.name === "Spring Boot"));
    assert.ok(!p.discoveredComponents.some((c) => c.type === "auth"));
    assert.ok(p.unresolved.some((u) => /authentication/.test(u)));
    assert.ok(p.unresolved.some((u) => /database engine/.test(u)));
  });

  it("file uploads become object storage; external payment APIs are not AWS services", () => {
    const plan = runRuleEngine(descriptionRuleInput("Django shop with PostgreSQL where users upload product images and pay with Stripe"));
    const ids = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(ids.includes("S3"));
    assert.ok(ids.includes("RDS"));
  });
});

// ---------------------------------------------------------------------------
// BUG-05 / BUG-06 / BUG-07 — recommendation accuracy
// ---------------------------------------------------------------------------

describe("BUG-06 rule-engine relationships follow real request/data flow", () => {
  it("ALB routes to ECS (not to RDS); ECS reads RDS; edges are marked inferred", () => {
    const p = runRuleEngine(descriptionRuleInput("Express API with PostgreSQL in Docker containers"));
    const svcOf = new Map(p.awsMappings.map((m) => [m.componentId, m.serviceId]));
    const edges = p.relationships.map((r) => `${svcOf.get(r.from)}->${svcOf.get(r.to)}`);
    assert.ok(edges.includes("ALB->ECS"), edges.join(", "));
    assert.ok(edges.includes("ECS->RDS"), edges.join(", "));
    assert.ok(!edges.includes("ALB->RDS"), "load balancers never read databases");
    assert.ok(p.relationships.every((r) => r.evidence?.startsWith("inferred:")));
  });

  it("inferred relationships render as dashed diagram edges", () => {
    const p = runRuleEngine(descriptionRuleInput("Express API with PostgreSQL in Docker containers"));
    const { routedEdges } = buildDiagramElements(p, null);
    assert.ok(routedEdges.length > 0);
    assert.ok(routedEdges.every((e) => e.style === "dashed"), "rule-derived edges are not code-confirmed");
  });
});

describe("BUG-05 LLM-path mapping: SSR, unknown databases, in-app auth", () => {
  const CTX = { inputKind: "github_url" as const, grounding: "repoFiles" as const, truncated: false, parseErrors: [] };
  const model = (components: ArchitectureModel["components"]): ArchitectureModel => ({
    appType: "full-stack-web", appName: "x", description: "", components,
    languages: [], frameworks: [], databases: [], apis: [], externalServices: [], dependencies: [], buildConfig: [], relationships: [],
  });
  const comp = (id: string, type: ArchitectureModel["components"][number]["type"], technology: string) => ({
    id, name: id, type, technology, evidence: ["ev"], confidence: "high" as const,
  });

  it("a server-rendered Next.js frontend maps to compute, not S3 static hosting", () => {
    const p = mapArchitectureModelToServicePlan(model([comp("web", "frontend", "Next.js")]), CTX);
    const ids = p.awsMappings.map((m) => m.serviceId);
    assert.ok(ids.includes("ECS") && ids.includes("ALB"), ids.join(","));
    assert.ok(!ids.includes("S3"));
  });

  it("a Next.js static export still maps to S3 + CloudFront", () => {
    const c = { ...comp("web", "frontend", "Next.js"), details: "static export (output: 'export')" };
    const ids = mapArchitectureModelToServicePlan(model([c]), CTX).awsMappings.map((m) => m.serviceId);
    assert.deepEqual(ids.sort(), ["CloudFront", "S3"]);
  });

  it("SQLite / Firebase are not mapped to RDS; an unidentified engine is RDS at low confidence", () => {
    const ids = (t: string) => mapArchitectureModelToServicePlan(model([comp("db", "database", t)]), CTX).awsMappings;
    assert.equal(ids("SQLite").length, 0);
    assert.equal(ids("Firebase Firestore").length, 0);
    const unknown = ids("Some database");
    assert.equal(unknown[0].serviceId, "RDS");
    assert.equal(unknown[0].confidence, "low");
  });

  it("JWT/session auth inside the app is not 'evidence' for Cognito", () => {
    const m = mapArchitectureModelToServicePlan(model([comp("auth", "auth", "JWT (jsonwebtoken)")]), CTX).awsMappings[0];
    assert.equal(m.serviceId, "Cognito");
    assert.equal(m.confidence, "low");
    assert.equal(m.category, "recommendation");
  });
});

describe("BUG-11 LLM summary lists cannot add uncorroborated services", () => {
  it("drops a 'DynamoDB' list entry that no evidence supports", () => {
    const raw = {
      appType: "full-stack-web",
      components: [{ id: "api", name: "API", type: "backend", technology: "Express", evidence: ["ev-1"] }],
      databases: ["DynamoDB"],
      frameworks: ["Express"],
    };
    const register = [{ id: "ev-1", kind: "manifest" as const, sourcePath: "package.json", technology: "Express.js", detail: "dependencies.express", confidence: "high" as const }];
    const v = validateArchitectureModel(raw, register);
    assert.ok(v.model);
    assert.deepEqual(v.model!.databases, []);
    assert.deepEqual(v.model!.frameworks, ["Express"]);
    const ids = mapArchitectureModelToServicePlan(v.model!, {
      inputKind: "github_url", grounding: "repoFiles", truncated: false, parseErrors: [],
    }).awsMappings.map((m) => m.serviceId);
    assert.ok(!ids.includes("DynamoDB"));
  });

  it("description path: a component citing a phrase that is not in the description is dropped", () => {
    const raw = {
      components: [
        { id: "db", name: "DB", type: "database", technology: "PostgreSQL", evidence: ["description: 'PostgreSQL database'"] },
        { id: "q", name: "Queue", type: "queue", technology: "Kafka", evidence: ["description: 'event streaming with Kafka'"] },
      ],
    };
    const v = validateArchitectureModel(raw, undefined, "A web app with a PostgreSQL database");
    assert.deepEqual(v.model!.components.map((c) => c.id), ["db"]);
  });
});

// ---------------------------------------------------------------------------
// BUG-12 — AI provider reliability & observability
// ---------------------------------------------------------------------------

describe("BUG-12 AI provider reliability", () => {
  const MODEL_JSON = JSON.stringify({
    appType: "full-stack-web",
    components: [
      { id: "api", name: "API", type: "backend", technology: "Express", evidence: ["description: 'Express API'"] },
      { id: "db", name: "DB", type: "database", technology: "PostgreSQL", evidence: ["description: 'PostgreSQL'"] },
    ],
    relationships: [{ from: "api", to: "db", type: "reads" }],
  });
  const DESC = "An Express API backed by PostgreSQL";

  it("extractJsonObject strips markdown fences and prose around the JSON", () => {
    assert.equal(extractJsonObject("```json\n{\"a\":1}\n```"), '{"a":1}');
    assert.equal(extractJsonObject('Sure! Here it is: {"a":1} hope that helps'), '{"a":1}');
    assert.equal(extractJsonObject("no json here"), null);
  });

  it("fenced JSON from a model is repaired and used (engine = llm)", async () => {
    const r = await runInference({
      ruleInput: descriptionRuleInput(DESC), signals: null, description: DESC,
      profile: analyzeDescription(DESC), llmProviders: [mockProvider("```json\n" + MODEL_JSON + "\n```")],
    });
    assert.equal(r.engine, "llm");
    const ids = r.plan.awsMappings.map((m) => m.serviceId);
    assert.ok(ids.includes("RDS") && ids.includes("ECS"));
  });

  it("a failing provider falls back to rules VISIBLY (engine = rules-fallback + diagnostics)", async () => {
    const failing = mockProvider(() => {
      throw new Error("429 Too Many Requests ?key=AIzaSyFAKEFAKEFAKEFAKEFAKE1234");
    });
    const r = await runInference({
      ruleInput: descriptionRuleInput(DESC), signals: null, description: DESC,
      profile: analyzeDescription(DESC), llmProviders: [failing],
    });
    assert.equal(r.engine, "rules-fallback");
    assert.ok(r.diagnostics.some((d) => d.code === "llm-call-failed"));
    assert.ok(r.diagnostics.some((d) => d.code === "llm-fallback-to-rules"));
    assert.ok(!JSON.stringify(r.diagnostics).includes("AIzaSyFAKE"), "API keys must be redacted from diagnostics");
    assert.ok(r.plan.awsMappings.length > 0, "the rules baseline still answers");
  });

  it("an empty / non-JSON model answer is rejected, never used", async () => {
    const r = await analyzeArchitecture(
      { signals: null, description: DESC, inputKind: "description", grounding: "description" },
      { providers: [mockProvider("I cannot help with that.")] }
    );
    assert.equal(r.model, null);
    assert.equal(r.error, "all-providers-failed");
  });

  it("a schema-violating answer (unknown component type) is rejected", async () => {
    const bad = JSON.stringify({ components: [{ id: "x", name: "x", type: "blockchain", technology: "Solidity", evidence: ["e"] }] });
    const r = await analyzeArchitecture(
      { signals: null, description: DESC, inputKind: "description", grounding: "description" },
      { providers: [mockProvider(bad)] }
    );
    assert.equal(r.model, null);
  });

  it("redactSecrets removes keys, bearer tokens and key query parameters", () => {
    const out = redactSecrets(
      "GET https://x/v1?key=AIzaSyABCDEF0123456789abcdef&alt=json Authorization: Bearer sk-or-v1-abcdef0123456789abcdef"
    );
    assert.ok(!/AIzaSy|sk-or-v1/.test(out), out);
    assert.match(out, /\[redacted\]/);
  });

  it("GOOGLE_GENERATIVE_AI_API_KEY (the AI SDK's own variable name) is accepted", () => {
    const saved = { ...process.env };
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    try {
      assert.equal(llmConfigured(), true);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "   ";
      assert.equal(llmConfigured(), false, "blank keys are not configuration");
    } finally {
      process.env = saved;
    }
  });
});

describe("BUG-13 grounding cap applies to the rules path too (Decision 19)", () => {
  it("description-only rules results are all low confidence", async () => {
    const text = "Serverless API with AWS Lambda and DynamoDB";
    const r = await runInference({
      ruleInput: descriptionRuleInput(text), signals: null, description: text,
      profile: analyzeDescription(text), llmProviders: [],
    });
    assert.ok(r.plan.awsMappings.length > 0);
    assert.ok(r.plan.awsMappings.every((m) => m.confidence === "low"));
    assert.ok(r.plans.every((p) => p.awsMappings.every((m) => m.confidence === "low")));
  });
});

// ---------------------------------------------------------------------------
// BUG-02 / BUG-03 / BUG-04 / BUG-14 — cost estimation
// ---------------------------------------------------------------------------

describe("BUG-02..04 cost formulas (offline fallback prices)", () => {
  beforeEach(() => {
    offline();
    clearPriceCache();
  });

  it("Lambda: 500k GB-s compute + 5M requests (was 5M GB-s = 10× too high)", async () => {
    const r = await computeCostRows(plan(["Lambda"]), "us-east-1", 10_000);
    const compute = r.rows.find((x) => x.serviceId === "Lambda" && !x.lineId)!;
    const requests = r.rows.find((x) => x.lineId === "requests")!;
    // 5,000,000 req × 0.2 s × 0.5 GB = 500,000 GB-s; × $0.0000166667 = $8.33335
    assert.equal(compute.quantity, 500_000);
    assert.ok(Math.abs(compute.monthlyUsd - 8.33335) < 1e-9);
    // 5 (million requests) × $0.20 = $1.00
    assert.ok(Math.abs(requests.monthlyUsd - 1.0) < 1e-12);
    assert.ok(Math.abs(r.totalMonthlyUsd - 9.33335) < 1e-9);
  });

  it("CloudFront: 100 GB × $0.085 = $8.50 (fallback was 10× too low)", async () => {
    const r = await computeCostRows(plan(["CloudFront"]), "us-east-1", 10_000);
    assert.ok(Math.abs(r.rows[0].monthlyUsd - 8.5) < 1e-9);
  });

  it("services with no live and no reference price are unpriced, never $0", async () => {
    const r = await computeCostRows(plan(["MSK", "OpenSearch"]), "us-east-1", 10_000);
    assert.equal(r.rows.length, 0);
    assert.deepEqual(r.unpricedRows.map((u) => u.serviceId).sort(), ["MSK", "OpenSearch"]);
    assert.equal(r.totalMonthlyUsd, 0);
  });

  it("VPC is listed as no-charge instead of a fake $0.01 endpoint row", async () => {
    const r = await computeCostRows(plan(["VPC"]), "us-east-1", 10_000);
    assert.equal(r.rows.length, 0);
    assert.match(r.unpricedRows[0].note, /No charge for the VPC itself/);
  });

  it("Fargate memory is billed alongside vCPU", async () => {
    const r = await computeCostRows(plan(["ECS"]), "us-east-1", 10_000);
    // 720 vCPU-h × 0.04048 = 29.1456 ; 1440 GB-h × 0.004445 = 6.4008 ; total 35.5464
    assert.ok(Math.abs(r.totalMonthlyUsd - 35.5464) < 1e-9);
  });

  it("fallback prices outside us-east-1 are labelled as us-east-1 references", async () => {
    const r = await computeCostRows(plan(["S3"]), "eu-west-1", 10_000);
    assert.equal(r.rows[0].priceSource, "fallback");
    assert.equal(r.rows[0].priceRegion, "us-east-1");
    assert.equal(r.region, "eu-west-1");
  });

  it("fractional scaling: 15,000 users → 7.5M HTTP API calls × $1.00/M = $7.50", async () => {
    const r = await computeCostRows(plan(["APIGateway"]), "us-east-1", 15_000);
    assert.ok(Math.abs(r.rows[0].quantity - 7.5) < 1e-12);
    assert.ok(Math.abs(r.rows[0].monthlyUsd - 7.5) < 1e-12);
  });

  it("minimum usage: userCount 0/negative is clamped to 1 user", async () => {
    const r = await computeCostRows(plan(["SQS"]), "us-east-1", 0);
    assert.equal(r.userCount, 1);
    // 1 / 10,000 × 1M requests = 0.0001 M × $0.40 = $0.00004
    assert.ok(Math.abs(r.rows[0].monthlyUsd - 0.00004) < 1e-15);
  });

  it("no premature rounding: monthlyUsd is the exact product", async () => {
    const r = await computeCostRows(plan(["DynamoDB"]), "us-east-1", 10_000);
    const reads = r.rows.find((x) => x.serviceId === "DynamoDB" && !x.lineId)!;
    // 1,000,000 RRU × $0.000000125 = $0.125
    assert.equal(reads.monthlyUsd, reads.quantity * reads.unitPrice);
    assert.ok(Math.abs(reads.monthlyUsd - 0.125) < 1e-12);
  });
});

describe("BUG-14 client-side rescaling matches the server (free tier re-applied)", () => {
  beforeEach(() => {
    offline();
    clearPriceCache();
  });

  it("Cognito at 5k/100k/200k users: scaleCostRows == computeCostRows", async () => {
    const base = await computeCostRows(plan(["Cognito"]), "us-east-1", 10_000);
    for (const users of [5_000, 100_000, 200_000]) {
      const server = await computeCostRows(plan(["Cognito"]), "us-east-1", users);
      const client = scaleCostRows(base, users);
      assert.ok(
        Math.abs(server.totalMonthlyUsd - client.totalMonthlyUsd) < 1e-9,
        `${users}: server ${server.totalMonthlyUsd} vs client ${client.totalMonthlyUsd}`
      );
    }
    // 200,000 MAU − 10,000 free = 190,000 × $0.0055 = $1,045
    const at200k = scaleCostRows(base, 200_000);
    assert.ok(Math.abs(at200k.totalMonthlyUsd - 1045) < 1e-9);
  });
});

describe("BUG-03 live price units and tier selection", () => {
  const bulk = (usagetype: string, dims: Array<{ usd: string; begin?: string }>, attrs: Record<string, string> = {}) => ({
    products: { SKU: { sku: "SKU", attributes: { usagetype, ...attrs } } },
    terms: {
      OnDemand: {
        SKU: {
          "SKU.T": {
            priceDimensions: Object.fromEntries(
              dims.map((d, i) => [`D${i}`, { pricePerUnit: { USD: d.usd }, beginRange: d.begin ?? "0" }])
            ),
          },
        },
      },
    },
  });

  it("per-request live prices are converted to per-million (5M calls = $5, not $0.000005)", async () => {
    mockFetch(() => new Response(JSON.stringify(bulk("ApiGatewayHttpRequest", [{ usd: "0.0000010000" }])), { status: 200 }));
    const r = await computeCostRows(plan(["APIGateway"]), "us-east-1", 10_000);
    assert.equal(r.rows[0].priceSource, "live");
    assert.ok(Math.abs(r.rows[0].unitPrice - 1.0) < 1e-12);
    assert.ok(Math.abs(r.rows[0].monthlyUsd - 5.0) < 1e-12);
  });

  it("tiered prices use the first PAID tier regardless of object order", () => {
    const data = bulk("TimedStorage-ByteHrs", [
      { usd: "0.0210000000", begin: "512000" },
      { usd: "0.0230000000", begin: "0" },
      { usd: "0.0220000000", begin: "51200" },
    ]);
    assert.equal(selectBulkPrice(data, "TimedStorage-ByteHrs"), 0.023);
  });

  it("attribute filters pick the right engine SKU", () => {
    const data = {
      products: {
        A: { sku: "A", attributes: { usagetype: "InstanceUsage:db.t3.micro", databaseEngine: "Oracle", deploymentOption: "Single-AZ" } },
        B: { sku: "B", attributes: { usagetype: "InstanceUsage:db.t3.micro", databaseEngine: "PostgreSQL", deploymentOption: "Single-AZ" } },
      },
      terms: {
        OnDemand: {
          A: { T: { priceDimensions: { D: { pricePerUnit: { USD: "0.0360" } } } } },
          B: { T: { priceDimensions: { D: { pricePerUnit: { USD: "0.0180" } } } } },
        },
      },
    };
    assert.equal(
      selectBulkPrice(data, "InstanceUsage:db.t3.micro", { databaseEngine: "PostgreSQL", deploymentOption: "Single-AZ" }),
      0.018
    );
  });

  it("oversized bulk files are skipped instead of JSON-parsing a truncated prefix", async () => {
    mockFetch(() => new Response("{", { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } }));
    assert.equal(await fetchBulkPrice("AmazonEC2", "BoxUsage:t3.small", "us-east-1"), null);
  });

  it("missing price with no fallback returns null (caller reports unpriced)", async () => {
    offline();
    assert.equal(await getUnitPrice("MSK", "AmazonMSK", "Kafka.m5.large", "us-east-1"), null);
  });
});

// ---------------------------------------------------------------------------
// BUG-15 — diagram
// ---------------------------------------------------------------------------

describe("BUG-15 diagram robustness", () => {
  it("services outside the 45-entry tier table are placed by category, not in the data subnet", () => {
    assert.equal(tierOf("Bedrock"), "external");
    assert.equal(tierOf("AppRunner"), "vpc_compute");
    assert.equal(tierOf("KMS"), "cross_cutting");
    assert.equal(tierOf("RDS"), "vpc_data");
  });

  it("special characters are escaped and an empty pattern does not crash", () => {
    const p = plan(["S3"], {
      detectedPattern: "",
      components: [{ id: "c-S3", type: "object-storage", technology: '<script>alert("x")</script> & co', evidence: ["x"], confidence: "high", status: "detected" }],
    });
    const xml = generateSingleDiagramXml(p);
    assert.ok(!xml.includes("<script>"));
    assert.ok(xml.includes("&lt;script&gt;"));
    assert.match(xml, /name="Generic Architecture"/);
  });

  it("the diagram carries machine-readable serviceIds that CFN export reads back exactly", () => {
    const p = plan(["Lambda", "DynamoDB", "Route53", "SecretsManager"]);
    const xml = generateSingleDiagramXml(p);
    assert.deepEqual(extractServicesFromDiagramXml(xml).serviceIds.sort(), ["DynamoDB", "Lambda", "Route53", "SecretsManager"]);
  });
});

// ---------------------------------------------------------------------------
// BUG-08 — CloudFormation export
// ---------------------------------------------------------------------------

describe("BUG-08 CloudFormation export", () => {
  it("no hardcoded passwords: DB credentials come from a generated secret", () => {
    const y = generateCftYaml(plan(["ECS", "RDS", "Aurora", "Redshift"]));
    assert.ok(!y.includes("MustBeChanged"));
    const doc = parseYaml(y);
    assert.ok(doc.Resources.DatabaseSecret.Properties.GenerateSecretString);
    assert.match(JSON.stringify(doc.Resources.AppDatabase.Properties.MasterUserPassword), /resolve:secretsmanager/);
    assert.equal(doc.Resources.RedshiftCluster.Properties.ClusterType, "single-node");
    assert.ok(validateCloudFormationTemplate(y).valid);
  });

  it("networked services get a VPC prerequisite, network config, subnets and an AMI", () => {
    const y = generateCftYaml(plan(["ALB", "ECS", "EC2"]));
    const doc = parseYaml(y);
    assert.ok(doc.Resources.AppVpc, "VPC added as a prerequisite");
    assert.deepEqual(doc.Metadata.AwsArchitect.PrerequisitesAdded.length, 1);
    assert.ok(doc.Resources.EcsService.Properties.NetworkConfiguration);
    assert.equal(doc.Resources.ApplicationLoadBalancer.Properties.Subnets.length, 2);
    assert.match(doc.Resources.AppInstance.Properties.ImageId, /resolve:ssm/);
    assert.ok(doc.Resources.PublicSubnet1.Properties.AvailabilityZone, "subnets pinned to distinct AZs");
    assert.ok(doc.Resources.PublicDefaultRoute, "public subnets have an internet route");
  });

  it("the data tier only accepts traffic from the compute security group", () => {
    const doc = parseYaml(generateCftYaml(plan(["ALB", "ECS", "RDS"], { metadata: { grounding: "description", truncated: false, parseErrors: [], dbEngine: "postgres" } })));
    const ingress = doc.Resources.DbSecurityGroup.Properties.SecurityGroupIngress;
    assert.equal(ingress.length, 1);
    assert.equal(ingress[0].FromPort, 5432);
    assert.deepEqual(ingress[0].SourceSecurityGroupId, { Ref: "AppComputeSecurityGroup" });
    assert.equal(doc.Resources.AppDatabase.Properties.Engine, "postgres");
  });

  it("a plan with only unsupported services exports a placeholder, not invented Lambda/S3", () => {
    const y = generateCftYaml(plan(["Bedrock"]));
    const doc = parseYaml(y);
    assert.deepEqual(Object.keys(doc.Resources), ["PlaceholderNoSupportedServices"]);
    assert.deepEqual(doc.Metadata.AwsArchitect.UnsupportedServices, ["Bedrock"]);
    assert.match(y, /NOT INCLUDED .*Bedrock/);
  });

  it("Lambda gets least-privilege access to the queue/table it uses", () => {
    const doc = parseYaml(generateCftYaml(plan(["Lambda", "SQS", "DynamoDB"])));
    const stmts = doc.Resources.LambdaExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
    assert.ok(stmts.some((s: { Action: string[] }) => s.Action.includes("sqs:ReceiveMessage")));
    assert.ok(stmts.every((s: { Resource: unknown }) => s.Resource !== "*"));
  });

  it("SageMaker uses a real role, MSK uses real subnets", () => {
    const doc = parseYaml(generateCftYaml(plan(["SageMaker", "MSK", "ECS"])));
    assert.deepEqual(doc.Resources.SageMakerModel.Properties.ExecutionRoleArn, { "Fn::GetAtt": ["SageMakerExecutionRole", "Arn"] });
    assert.deepEqual(doc.Resources.MskCluster.Properties.BrokerNodeGroupInfo.ClientSubnets, [{ Ref: "PrivateSubnet1" }, { Ref: "PrivateSubnet2" }]);
  });

  it("invalid environment/app names are normalised so the template stays valid", () => {
    const y = generateCftYaml(plan(["S3"]), { environment: "test", appName: "My Cool App!!" });
    const doc = parseYaml(y);
    assert.equal(doc.Parameters.Environment.Default, "dev");
    assert.equal(doc.Parameters.AppName.Default, "my-cool-app");
    assert.ok(validateCloudFormationTemplate(y).valid);
    assert.equal(sanitizeAppName("***"), "aws-architect-app");
  });

  it("the validator now rejects the defects it used to accept", () => {
    const bad = `AWSTemplateFormatVersion: "2010-09-09"
Description: bad
Parameters:
  Environment: { Type: String, Default: test, AllowedValues: [dev, prod] }
Resources:
  Db:
    Type: AWS::RDS::DBInstance
    Properties: { DBInstanceClass: db.t3.micro, MasterUserPassword: "MustBeChanged123!" }
  Lb:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties: { Name: x }
  Vm:
    Type: AWS::EC2::Instance
    Properties: { InstanceType: t3.small }
  Fn:
    Type: AWS::SageMaker::Model
    Properties: { ExecutionRoleArn: "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess", ModelName: { "Fn::Sub": "\${Missing}-m" } }
`;
    const errs = validateCloudFormationTemplate(bad).errors.join("\n");
    assert.match(errs, /hardcoded MasterUserPassword/);
    assert.match(errs, /Subnets or SubnetMappings/);
    assert.match(errs, /ImageId or LaunchTemplate/);
    assert.match(errs, /policy ARN/);
    assert.match(errs, /Dangling Fn::Sub/);
    assert.match(errs, /not one of its AllowedValues/);
  });
});

// ---------------------------------------------------------------------------
// BUG-16 — alternate proposal must not add a second database
// ---------------------------------------------------------------------------

describe("BUG-16 serverless alternate keeps the existing database", () => {
  it("containerised app with PostgreSQL → alternate has Lambda + RDS, not RDS + DynamoDB", () => {
    const primary = runRuleEngine(descriptionRuleInput("Express API with PostgreSQL in Docker containers"));
    const alt = primary.proposals?.[1];
    assert.ok(alt, "a curated alternate exists for containerised apps");
    const ids = alt!.awsMappings.map((m) => m.serviceId);
    assert.ok(ids.includes("Lambda") && ids.includes("RDS"), ids.join(","));
    assert.ok(!ids.includes("DynamoDB"), "two databases for one app: " + ids.join(","));
    assert.ok(!ids.includes("ECR"), "no container registry without containers");
  });

  it("an app with no database gets no invented database in the alternate", () => {
    const primary = runRuleEngine(descriptionRuleInput("Express API in Docker containers"));
    const alt = primary.proposals?.[1];
    assert.ok(alt);
    const ids = alt!.awsMappings.map((m) => m.serviceId);
    for (const db of ["DynamoDB", "RDS", "Aurora", "DocumentDB"]) assert.ok(!ids.includes(db), ids.join(","));
  });
});
