/**
 * cftExport.test.ts
 *
 * Tests for CloudFormation YAML generator:
 *  - Generates valid, deployable templates for all 6 core patterns:
 *      1. serverless-rest-api
 *      2. containerized-web-app
 *      3. static-site-cdn
 *      4. event-driven-pipeline
 *      5. full-stack-serverless
 *      6. worker-queue
 *  - Validation with strict CloudFormation structural & semantic linter (cfn-lint equivalent)
 *  - Resource mapping table coverage across services
 *  - IAM role/policy synthesis (LambdaExecutionRole, EcsTaskExecutionRole)
 *  - Decision 33 IaC disclaimer inclusion in comments and Description
 *  - Diagram XML service extraction
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/cftExport.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  generateCftYaml,
  generateCftFromServices,
  extractServicesFromDiagramXml,
  generateCftFromDiagramXml,
  validateCloudFormationTemplate,
  CFT_SERVICE_RESOURCE_MAP,
  PATTERN_CANONICAL_SERVICES,
  CFT_DISCLAIMER_TEXT,
} from "../cftExport.ts";
import type { ServicePlan, ServiceId } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanForPattern(pattern: string, serviceIds: ServiceId[]): ServicePlan {
  return {
    inputKind: "description",
    components: serviceIds.map((id, idx) => ({
      id: `c-${idx}`,
      type: "backend",
      technology: id,
      evidence: [`explicit ${id}`],
      confidence: "high",
      status: "detected",
    })),
    awsMappings: serviceIds.map((id, idx) => ({
      componentId: `c-${idx}`,
      serviceId: id,
      confidence: "high",
      evidence: `explicit ${id}`,
      fromPattern: true,
    })),
    relationships: [],
    deploymentModel: [],
    detectedPattern: pattern,
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
  };
}

describe("CFT Export — Resource Mapping Table", () => {
  it("defines resource specifications for core AWS services", () => {
    const coreServices = [
      "Lambda",
      "APIGateway",
      "S3",
      "CloudFront",
      "DynamoDB",
      "SQS",
      "SNS",
      "EventBridge",
      "ECS",
      "Fargate",
      "EC2",
      "ALB",
      "VPC",
      "RDS",
      "Cognito",
      "CloudWatch",
    ];

    for (const service of coreServices) {
      const spec = CFT_SERVICE_RESOURCE_MAP[service];
      assert.ok(spec, `Missing CFT_SERVICE_RESOURCE_MAP entry for ${service}`);
      assert.ok(spec.primaryType.startsWith("AWS::"), `Invalid primaryType for ${service}`);
      assert.ok(typeof spec.generateResources === "function", `Missing generator for ${service}`);
    }
  });

  it("provides canonical service definitions for all 6 patterns", () => {
    const patterns = [
      "serverless-rest-api",
      "containerized-web-app",
      "static-site-cdn",
      "event-driven-pipeline",
      "full-stack-serverless",
      "worker-queue",
    ];

    for (const pat of patterns) {
      const services = PATTERN_CANONICAL_SERVICES[pat];
      assert.ok(services && services.length > 0, `Missing canonical services for ${pat}`);
      for (const s of services) {
        assert.ok(CFT_SERVICE_RESOURCE_MAP[s], `Canonical service ${s} not in resource map`);
      }
    }
  });
});

describe("CFT Export — 6 Core Architecture Patterns", () => {
  it("Pattern 1: serverless-rest-api produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("serverless-rest-api", ["APIGateway", "Lambda", "DynamoDB", "CloudWatch"]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.equal(doc.AWSTemplateFormatVersion, "2010-09-09");
    assert.ok(doc.Description.includes(CFT_DISCLAIMER_TEXT));
    assert.ok(doc.Resources.AppFunction, "Missing Lambda function");
    assert.ok(doc.Resources.LambdaExecutionRole, "Missing Lambda IAM role");
    assert.ok(doc.Resources.HttpApi, "Missing API Gateway");
    assert.ok(doc.Resources.AppTable, "Missing DynamoDB table");
    assert.ok(doc.Resources.AppLogGroup, "Missing CloudWatch log group");
  });

  it("Pattern 2: containerized-web-app produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("containerized-web-app", ["ALB", "ECS", "ECR", "VPC", "RDS", "CloudWatch"]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.ok(doc.Resources.ApplicationLoadBalancer, "Missing ALB");
    assert.ok(doc.Resources.EcsCluster, "Missing ECS Cluster");
    assert.ok(doc.Resources.EcsTaskExecutionRole, "Missing ECS IAM execution role");
    assert.ok(doc.Resources.EcsTaskDefinition, "Missing ECS Task Definition");
    assert.ok(doc.Resources.EcsService, "Missing ECS Service");
    assert.ok(doc.Resources.AppVpc, "Missing VPC");
    assert.ok(doc.Resources.AppDatabase, "Missing RDS DB");
  });

  it("Pattern 3: static-site-cdn produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("static-site-cdn", ["CloudFront", "S3", "Route53"]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.ok(doc.Resources.CloudFrontDistribution, "Missing CloudFront distribution");
    assert.ok(doc.Resources.AppBucket, "Missing S3 bucket");
    assert.ok(doc.Resources.AppHostedZone, "Missing Route53 hosted zone");

    // S3 origin link check
    const origin = doc.Resources.CloudFrontDistribution.Properties.DistributionConfig.Origins[0];
    assert.equal(origin.Id, "S3Origin");
  });

  it("Pattern 4: event-driven-pipeline produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("event-driven-pipeline", ["EventBridge", "SQS", "Lambda", "DynamoDB", "CloudWatch"]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.ok(doc.Resources.AppEventBus, "Missing EventBridge bus");
    assert.ok(doc.Resources.AppQueue, "Missing SQS queue");
    assert.ok(doc.Resources.AppDeadLetterQueue, "Missing DLQ");
    assert.ok(doc.Resources.AppFunction, "Missing Lambda");
    assert.ok(doc.Resources.LambdaSqsTrigger, "Missing Lambda SQS trigger");
  });

  it("Pattern 5: full-stack-serverless produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("full-stack-serverless", [
      "CloudFront",
      "S3",
      "APIGateway",
      "Lambda",
      "DynamoDB",
      "Cognito",
    ]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.ok(doc.Resources.CloudFrontDistribution);
    assert.ok(doc.Resources.AppBucket);
    assert.ok(doc.Resources.HttpApi);
    assert.ok(doc.Resources.AppFunction);
    assert.ok(doc.Resources.AppTable);
    assert.ok(doc.Resources.CognitoUserPool);
    assert.ok(doc.Resources.CognitoUserPoolClient);
  });

  it("Pattern 6: worker-queue produces valid, lint-passing CFT template", () => {
    const plan = makePlanForPattern("worker-queue", ["SQS", "Lambda", "DynamoDB", "CloudWatch"]);
    const yaml = generateCftYaml(plan);

    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join(", ")}`);

    const doc = parse(yaml);
    assert.ok(doc.Resources.AppQueue);
    assert.ok(doc.Resources.AppFunction);
    assert.ok(doc.Resources.AppTable);
    assert.ok(doc.Resources.AppLogGroup);
  });
});

describe("CFT Export — Parameterization & Disclaimers", () => {
  it("supports custom Environment and AppName parameters", () => {
    const plan = makePlanForPattern("serverless-api", ["Lambda", "S3"]);
    const yaml = generateCftYaml(plan, { appName: "my-custom-service", environment: "prod" });

    const doc = parse(yaml);
    assert.equal(doc.Parameters.AppName.Default, "my-custom-service");
    assert.equal(doc.Parameters.Environment.Default, "prod");
    assert.deepEqual(doc.Parameters.Environment.AllowedValues, ["dev", "staging", "prod"]);
  });

  it("embeds the Decision 33 IaC disclaimer in YAML comments and Description", () => {
    const plan = makePlanForPattern("serverless-api", ["Lambda"]);
    const yaml = generateCftYaml(plan);

    assert.ok(yaml.includes("DISCLAIMER (Decision 33):"));
    assert.ok(yaml.includes("This is a starting architectural template, not production-ready IaC."));

    const doc = parse(yaml);
    assert.ok(doc.Description.includes("Starting architectural template, not production-ready IaC"));
  });
});

describe("CFT Export — Diagram XML Extraction & Direct Generation", () => {
  it("extracts detected pattern and mapped services from mxGraph XML", () => {
    const sampleXml = `
      <mxGraphModel>
        <root>
          <mxCell id="0"/>
          <mxCell id="1" parent="0"/>
          <!-- Pattern: serverless-api -->
          <mxCell id="2" value="AWS Lambda" parent="1" vertex="1" />
          <mxCell id="3" value="Amazon DynamoDB" parent="1" vertex="1" />
          <mxCell id="4" value="Amazon S3" parent="1" vertex="1" />
        </root>
      </mxGraphModel>
    `;

    const extracted = extractServicesFromDiagramXml(sampleXml);
    assert.equal(extracted.pattern, "serverless-api");
    assert.ok(extracted.serviceIds.includes("Lambda"));
    assert.ok(extracted.serviceIds.includes("DynamoDB"));
    assert.ok(extracted.serviceIds.includes("S3"));

    const yaml = generateCftFromDiagramXml(sampleXml);
    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true);

    const doc = parse(yaml);
    assert.ok(doc.Resources.AppFunction);
    assert.ok(doc.Resources.AppTable);
    assert.ok(doc.Resources.AppBucket);
  });

  it("generateCftFromServices works directly from an array of service IDs", () => {
    const yaml = generateCftFromServices("data-pipeline", ["Kinesis", "S3", "CloudWatch"]);
    const validation = validateCloudFormationTemplate(yaml);
    assert.equal(validation.valid, true);

    const doc = parse(yaml);
    assert.ok(doc.Resources.AppStream);
    assert.ok(doc.Resources.AppBucket);
    assert.ok(doc.Resources.AppLogGroup);
  });
});

describe("CFT Export — Linter & Structural Validator", () => {
  it("rejects invalid YAML syntax", () => {
    const invalidYaml = "AWSTemplateFormatVersion: 2010-09-09\nResources:\n  BadIndent: \n Type: AWS::S3::Bucket";
    const res = validateCloudFormationTemplate(invalidYaml);
    assert.equal(res.valid, false);
    assert.ok(res.errors[0].includes("YAML parse error"));
  });

  it("rejects missing AWSTemplateFormatVersion or Resources", () => {
    const missingRes = "Description: test";
    const res = validateCloudFormationTemplate(missingRes);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes("AWSTemplateFormatVersion")));
    assert.ok(res.errors.some((e) => e.includes("Resources")));
  });

  it("flags dangling Ref references", () => {
    const danglingYaml = `
AWSTemplateFormatVersion: "2010-09-09"
Description: test
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName:
        Ref: NonExistentParamOrResource
`;
    const res = validateCloudFormationTemplate(danglingYaml);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes("Dangling Ref")));
  });
});
