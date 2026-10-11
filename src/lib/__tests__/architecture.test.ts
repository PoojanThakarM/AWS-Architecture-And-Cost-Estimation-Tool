/**
 * architecture.test.ts
 *
 * Tests for the central reasoning layer: ArchitectureModel validation/
 * normalization and the deterministic model → ServicePlan mapping.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/architecture.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateArchitectureModel,
  mapArchitectureModelToServicePlan,
} from "../architecture.ts";
import type { ArchitectureModel, ModelContext } from "../architecture.ts";
import { SERVICE_IDS, ServicePlanSchema } from "../schema.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CTX: ModelContext = {
  inputKind: "github_url",
  grounding: "repoFiles",
  truncated: false,
  parseErrors: [],
};

function serviceIds(plan: ServicePlan): string[] {
  return plan.awsMappings.map((m) => m.serviceId);
}

/**
 * Minimal ArchitectureComponent — fills in the new optional-but-defaulted fields.
 * Evidence defaults to a citation because normalizeArchitectureModel() drops
 * evidence-free components; pass `[]` explicitly to exercise that rejection.
 */
function comp(
  id: string,
  name: string,
  type: ArchitectureModel["components"][number]["type"],
  technology: string,
  confidence: "high" | "medium" | "low" = "medium",
  evidence: string[] = [`package.json → ${technology}`]
): ArchitectureModel["components"][number] {
  return { id, name, type, technology, confidence, evidence };
}

function makeModel(overrides: Partial<ArchitectureModel> = {}): ArchitectureModel {
  return {
    appType: "full-stack-web",
    appName: "my-app",
    description: "A React frontend with an Express API and a Postgres database.",
    components: [
      comp("web", "Web UI", "frontend", "React"),
      comp("api", "API Server", "backend", "Express"),
      comp("db", "Database", "database", "PostgreSQL"),
    ],
    languages: ["TypeScript", "JavaScript"],
    frameworks: ["React", "Express"],
    databases: ["PostgreSQL"],
    apis: [],
    externalServices: [],
    dependencies: ["pg", "express"],
    buildConfig: [],
    relationships: [
      { from: "web", to: "api", type: "calls" },
      { from: "api", to: "db", type: "reads" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation + normalization
// ---------------------------------------------------------------------------

describe("validateArchitectureModel", () => {
  it("accepts a valid model and normalizes it", () => {
    const { model } = validateArchitectureModel(makeModel());
    assert.ok(model, "Valid model should pass validation");
    assert.strictEqual(model!.appType, "full-stack-web");
    assert.strictEqual(model!.components.length, 3);
  });

  it("rejects a model with an invalid appType", () => {
    const bad = makeModel({ appType: "not-a-pattern" as ArchitectureModel["appType"] });
    const result = validateArchitectureModel(bad);
    assert.strictEqual(result.model, null);
    // The reason distinguishes "the shape was wrong" from "nothing was cited",
    // which the previous bare null could not.
    assert.strictEqual(result.reason, "schema");
  });

  it("rejects a model with an invalid component type", () => {
    const bad = makeModel({
      components: [
        comp("web", "Web UI", "not-a-type" as ArchitectureModel["components"][number]["type"], "React"),
      ],
    });
    const result = validateArchitectureModel(bad);
    assert.strictEqual(result.model, null);
    assert.strictEqual(result.reason, "schema");
  });

  it("dedupes duplicate string arrays case-insensitively", () => {
    const { model } = validateArchitectureModel(
      makeModel({ languages: ["typescript", "TypeScript", "python", "typescript"] })
    );
    assert.deepStrictEqual(model!.languages, ["typescript", "python"]);
  });

  it("drops relationships that reference unknown component ids", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        relationships: [
          { from: "web", to: "api", type: "calls" },
          { from: "ghost", to: "api", type: "calls" },
        ],
      })
    );
    assert.strictEqual(model!.relationships.length, 1);
    assert.strictEqual(model!.relationships[0].from, "web");
  });
});

// ---------------------------------------------------------------------------
// Evidence backstop against LLM over-inference
//
// The system prompt forbids emitting a component that cites no evidence.
// normalizeArchitectureModel() is the code-level guarantee for when the LLM
// ignores that — the "static HTML repo sprouts Lambda + API Gateway + DynamoDB
// + Secrets Manager" failure mode.
// ---------------------------------------------------------------------------

