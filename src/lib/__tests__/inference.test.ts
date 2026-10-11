/**
 * inference.test.ts
 *
 * Tests for the central reasoning flow in inference.ts:
 *  - grounding derivation
 *  - grounding confidence cap
 *  - runInference fallback to the rules baseline when no LLM is configured
 *
 * No real LLM or network calls — the test runner has no provider keys set,
 * so runInference takes its deterministic fallback path.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/inference.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInference, deriveGrounding, applyGroundingCap } from "../inference.ts";
import type { InferenceInput } from "../inference.ts";
import { ServicePlanSchema } from "../schema.ts";
import type { ServicePlan } from "../schema.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { validatePlanSemantics, generateSingleDiagramXml } from "../diagram.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRuleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    description: "",
    fileContent: "",
    fileNames: [],
    inputKind: "description",
    grounding: "description",
    truncated: false,
    parseErrors: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    inputKind: "description",
    components: [
      { id: "comp1", type: "backend", technology: "Lambda", evidence: ["explicit lambda"], confidence: "high", status: "detected" },
      { id: "comp2", type: "database", technology: "DynamoDB", evidence: ["dynamo ref"], confidence: "high", status: "detected" },
      { id: "comp3", type: "proxy", technology: "CloudWatch", evidence: ["always present"], confidence: "medium", status: "inferred" },
    ],
    awsMappings: [
      { componentId: "comp1", serviceId: "Lambda", confidence: "high", evidence: "explicit lambda", fromPattern: false },
      { componentId: "comp2", serviceId: "DynamoDB", confidence: "high", evidence: "dynamo ref", fromPattern: false },
      { componentId: "comp3", serviceId: "CloudWatch", confidence: "medium", evidence: "always present", fromPattern: false },
    ],
    relationships: [],
    deploymentModel: [],
    detectedPattern: "serverless-api",
    metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Fix 2 — Grounding derivation", () => {
  it("derives 'description' when description is non-empty", () => {
    const g = deriveGrounding({
      description: "My custom app",
      fetchedFiles: [{ content: "package.json content" }],
    });
    assert.strictEqual(g, "description");
  });

  it("derives 'repoFiles' when description is empty and file content was fetched", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [
        { content: "FROM node:22" },
        { content: null },
      ],
    });
    assert.strictEqual(g, "repoFiles");
  });

  it("derives 'filenameOnly' when fetch fails for all files but filenames were known", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [
        { content: null },
        { content: null },
      ],
    });
    assert.strictEqual(g, "filenameOnly");
    assert.notStrictEqual(g, "description", "Must never be 'description' when description is empty");
  });

  it("derives 'unfounded' when fetch failed AND no filenames were resolvable", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [],
    });
    assert.strictEqual(g, "unfounded");
    assert.notStrictEqual(g, "description");
  });
});

describe("Decision 19 — Grounding confidence cap", () => {
  it("does not cap confidence for repo / repoFiles grounding", () => {
    for (const g of ["repo", "repoFiles"] as const) {
      const result = applyGroundingCap(makePlan(), g);
      // Check that high confidence remains high
      const highConf = result.awsMappings.find(m => m.confidence === "high");
      assert.ok(highConf, `grounding=${g} must not cap high confidence`);
    }
  });

  it("caps all confidence to 'low' for description / filenameOnly / unfounded grounding", () => {
    for (const g of ["description", "filenameOnly", "unfounded"] as const) {
      const result = applyGroundingCap(makePlan(), g);
      for (const mapping of result.awsMappings) {
        assert.strictEqual(mapping.confidence, "low", `grounding=${g}: expected 'low' got '${mapping.confidence}'`);
      }
    }
  });
});

describe("runInference — no-LLM fallback", () => {
  it("returns a valid ServicePlan and a null architectureModel when no LLM is configured", async () => {
    const input: InferenceInput = {
      ruleInput: makeRuleInput({
        description: "react app with express api postgres and s3",
        inputKind: "description",
        grounding: "description",
      }),
      signals: null,
      description: "react app with express api postgres and s3",
      profile: null,
    };

    const result = await runInference(input);

    assert.strictEqual(result.architectureModel, null, "No LLM configured → no architecture model");
    const check = ServicePlanSchema.safeParse(result.plan);
    assert.ok(check.success, "Fallback plan must be a valid ServicePlan");
    assert.strictEqual(result.plan.inputKind, "description");
  });

  it("falls back to rules when the LLM path is unavailable, preserving input metadata", async () => {
    const input: InferenceInput = {
      ruleInput: makeRuleInput({
        inputKind: "github_url",
        grounding: "repoFiles",
        truncated: true,
        parseErrors: ["bad.yaml"],
      }),
      signals: null,
      description: "",
      profile: null,
    };

    const result = await runInference(input);
    assert.strictEqual(result.plan.metadata.grounding, "repoFiles");
    assert.strictEqual(result.plan.metadata.truncated, true);
    assert.deepStrictEqual(result.plan.metadata.parseErrors, ["bad.yaml"]);
  });
});

describe("Integration — Expanded Catalog Service Inference", () => {
  it("resolves newly catalogued AWS services into correctly-tiered, non-additional_N components in merged ServicePlan", async () => {
    const input: InferenceInput = {
      ruleInput: makeRuleInput({
        description: "Modern data and AI processing platform with Athena, Bedrock, Glue, KMS, and AppRunner",
        fileContent: [
          "import boto3",
          "athena_client = boto3.client('athena')",
          "bedrock_client = boto3.client('bedrock-runtime')",
          "glue_client = boto3.client('glue')",
          "kms_client = boto3.client('kms')",
          "apprunner_client = boto3.client('apprunner')",
        ].join("\n"),
        fileNames: ["athena_queries.py", "bedrock_app.py", "glue_etl.py", "kms_security.py", "apprunner_service.py"],
        inputKind: "description",
        grounding: "description",
      }),
      signals: null,
      description: "Modern data and AI processing platform with Athena, Bedrock, Glue, KMS, and AppRunner",
      profile: null,
    };

    const result = await runInference(input);
    const plan = result.plan;

    // 1. Schema validation passes
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, `Schema validation must pass: ${!check.success && JSON.stringify(check.error.issues)}`);

    // 2. Expected services are resolved in awsMappings
    const mappedServices = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(mappedServices.includes("Bedrock"), "Bedrock must be resolved");
    assert.ok(mappedServices.includes("Athena"), "Athena must be resolved");
    assert.ok(mappedServices.includes("Glue"), "Glue must be resolved");
    assert.ok(mappedServices.includes("KMS"), "KMS must be resolved");
    assert.ok(mappedServices.includes("AppRunner"), "AppRunner must be resolved");

    // 3. No component or mapping carries an additional_N identifier
    for (const comp of plan.components) {
      assert.ok(!comp.id.startsWith("additional_"), `Component ID '${comp.id}' must not be additional_N`);
      assert.ok(!comp.id.includes("additional"), `Component ID '${comp.id}' must not contain 'additional'`);
    }
    for (const mapping of plan.awsMappings) {
      assert.ok(!mapping.componentId.startsWith("additional_"), `Mapping componentId '${mapping.componentId}' must not be additional_N`);
      assert.ok(!mapping.componentId.includes("additional"), `Mapping componentId '${mapping.componentId}' must not contain 'additional'`);
    }

    // 4. Each service resolves to a correctly-tiered component type
    const bedrockComp = plan.components.find((c) => c.technology === "Bedrock");
    assert.ok(bedrockComp, "Bedrock component must exist");
    assert.strictEqual(bedrockComp.type, "backend", "Bedrock should have compute/backend tier");

    const athenaComp = plan.components.find((c) => c.technology === "Athena");
    assert.ok(athenaComp, "Athena component must exist");
    assert.strictEqual(athenaComp.type, "database", "Athena should have database/query tier");

    const glueComp = plan.components.find((c) => c.technology === "Glue");
    assert.ok(glueComp, "Glue component must exist");
    assert.strictEqual(glueComp.type, "worker", "Glue should have worker tier");

    const kmsComp = plan.components.find((c) => c.technology === "KMS");
    assert.ok(kmsComp, "KMS component must exist");
    assert.strictEqual(kmsComp.type, "auth", "KMS should have auth/security tier");

    const apprunnerComp = plan.components.find((c) => c.technology === "AppRunner");
    assert.ok(apprunnerComp, "AppRunner component must exist");
    assert.strictEqual(apprunnerComp.type, "backend", "AppRunner should have compute/backend tier");
  });

  it("ServicePlanSchema auto-deduplicates duplicate componentIds with warning", () => {
    const rawPlan = {
      inputKind: "description" as const,
      components: [
        { id: "frontend", type: "frontend" as const, technology: "React", evidence: [], confidence: "high" as const, status: "detected" as const },
        { id: "frontend", type: "frontend" as const, technology: "React (duplicate)", evidence: [], confidence: "medium" as const, status: "inferred" as const },
        { id: "backend", type: "backend" as const, technology: "Node", evidence: [], confidence: "high" as const, status: "detected" as const },
      ],
      awsMappings: [
        { componentId: "frontend", serviceId: "CloudFront" as const, confidence: "high" as const, evidence: "cdn", fromPattern: false },
        { componentId: "backend", serviceId: "ECS" as const, confidence: "high" as const, evidence: "compute", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      detectedPattern: "full-stack-web",
      metadata: { grounding: "description" as const, truncated: false, parseErrors: [] },
      warnings: [],
    };

    const check = ServicePlanSchema.safeParse(rawPlan);
    assert.ok(check.success, "ServicePlanSchema must succeed with auto-deduplication");
    assert.strictEqual(check.data.components.length, 2, "Must deduplicate to 2 components");
    assert.strictEqual(check.data.components[0].id, "frontend");
    assert.strictEqual(check.data.components[1].id, "backend");
    assert.ok(
      check.data.warnings.some((w) => w.includes("Duplicate componentId detected")),
      "Must record duplicate componentId warning"
    );
  });
});