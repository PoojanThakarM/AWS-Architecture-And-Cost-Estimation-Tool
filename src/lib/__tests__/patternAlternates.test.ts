/**
 * patternAlternates.test.ts
 *
 * Tests for curated architectural alternate proposals and multi-proposal migration:
 * 1. Acceptance Criteria 1: All 6 original patterns without a defined alternate produce
 *    identical diagram/cost/CFT output to pre-change behavior (regression-tested).
 * 2. Acceptance Criteria 2: The curated alternate pairs produce two distinct, valid
 *    diagrams + cost estimates + CFT templates side by side.
 * 3. Acceptance Criteria 3: diagram.ts and cftExport.ts correctly consume
 *    the array-based shape (1..N) with single-element arrays producing byte-identical
 *    output to single-path calls.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/patternAlternates.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRuleEngine, runRuleEngineProposals } from "../ruleEngine.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { getAlternateConfig } from "../patternAlternates.ts";
import { generateDiagramXml } from "../diagram.ts";
import { generateCftYaml, validateCloudFormationTemplate } from "../cftExport.ts";
import { computeCostRows } from "../cost.ts";
import { ServicePlanSchema } from "../schema.ts";

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

// ---------------------------------------------------------------------------
// 1. Acceptance Criteria 1: 6 Patterns WITHOUT Alternates Produce Identical Output
// ---------------------------------------------------------------------------

describe("Acceptance Criteria 1 — 6 patterns without alternates produce identical output", () => {
  const NON_ALTERNATE_PATTERNS: { name: string; input: Partial<RuleInput> }[] = [
    {
      name: "static-site",
      input: {
        description: "A static portfolio website built with Gatsby and Vite",
        fileNames: ["index.html"],
        fileContent: "gatsby static site hosting",
      },
    },
    {
      name: "event-driven",
      input: {
        description: "An event processing backend using sqs queues and sns notifications",
        fileNames: ["events.json"],
        fileContent: "aws_sns_topic aws_sqs_queue message broker",
      },
    },
    {
      name: "ml-pipeline",
      input: {
        description: "A machine learning pipeline with SageMaker model training and Rekognition",
        fileNames: ["train.py"],
        fileContent: "import boto3\nsagemaker training job rekognition",
      },
    },
    {
      name: "full-stack-web",
      input: {
        description: "Enterprise web application with EC2 and PostgreSQL database on RDS",
        fileNames: ["server.js"],
        fileContent: "postgres://db:5432/app express server ec2 alb",
      },
    },
    {
      name: "data-pipeline",
      input: {
        description: "Data analytics warehouse pipeline with redshift etl and s3",
        fileNames: ["pipeline.py"],
        fileContent: "data pipeline etl redshift data warehouse",
      },
    },
    {
      name: "generic",
      input: {
        description: "",
        fileNames: [],
        fileContent: "",
      },
    },
  ];

  it("verifies exactly 6 patterns have no alternate configured in CURATED_ALTERNATE_PAIRS", () => {
    for (const p of NON_ALTERNATE_PATTERNS) {
      const config = getAlternateConfig(p.name);
      assert.equal(
        config,
        null,
        `Pattern ${p.name} should NOT have a defined alternate config`
      );
    }
  });

  for (const { name, input } of NON_ALTERNATE_PATTERNS) {
    it(`pattern "${name}" produces single proposal and byte-identical diagram, CFT, and cost`, async () => {
      const ruleInp = makeInput(input);
      const singlePlan = runRuleEngine(ruleInp);
      const arrayPlans = runRuleEngineProposals(ruleInp);

      // Must have exactly 1 proposal
      assert.equal(arrayPlans.length, 1, `Expected 1 proposal for pattern ${name}`);
      assert.equal(singlePlan.proposals?.length, 1);

      // 1. Diagram XML: single-path vs array-path byte-identical
      const singleXml = generateDiagramXml(singlePlan);
      const arrayXmls = generateDiagramXml(arrayPlans);
      assert.ok(Array.isArray(arrayXmls));
      assert.equal(arrayXmls.length, 1);
      assert.equal(
        arrayXmls[0],
        singleXml,
        `Diagram XML for ${name} must be byte-identical between single and array calls`
      );

      // 2. CFT YAML: single-path vs array-path byte-identical
      const singleCft = generateCftYaml(singlePlan);
      const arrayCfts = generateCftYaml(arrayPlans);
      assert.ok(Array.isArray(arrayCfts));
      assert.equal(arrayCfts.length, 1);
      assert.equal(
        arrayCfts[0],
        singleCft,
        `CFT YAML for ${name} must be byte-identical between single and array calls`
      );

      // 3. Cost rows: identical
      const singleCost = await computeCostRows(singlePlan, "us-east-1", 10_000);
      const arrayCost = await computeCostRows(arrayPlans[0], "us-east-1", 10_000);
      assert.equal(singleCost.totalMonthlyUsd, arrayCost.totalMonthlyUsd);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Acceptance Criteria 2: Curated Alternate Pairs Produce 2 Distinct Proposals
// ---------------------------------------------------------------------------

describe("Acceptance Criteria 2 — Curated alternate pairs produce distinct proposals side by side", () => {
  it("Trade-off 1: serverless-api produces DynamoDB OLTP primary vs. Data Pipeline OLAP alternate", async () => {
    const input = makeInput({
      description: "Serverless REST API microservice",
      fileNames: ["serverless.yml"],
      fileContent: "service: user-api\nprovider:\n  name: aws\n  runtime: nodejs20.x\naws-lambda handler dynamodb",
    });

    const primaryPlan = runRuleEngine(input);
    const proposals = runRuleEngineProposals(input);

    assert.equal(primaryPlan.detectedPattern, "serverless-api");
    assert.equal(proposals.length, 2, "serverless-api must return exactly 2 proposals");

    const [proposalA, proposalB] = proposals;

    // Proposal A (Serverless OLTP)
    assert.equal(proposalA.detectedPattern, "serverless-api");
    assert.equal(proposalA.proposalTitle, "Cost-Optimized Serverless (OLTP)");
    assert.ok(proposalA.awsMappings.some((m) => m.serviceId === "Lambda"));
    assert.ok(proposalA.awsMappings.some((m) => m.serviceId === "DynamoDB"));

    // Proposal B (Analytics-Heavy Data Pipeline)
    assert.equal(proposalB.detectedPattern, "data-pipeline");
    assert.equal(proposalB.proposalTitle, "Analytics-Heavy Data Pipeline (OLAP)");
    assert.ok(proposalB.awsMappings.some((m) => m.serviceId === "S3"));
    assert.ok(proposalB.awsMappings.some((m) => m.serviceId === "Redshift"));
    assert.ok(proposalB.awsMappings.some((m) => m.serviceId === "Kinesis"));
    assert.ok(!proposalB.awsMappings.some((m) => m.serviceId === "DynamoDB"));

    // Trade-off dimension documented
    assert.ok(proposalA.tradeOffDimension?.includes("Low-Latency Transactions"));
    assert.ok(proposalA.tradeOffDescription?.includes("DynamoDB"));

    // Both pass schema validation
    assert.ok(ServicePlanSchema.safeParse(proposalA).success);
    assert.ok(ServicePlanSchema.safeParse(proposalB).success);

    // Both generate distinct, valid diagrams
    const [xmlA, xmlB] = generateDiagramXml(proposals);
    assert.ok(xmlA.includes("mxGraphModel"));
    assert.ok(xmlB.includes("mxGraphModel"));
    assert.notEqual(xmlA, xmlB, "Diagrams for proposal A and B must be distinct");

    // Both generate distinct, valid CFT templates
    const [cftA, cftB] = generateCftYaml(proposals);
    assert.ok(cftA.includes("AWS::Lambda::Function"));
    assert.ok(cftB.includes("AWS::Redshift::Cluster") || cftB.includes("AWS::Kinesis::Stream"));
    assert.notEqual(cftA, cftB, "CFT YAMLs for proposal A and B must be distinct");
    assert.ok(validateCloudFormationTemplate(cftA).valid);
    assert.ok(validateCloudFormationTemplate(cftB).valid);

    // Both compute valid cost estimates
    const costA = await computeCostRows(proposalA, "us-east-1", 10_000);
    const costB = await computeCostRows(proposalB, "us-east-1", 10_000);
    assert.ok(costA.totalMonthlyUsd >= 0);
    assert.ok(costB.totalMonthlyUsd >= 0);
  });

  it("Trade-off 2: containerised-app produces ECS/Fargate primary vs. Lambda serverless alternate", async () => {
    const input = makeInput({
      description: "Dockerized web service",
      fileNames: ["Dockerfile", "docker-compose.yml"],
      fileContent: "FROM node:20-alpine\nEXPOSE 8080\nCMD npm start",
    });

    const primaryPlan = runRuleEngine(input);
    const proposals = runRuleEngineProposals(input);

    assert.equal(primaryPlan.detectedPattern, "containerised-app");
    assert.equal(proposals.length, 2, "containerised-app must return exactly 2 proposals");

    const [proposalA, proposalB] = proposals;

    // Proposal A (Containers)
    assert.equal(proposalA.detectedPattern, "containerised-app");
    assert.equal(proposalA.proposalTitle, "Containerised High-Throughput (ECS/Fargate)");
    assert.ok(proposalA.awsMappings.some((m) => m.serviceId === "ECS"));

    // Proposal B (Serverless scale-to-zero)
    assert.equal(proposalB.detectedPattern, "serverless-api");
    assert.equal(proposalB.proposalTitle, "Scale-to-Zero Serverless (Lambda)");
    assert.ok(proposalB.awsMappings.some((m) => m.serviceId === "Lambda"));
    assert.ok(proposalB.awsMappings.some((m) => m.serviceId === "APIGateway"));
    assert.ok(!proposalB.awsMappings.some((m) => m.serviceId === "ECS"));

    // Trade-off dimension documented
    assert.ok(proposalA.tradeOffDimension?.includes("Scale-to-Zero"));

    // Both pass schema validation
    assert.ok(ServicePlanSchema.safeParse(proposalA).success);
    assert.ok(ServicePlanSchema.safeParse(proposalB).success);

    // Both generate distinct, valid diagrams
    const [xmlA, xmlB] = generateDiagramXml(proposals);
    assert.ok(xmlA.includes("mxGraphModel"));
    assert.ok(xmlB.includes("mxGraphModel"));
    assert.notEqual(xmlA, xmlB);

    // Both generate distinct, valid CFT templates
    const [cftA, cftB] = generateCftYaml(proposals);
    assert.ok(cftA.includes("AWS::ECS::Service"));
    assert.ok(cftB.includes("AWS::Lambda::Function"));
    assert.notEqual(cftA, cftB);
    assert.ok(validateCloudFormationTemplate(cftA).valid);
    assert.ok(validateCloudFormationTemplate(cftB).valid);

    // Both compute valid cost estimates
    const costA = await computeCostRows(proposalA, "us-east-1", 10_000);
    const costB = await computeCostRows(proposalB, "us-east-1", 10_000);
    assert.ok(costA.totalMonthlyUsd >= 0);
    assert.ok(costB.totalMonthlyUsd >= 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Acceptance Criteria 3: Downstream Multi-Proposal Array API Contracts
// ---------------------------------------------------------------------------

describe("Acceptance Criteria 3 — Downstream consumers handle array shape with zero special-casing", () => {
  it("diagram.ts generateDiagramXml accepts single plan and 1..N array seamlessly", () => {
    const input = makeInput({
      fileNames: ["serverless.yml"],
      fileContent: "aws-lambda handler dynamodb",
    });
    const proposals = runRuleEngineProposals(input);

    // 1. Single plan call
    const single = generateDiagramXml(proposals[0]);
    assert.equal(typeof single, "string");

    // 2. Single-element array call
    const arrayOne = generateDiagramXml([proposals[0]]);
    assert.ok(Array.isArray(arrayOne));
    assert.equal(arrayOne.length, 1);
    assert.equal(arrayOne[0], single, "Single-element array must be byte-identical to single plan");

    // 3. Multi-element array call (N == 2)
    const arrayTwo = generateDiagramXml(proposals);
    assert.ok(Array.isArray(arrayTwo));
    assert.equal(arrayTwo.length, 2);
    assert.equal(arrayTwo[0], single);
    assert.ok(arrayTwo[1].includes("mxGraphModel"));
  });

  it("cftExport.ts generateCftYaml accepts single plan and 1..N array seamlessly", () => {
    const input = makeInput({
      fileNames: ["serverless.yml"],
      fileContent: "aws-lambda handler dynamodb",
    });
    const proposals = runRuleEngineProposals(input);

    // 1. Single plan call
    const single = generateCftYaml(proposals[0]);
    assert.equal(typeof single, "string");

    // 2. Single-element array call
    const arrayOne = generateCftYaml([proposals[0]]);
    assert.ok(Array.isArray(arrayOne));
    assert.equal(arrayOne.length, 1);
    assert.equal(arrayOne[0], single, "Single-element array must be byte-identical to single plan");

    // 3. Multi-element array call (N == 2)
    const arrayTwo = generateCftYaml(proposals);
    assert.ok(Array.isArray(arrayTwo));
    assert.equal(arrayTwo.length, 2);
    assert.equal(arrayTwo[0], single);
    assert.ok(arrayTwo[1].includes("AWSTemplateFormatVersion"));
  });

});