describe("evidence backstop — components without evidence are dropped", () => {
  it("drops an evidence-free component while keeping its evidence-backed siblings", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        components: [
          comp("web", "Web UI", "frontend", "React", "high", ["package.json → react"]),
          // No citation — an invented tier.
          comp("fn", "Serverless Handlers", "backend", "AWS Lambda", "high", []),
        ],
      })
    );

    assert.ok(model, "model with at least one evidenced component still validates");
    const ids = model!.components.map((c) => c.id);
    assert.deepStrictEqual(ids, ["web"], `evidence-free component must be dropped; got ${ids.join(", ")}`);
  });

  it("treats blank and whitespace-only citations as no evidence", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        components: [
          comp("api", "API", "backend", "Express", "high", ["package.json → express"]),
          comp("db", "Database", "database", "DynamoDB", "high", ["", "   "]),
        ],
      })
    );

    assert.ok(model);
    assert.deepStrictEqual(model!.components.map((c) => c.id), ["api"]);
  });

  it("drops relationships whose endpoint was dropped for lacking evidence", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        components: [
          comp("web", "Web UI", "frontend", "React", "high", ["index.html"]),
          comp("q", "Job Queue", "queue", "SQS", "high", []),
        ],
        relationships: [{ from: "web", to: "q", type: "sends" }],
      })
    );

    assert.ok(model);
    assert.strictEqual(
      model!.relationships.length,
      0,
      "an edge into a dropped component must not survive"
    );
  });

  it("static HTML/CSS/JS repo stays a single frontend component — no backend tiers", () => {
    // The reported bug: zero backend evidence, yet the LLM emits a full stack.
    const { model } = validateArchitectureModel(
      makeModel({
        appType: "static-site",
        components: [
          comp("site", "Static Site", "frontend", "HTML/CSS/JS", "high", [
            "index.html",
            "assets/styles.css",
          ]),
          comp("api", "REST API", "api", "API Gateway", "high", []),
          comp("fn", "Handlers", "backend", "AWS Lambda", "high", []),
          comp("db", "Table", "database", "DynamoDB", "medium", []),
          comp("secrets", "Secrets", "auth", "Secrets Manager", "low", []),
        ],
        databases: [],
        frameworks: [],
      })
    );

    assert.ok(model, "the one evidenced component keeps the model alive");
    assert.strictEqual(model!.components.length, 1, "only the evidenced frontend survives");
    assert.strictEqual(model!.components[0].id, "site");

    const plan = mapArchitectureModelToServicePlan(model!, CTX);
    const componentBacked = plan.awsMappings.filter((m) => !m.fromPattern).map((m) => m.serviceId);
    for (const hallucinated of ["Lambda", "APIGateway", "DynamoDB"]) {
      assert.ok(
        !componentBacked.includes(hallucinated),
        `${hallucinated} must not be component-backed; got ${componentBacked.join(", ")}`
      );
    }
  });

  it("returns null when every component lacks evidence, so inference falls back to rules", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        components: [
          comp("fn", "Handlers", "backend", "AWS Lambda", "high", []),
          comp("db", "Table", "database", "DynamoDB", "high", []),
        ],
      })
    );

    assert.strictEqual(model, null, "a fully evidence-free model is discarded entirely");
  });
});

// ---------------------------------------------------------------------------
// Deterministic service mapping
// ---------------------------------------------------------------------------

