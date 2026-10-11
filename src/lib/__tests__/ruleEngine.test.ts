/**
 * ruleEngine.test.ts
 *
 * Tests for the deterministic rule engine (BuildOrder Stage 1).
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra deps.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/ruleEngine.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRuleEngine } from "../ruleEngine.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { SERVICE_IDS, ServicePlanSchema } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<RuleInput> = {}): RuleInput {
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

function serviceIds(plan: ReturnType<typeof runRuleEngine>): string[] {
  return plan.awsMappings.map((m) => m.serviceId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRuleEngine — always produces a valid ServicePlan", () => {
  it("empty input returns a valid plan (generic pattern fallback)", () => {
    const plan = runRuleEngine(makeInput());
    const result = ServicePlanSchema.safeParse(plan);
    assert.ok(result.success, `Schema failed: ${!result.success && JSON.stringify(result.error.issues)}`);
  });

  it("passes schema validation in all cases (catalog allowlist)", () => {
    const inputs: Partial<RuleInput>[] = [
      { description: "a real-time chat app with react frontend" },
      { fileNames: ["Dockerfile", "docker-compose.yml"], fileContent: "FROM node:22" },
      { fileNames: ["serverless.yml"], fileContent: "aws-lambda handler dynamodb" },
      { description: "machine learning model training pipeline with sagemaker" },
      { description: "data pipeline with kinesis redshift s3 etl" },
    ];
    for (const inp of inputs) {
      const plan = runRuleEngine(makeInput(inp));
      const result = ServicePlanSchema.safeParse(plan);
      assert.ok(result.success, `Schema failed for input ${JSON.stringify(inp)}: ${!result.success && JSON.stringify(result.error.issues)}`);
    }
  });

  it("every serviceId in awsMappings is in the catalog allowlist", () => {
    const plan = runRuleEngine(makeInput({
      description: "react app with express api postgres s3 cloudfront cloudwatch cognito sqs sns",
      fileContent: "DATABASE_URL=postgresql://localhost:5432/db",
    }));
    const ids = serviceIds(plan);
    const allowlist = new Set<string>(SERVICE_IDS);
    for (const id of ids) {
      assert.ok(allowlist.has(id), `${id} is not in catalog allowlist`);
    }
  });

  it("supports >12 distinct services without hard truncation", () => {
    // Give it a ton of signals to verify the old 12-cap is removed
    const plan = runRuleEngine(makeInput({
      description: "lambda apigateway dynamodb s3 cloudfront route53 sqs sns eventbridge cognito elasticache rds ec2 ecs fargate eks ecr alb kinesis sagemaker",
      fileContent: "sagemaker rekognition comprehend bedrock DATABASE_URL=postgresql://localhost REDIS_URL=redis://localhost",
      fileNames: ["Dockerfile", "serverless.yml", "docker-compose.yml", "terraform/main.tf"],
    }));
    const unique = new Set(serviceIds(plan));
    assert.ok(unique.size > 12, `Expected >12 services with hard cap removed, got ${unique.size}`);
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "Plan with >12 services must pass validation");
  });

  it("validates a 20+ service valid plan successfully", () => {
    const twentyPlusServices = [
      "EC2", "Lambda", "ECS", "EKS", "Fargate", "Batch",
      "S3", "EBS", "EFS", "Glacier",
      "RDS", "Aurora", "DynamoDB", "ElastiCache", "Redshift",
      "CloudFront", "APIGateway", "ALB", "Route53", "VPC",
      "SQS", "SNS",
    ] as const;
    const plan = {
      inputKind: "description" as const,
      components: twentyPlusServices.map((s) => ({
        id: `c-${s.toLowerCase()}`,
        type: "backend" as const,
        technology: s,
        evidence: ["test"],
        confidence: "high" as const,
        status: "detected" as const,
      })),
      relationships: [],
      deploymentModel: [],
      awsMappings: twentyPlusServices.map((s) => ({
        componentId: `c-${s.toLowerCase()}`,
        serviceId: s,
        confidence: "high" as const,
        evidence: "test",
        fromPattern: false,
      })),
      metadata: { grounding: "repo" as const, truncated: false, parseErrors: [] },
      warnings: [],
    };
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "20+ service plan must parse successfully");
    assert.strictEqual(check.data.warnings.length, 0, "No warning when <=25 services");
  });

  it("parses real-but-previously-uncatalogued AWS services successfully", () => {
    const newServices = ["Bedrock", "Athena", "EMR", "StepFunctions", "KMS", "AppRunner", "Glue"] as const;
    const plan = {
      inputKind: "description" as const,
      components: newServices.map((s) => ({
        id: `c-${s.toLowerCase()}`,
        type: "backend" as const,
        technology: s,
        evidence: ["test"],
        confidence: "high" as const,
        status: "detected" as const,
      })),
      relationships: [],
      deploymentModel: [],
      awsMappings: newServices.map((s) => ({
        componentId: `c-${s.toLowerCase()}`,
        serviceId: s,
        confidence: "high" as const,
        evidence: "test",
        fromPattern: false,
      })),
      metadata: { grounding: "repo" as const, truncated: false, parseErrors: [] },
      warnings: [],
    };
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "Previously uncatalogued AWS services must parse successfully");
  });

  it("fails validation when a genuinely hallucinated service string is provided", () => {
    const plan = {
      inputKind: "description" as const,
      components: [{
        id: "c1",
        type: "backend" as const,
        technology: "FakeAwsCloudDatabase",
        evidence: ["test"],
        confidence: "high" as const,
        status: "detected" as const,
      }],
      relationships: [],
      deploymentModel: [],
      awsMappings: [{
        componentId: "c1",
        serviceId: "FakeAwsCloudDatabase" as any,
        confidence: "high" as const,
        evidence: "test",
        fromPattern: false,
      }],
      metadata: { grounding: "repo" as const, truncated: false, parseErrors: [] },
      warnings: [],
    };
    const check = ServicePlanSchema.safeParse(plan);
    assert.strictEqual(check.success, false, "Hallucinated service string must fail validation");
  });

  it("fires soft-cap warning at >25 services without failing parse", () => {
    const twentySixServices = [
      "EC2", "Lambda", "ECS", "EKS", "Fargate", "Batch",
      "S3", "EBS", "EFS", "Glacier",
      "RDS", "Aurora", "DynamoDB", "ElastiCache", "Redshift",
      "CloudFront", "APIGateway", "ALB", "Route53", "VPC",
      "SQS", "SNS", "EventBridge", "Kinesis", "MSK",
      "Cognito", "SecretsManager",
    ] as const;
    const plan = {
      inputKind: "description" as const,
      components: twentySixServices.map((s) => ({
        id: `c-${s.toLowerCase()}`,
        type: "backend" as const,
        technology: s,
        evidence: ["test"],
        confidence: "high" as const,
        status: "detected" as const,
      })),
      relationships: [],
      deploymentModel: [],
      awsMappings: twentySixServices.map((s) => ({
        componentId: `c-${s.toLowerCase()}`,
        serviceId: s,
        confidence: "high" as const,
        evidence: "test",
        fromPattern: false,
      })),
      metadata: { grounding: "repo" as const, truncated: false, parseErrors: [] },
      warnings: [],
    };
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "Plan with >25 services must not fail safeParse");
    assert.ok(check.data.warnings.length > 0, "Warnings array must contain soft-ceiling warning");
    assert.ok(check.data.warnings[0].includes("exceeds soft ceiling of 25 services"), "Warning text must mention 25 services ceiling");
  });
});

describe("runRuleEngine — pattern classification (detectedPattern for UI label only)", () => {
  it("classifies static site correctly", () => {
    const plan = runRuleEngine(makeInput({
      description: "a gatsby static site deployed to s3 with cloudfront cdn",
      fileNames: ["vercel.json"],
    }));
    assert.strictEqual(plan.detectedPattern, "static-site");
  });

  it("classifies serverless API correctly — serverless.yml signal", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["serverless.yml"],
      fileContent: "aws-lambda handler dynamodb apigateway",
    }));
    assert.strictEqual(plan.detectedPattern, "serverless-api");
  });

  it("classifies serverless API — SAM template.yaml signal", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["template.yaml"],
      fileContent: "AWS::Lambda::Function AWS::ApiGateway::RestApi",
    }));
    assert.strictEqual(plan.detectedPattern, "serverless-api");
  });

  it("classifies containerised app — Dockerfile present", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile", "docker-compose.yml"],
      fileContent: "FROM node:22\nfargate ecs",
    }));
    assert.strictEqual(plan.detectedPattern, "containerised-app");
  });

  it("classifies ML pipeline", () => {
    const plan = runRuleEngine(makeInput({
      description: "sagemaker training job pytorch model with s3 dataset and inference endpoint",
    }));
    assert.strictEqual(plan.detectedPattern, "ml-pipeline");
  });

  it("classifies event-driven when SQS/Kinesis signals dominate", () => {
    const plan = runRuleEngine(makeInput({
      description: "kafka consumer producer sqs eventbridge async message queue worker",
    }));
    assert.strictEqual(plan.detectedPattern, "event-driven");
  });

  it("classifies data pipeline", () => {
    const plan = runRuleEngine(makeInput({
      description: "ETL data pipeline kinesis s3 glue redshift athena data warehouse",
    }));
    assert.strictEqual(plan.detectedPattern, "data-pipeline");
  });

  it("falls back to generic when signals are too weak", () => {
    const plan = runRuleEngine(makeInput({ description: "my cool project" }));
    const result = ServicePlanSchema.safeParse(plan);
    assert.ok(result.success);
  });
});

describe("Fix 5 — Two-tier signals & CloudWatch gating", () => {
  it("(a) Docker-only repo → RDS only as low-confidence suggestion, ElastiCache absent", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile"],
      fileContent: "FROM node:22\nCOPY . .\nCMD ['node', 'index.js']\n// mentioning postgres and redis in comments only",
    }));
    const ids = serviceIds(plan);
    // Uncorroborated driver + Dockerfile → low-confidence RDS suggestion (Fix 3c.4).
    const rdsMapping = plan.awsMappings.find(m => m.serviceId === "RDS");
    assert.ok(rdsMapping, "RDS low-confidence suggestion expected for uncorroborated driver + Dockerfile");
    assert.strictEqual(rdsMapping.confidence, "low", "Uncorroborated RDS must stay low confidence");
    assert.ok(!ids.includes("ElastiCache"), "ElastiCache must not appear in services[] for Docker-only repo");

    // Check low confidence mappings exist
    const ecMapping = plan.awsMappings.find(m => m.serviceId === "ElastiCache");
    if (ecMapping) assert.strictEqual(ecMapping.confidence, "low", "ElastiCache should be low confidence");
  });

  it("(b) Docker + Postgres connection string → RDS promoted to services[]", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile", ".env.example"],
      fileContent: "FROM node:22\nDATABASE_URL=postgresql://user:pass@localhost:5432/mydb",
    }));
    const ids = serviceIds(plan);
    assert.ok(ids.includes("RDS"), "RDS should be promoted to services[] when corroborated by connection string");
  });

  it("(c) empty plan → no CloudWatch", () => {
    const plan = runRuleEngine(makeInput({ description: "" }));
    const ids = serviceIds(plan);
    assert.ok(!ids.includes("CloudWatch"), "CloudWatch must not be added when no compute service is present");
  });

  it("(d) Lambda present → CloudWatch present", () => {
    const plan = runRuleEngine(makeInput({
      description: "aws-lambda handler",
    }));
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda should be present");
    assert.ok(ids.includes("CloudWatch"), "CloudWatch must be present when Lambda (compute) is present");
  });
});

describe("runRuleEngine — service detection", () => {
  it("detects Lambda from aws-lambda text", () => {
    const plan = runRuleEngine(makeInput({
      description: "aws-lambda function handler.js",
    }));
    assert.ok(serviceIds(plan).includes("Lambda"), "Expected Lambda to be detected");
  });

  it("detects DynamoDB from dynamo keyword", () => {
    const plan = runRuleEngine(makeInput({
      description: "dynamodb table for storing user sessions",
    }));
    assert.ok(serviceIds(plan).includes("DynamoDB"), "Expected DynamoDB");
  });

  it("detects S3 from s3:// prefix", () => {
    const plan = runRuleEngine(makeInput({
      fileContent: "aws s3 cp myfile.zip s3://my-bucket/",
    }));
    assert.ok(serviceIds(plan).includes("S3"), "Expected S3");
  });

  it("detects EKS from kubernetes keyword", () => {
    const plan = runRuleEngine(makeInput({
      description: "kubernetes cluster k8s kubectl deployment",
    }));
    assert.ok(serviceIds(plan).includes("EKS"), "Expected EKS from k8s signal");
  });

  it("detects Aurora (not RDS) when aurora engine declared", () => {
    const plan = runRuleEngine(makeInput({
      fileContent: 'resource "aws_rds_cluster" "x" {\n  engine = "aurora-mysql"\n}',
    }));
    assert.ok(serviceIds(plan).includes("Aurora"), "Expected Aurora");
    assert.ok(!serviceIds(plan).includes("RDS"), "Should not have both Aurora and RDS");
  });

  it("does not infer Aurora from bare prose mention", () => {
    const plan = runRuleEngine(makeInput({
      fileContent: "aurora mysql cluster endpoint",
    }));
    assert.ok(!serviceIds(plan).includes("Aurora"), "Bare word must not trigger Aurora");
  });
});

describe("Fix 10 — terminal states", () => {
  it("empty input resolves to LIBRARY_REPO", () => {
    const plan = runRuleEngine(makeInput());
    assert.strictEqual(plan.terminalState, "LIBRARY_REPO");
  });

  it("IaC-only profile resolves to IAC_ONLY", () => {
    const plan = runRuleEngine(makeInput({
      inputKind: "github_url",
      grounding: "repoFiles",
      fileNames: ["main.tf"],
      fileContent: '### main.tf\nresource "aws_eks_cluster" "x" {}',
      profile: {
        languages: [], frameworks: [], databases: [], infrastructure: [
          { name: "Terraform resource (EKS)", evidence: "main.tf", confidence: "high" },
        ],
        entryPoints: [], awsUsage: [], deploymentHints: [],
        isIacOnly: true,
        discoveredComponents: [],
        summary: "",
      },
    }));
    assert.strictEqual(plan.terminalState, "IAC_ONLY");
    assert.ok(serviceIds(plan).includes("EKS"));
  });

  it("backend framework repo resolves to OK", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["go.mod"],
      fileContent: "module x\nrequire github.com/gin-gonic/gin v1.9.1",
      profile: {
        languages: [{ name: "Go", evidence: "go.mod", confidence: "high" }],
        frameworks: [{ name: "Gin", evidence: "go.mod", confidence: "high" }],
        databases: [], infrastructure: [],
        entryPoints: [], awsUsage: [], deploymentHints: [],
        discoveredComponents: [],
        summary: "",
      },
    }));
    assert.strictEqual(plan.terminalState, "OK");
    assert.ok(serviceIds(plan).includes("ECS"));
  });

  it("multi-directory multi-backend repo resolves to MONOREPO_OK", () => {
    const plan = runRuleEngine(makeInput({
      inputKind: "github_url",
      grounding: "repoFiles",
      fileNames: ["pnpm-workspace.yaml", "svc-a/Dockerfile", "svc-b/Dockerfile"],
      fileContent: "FROM node:22",
      profile: {
        languages: [{ name: "Node.js/TypeScript", evidence: "package.json", confidence: "high" }],
        frameworks: [{ name: "Express.js", evidence: "package.json", confidence: "high" }],
        databases: [],
        infrastructure: [{ name: "Docker (Dockerfile)", evidence: "svc-a/Dockerfile", confidence: "high" }],
        entryPoints: [], awsUsage: [], deploymentHints: [],
        discoveredComponents: [
          { id: "dc-a", name: "a", type: "backend", technology: "custom", evidence: ["svc-a/Dockerfile"], confidence: "high", source: "docker-compose" },
          { id: "dc-b", name: "b", type: "backend", technology: "custom", evidence: ["svc-b/Dockerfile"], confidence: "high", source: "docker-compose" },
        ],
        summary: "",
      },
    }));
    assert.strictEqual(plan.terminalState, "MONOREPO_OK");
  });
});

describe("runRuleEngine — metadata passthrough", () => {
  it("passes grounding from input to plan.metadata", () => {
    const plan = runRuleEngine(makeInput({ grounding: "repo", inputKind: "github_url" }));
    assert.strictEqual(plan.metadata.grounding, "repo");
  });

  it("passes truncated flag", () => {
    const plan = runRuleEngine(makeInput({ truncated: true }));
    assert.strictEqual(plan.metadata.truncated, true);
  });

  it("passes parseErrors", () => {
    const plan = runRuleEngine(makeInput({ parseErrors: ["bad.yaml"] }));
    assert.deepStrictEqual(plan.metadata.parseErrors, ["bad.yaml"]);
  });

  it("preserves inputKind on the plan", () => {
    const planGh = runRuleEngine(makeInput({ inputKind: "github_url", grounding: "repo" }));
    assert.strictEqual(planGh.inputKind, "github_url");
    const planDesc = runRuleEngine(makeInput({ inputKind: "description" }));
    assert.strictEqual(planDesc.inputKind, "description");
  });
});

// ---------------------------------------------------------------------------
// discoveredComponents integration (Fix DC)
// ---------------------------------------------------------------------------

import type { ProjectProfile } from "../repoAnalyzer.ts";
import type { DiscoveredComponent } from "../repoAnalyzer.ts";

function makeProfile(components: DiscoveredComponent[]): ProjectProfile {
  return {
    languages: [],
    frameworks: [],
    databases: [],
    infrastructure: [],
    entryPoints: [],
    awsUsage: [],
    deploymentHints: [],
    discoveredComponents: components,
    summary: "",
  };
}

function dc(
  id: string,
  name: string,
  type: DiscoveredComponent["type"],
  technology: string,
  source: DiscoveredComponent["source"] = "docker-compose"
): DiscoveredComponent {
  return { id, name, type, technology, evidence: [`docker-compose.yml → services.${name}`], confidence: "high", source };
}

describe("Fix DC — discoveredComponents drive rule engine service detection", () => {
  it("static site: static site repo still maps to just S3 + CloudFront (no padding)", () => {
    // The three-scenario regression test from the task.
    const plan = runRuleEngine(makeInput({
      description: "a gatsby static site",
      fileNames: ["vercel.json", "package.json"],
      fileContent: "gatsby vite static",
      profile: makeProfile([]),
    }));
    assert.strictEqual(plan.detectedPattern, "static-site");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("S3"), "static site needs S3");
    assert.ok(ids.includes("CloudFront"), "static site needs CloudFront");
    // Must NOT be padded with unwarranted services
    assert.ok(!ids.includes("ECS"), "static site must not gain ECS");
    assert.ok(!ids.includes("SQS"), "static site must not gain SQS");
    assert.ok(!ids.includes("RDS"), "static site must not gain RDS");
  });

  it("docker-compose with api + worker + postgres + redis + queue → all five show up as distinct services", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["docker-compose.yml", "Dockerfile"],
      fileContent: "FROM node:22",
      profile: makeProfile([
        dc("dc-api",      "api",      "backend",  "custom"),
        dc("dc-worker",   "worker",   "worker",   "custom"),
        dc("dc-postgres", "postgres", "database", "PostgreSQL"),
        dc("dc-redis",    "redis",    "cache",    "Redis"),
        dc("dc-queue",    "queue",    "queue",    "Bull/BullMQ"),
      ]),
    }));

    const ids = serviceIds(plan);
    assert.ok(
      ids.includes("ECS"),
      `Expected ECS for containerised backend/worker, got: ${ids.join(", ")}`
    );
    assert.ok(
      ids.includes("RDS"),
      `Expected RDS for PostgreSQL service, got: ${ids.join(", ")}`
    );
    assert.ok(
      ids.includes("ElastiCache"),
      `Expected ElastiCache for Redis service, got: ${ids.join(", ")}`
    );
    assert.ok(
      ids.includes("SQS"),
      `Expected SQS for queue service, got: ${ids.join(", ")}`
    );
    // CloudWatch gated on compute — ECS is present so CloudWatch should appear
    assert.ok(ids.includes("CloudWatch"), "CloudWatch should be present when ECS is present");
  });

  it("docker-compose services drive discovered components independently of keyword matching", () => {
    // This repo has NO keyword text in fileContent mentioning postgres/redis/SQS —
    // the only evidence is the discoveredComponents from docker-compose parsing.
    const plan = runRuleEngine(makeInput({
      description: "",
      fileContent: "FROM node:22\nCOPY . .\nCMD node dist/server.js",
      fileNames: ["docker-compose.yml", "Dockerfile"],
      profile: makeProfile([
        dc("dc-backend", "backend", "backend", "custom"),
        dc("dc-db",      "db",      "database", "PostgreSQL"),
        dc("dc-cache",   "cache",   "cache",    "Redis"),
      ]),
    }));

    const ids = serviceIds(plan);
    assert.ok(ids.includes("RDS"), "RDS must come from discoveredComponent, not keyword");
    assert.ok(ids.includes("ElastiCache"), "ElastiCache must come from discoveredComponent, not keyword");
    assert.ok(ids.includes("ECS"), "ECS from container pattern");
  });

  it("serverless.yml functions appear as distinct Lambda + EventBridge for scheduler", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["serverless.yml"],
      fileContent: "provider: aws\nruntime: nodejs22.x",
      profile: makeProfile([
        dc("sls-api",       "api-handler",  "api",       "AWS Lambda", "serverless-yml"),
        dc("sls-worker",    "msg-processor","worker",    "AWS Lambda", "serverless-yml"),
        dc("sls-scheduler", "daily-report", "scheduler", "AWS Lambda", "serverless-yml"),
      ]),
    }));

    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda from serverless functions");
    assert.ok(ids.includes("APIGateway"), "APIGateway from api-type function");
    assert.ok(ids.includes("EventBridge"), "EventBridge from scheduler function");
  });
});