describe("mapArchitectureModelToServicePlan", () => {
  it("maps a static site to S3 + CloudFront under the static-site pattern", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "static-site",
        components: [comp("site", "Site", "frontend", "Gatsby")],
      }),
      CTX
    );
    assert.strictEqual(plan.detectedPattern, "static-site");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("S3"), "static site needs S3");
    assert.ok(ids.includes("CloudFront"), "static site needs CloudFront");
  });

  it("maps a serverless API (Lambda + DynamoDB) deterministically", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "serverless-api",
        components: [
          comp("fn", "Handlers", "backend", "AWS Lambda (Node.js)"),
          comp("db", "Table", "database", "DynamoDB"),
        ],
        databases: ["DynamoDB"],
      }),
      CTX
    );
    assert.strictEqual(plan.detectedPattern, "serverless-api");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda from serverless backend component");
    assert.ok(ids.includes("APIGateway"), "APIGateway from serverless pattern");
    assert.ok(ids.includes("DynamoDB"), "DynamoDB from database component");
    assert.ok(!ids.includes("CloudWatch"), "no CloudWatch without real evidence (Decision 51)");
  });

  it("maps PostgreSQL to RDS and a plain backend to ECS", () => {
    const plan = mapArchitectureModelToServicePlan(makeModel(), CTX);
    const ids = serviceIds(plan);
    assert.ok(ids.includes("RDS"), "PostgreSQL → RDS");
    assert.ok(ids.includes("ECS"), "Express backend → managed container host");
  });

  it("maps Redis database component to ElastiCache", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        components: [
          comp("api", "API Server", "backend", "Express"),
          comp("cache", "Cache", "database", "Redis"),
        ],
        databases: ["Redis"],
      }),
      CTX
    );
    assert.ok(serviceIds(plan).includes("ElastiCache"), "Redis → ElastiCache");
  });

  it("turns component relationships into relationships between services", () => {
    const plan = mapArchitectureModelToServicePlan(makeModel(), CTX);
    assert.ok(plan.relationships.length >= 1, "relationships should be preserved");
    const hasApiToDb = plan.relationships.some(
      (e) => e.from === "api" && e.to === "db"
    );
    assert.ok(hasApiToDb, "api→db 'reads' relationship should surface as an edge");
  });

  it("does NOT map external SaaS components to AWS services", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        components: [
          comp("api", "API Server", "backend", "Express"),
          comp("pay", "Payments", "external_service", "Stripe"),
        ],
        externalServices: ["Stripe"],
      }),
      CTX
    );
    assert.ok(!serviceIds(plan).includes("Stripe"), "external SaaS must not become a service");
    // external_service components don't map to AWS services
  });

  it("keeps every serviceId on the catalog allowlist and never exceeds 12", () => {
    const { model } = validateArchitectureModel(makeModel());
    const plan = mapArchitectureModelToServicePlan(model, CTX);
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "mapped plan must satisfy the ServicePlan contract");
    const allowlist = new Set<string>(SERVICE_IDS);
    for (const id of serviceIds(plan)) {
      assert.ok(allowlist.has(id), `${id} must be on the catalog allowlist`);
    }
    assert.ok(new Set(serviceIds(plan)).size <= 12, "never exceed 12 distinct services");
  });

  it("returns a valid generic floor when no component maps to a service", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "generic",
        components: [
          comp("misc", "Misc", "other", "plain scripts"),
        ],
        databases: [],
        frameworks: [],
        languages: [],
        buildConfig: [],
        dependencies: [],
        externalServices: [],
        apis: [],
        relationships: [],
      }),
      CTX
    );
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "floor plan must be schema-valid");
    assert.strictEqual(plan.detectedPattern, "generic");
    assert.ok(serviceIds(plan).includes("S3"), "generic floor includes S3");
  });

  it("maps a scheduler component to ECS + EventBridge (containerised context)", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "containerised-app",
        components: [
          comp("api", "API", "backend", "Express"),
          comp("job", "Daily Report", "scheduler", "custom cron job"),
        ],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    assert.ok(ids.includes("ECS"), "scheduler in container context → ECS");
    assert.ok(ids.includes("EventBridge"), "scheduler → EventBridge trigger");
  });

  it("maps a scheduler component to Lambda + EventBridge (serverless context)", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "serverless-api",
        components: [
          comp("fn", "Handler", "backend", "AWS Lambda"),
          comp("job", "Nightly Job", "scheduler", "AWS Lambda scheduled"),
        ],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda from scheduler in serverless context");
    assert.ok(ids.includes("EventBridge"), "EventBridge from scheduler");
  });

  it("ArchitectureComponent evidence and confidence survive round-trip validation", () => {
    const { model } = validateArchitectureModel(
      makeModel({
        components: [
          {
            id: "api",
            name: "API Server",
            type: "backend",
            technology: "Express",
            evidence: ["package.json → express", "src/app.ts → new express()"],
            confidence: "high",
          },
          comp("db", "Database", "database", "PostgreSQL"),
        ],
      })
    );
    assert.ok(model, "model should validate");
    const api = model!.components.find((c) => c.id === "api");
    assert.ok(api, "api component should exist");
    assert.deepStrictEqual(api!.evidence, ["package.json → express", "src/app.ts → new express()"]);
    assert.strictEqual(api!.confidence, "high");
  });

  it("full-stack with frontend + api + postgres + redis + worker + queue → 6 distinct components map to 6 AWS services", () => {
    // Scenario 2 from the task: 6 distinct components must NOT collapse
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "full-stack-web",
        components: [
          comp("fe",     "React Frontend",  "frontend",  "React"),
          comp("api",    "Express API",     "backend",   "Express"),
          comp("db",     "Postgres DB",     "database",  "PostgreSQL"),
          comp("cache",  "Redis Cache",     "cache",     "Redis"),
          comp("worker", "Background Worker","worker",   "custom"),
          comp("queue",  "Task Queue",      "queue",     "Bull/BullMQ"),
        ],
        databases: ["PostgreSQL", "Redis"],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    // Each distinct component type must produce its own AWS service
    assert.ok(ids.includes("CloudFront"), `frontend → CloudFront; got ${ids.join(", ")}`);
    assert.ok(ids.includes("ECS"),        `backend/worker → ECS; got ${ids.join(", ")}`);
    assert.ok(ids.includes("RDS"),        `postgres → RDS; got ${ids.join(", ")}`);
    assert.ok(ids.includes("ElastiCache"),`redis cache → ElastiCache; got ${ids.join(", ")}`);
    assert.ok(ids.includes("SQS"),        `queue → SQS; got ${ids.join(", ")}`);
    // Plan must still pass schema validation
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, `Plan must satisfy ServicePlan schema: ${!check.success ? JSON.stringify(check.error.issues) : ""}`);
  });
});