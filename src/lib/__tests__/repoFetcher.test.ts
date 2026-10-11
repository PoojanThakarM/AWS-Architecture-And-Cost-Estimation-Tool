/**
 * repoFetcher.test.ts
 *
 * Tests for the pure-logic functions in repoFetcher.ts:
 * file classification, content compaction, signal-gate check.
 * No network calls made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInsufficientSignal, signalsToRuleInput, selectWorkspaceAware } from "../repoFetcher.ts";
import type { RepoSignals, FileCandidate } from "../repoFetcher.ts";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    repoName: "owner/repo",
    defaultBranch: "main",
    keyFiles: [],
    truncated: false,
    parseErrors: [],
    readmeLength: 0,
    sdkEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isInsufficientSignal gate (Decision 20 / flaw 8)
// ---------------------------------------------------------------------------

describe("isInsufficientSignal", () => {
  it("returns true when no manifest/CI and readme < 100 chars", () => {
    const signals = makeSignals({ readmeLength: 50 });
    assert.ok(isInsufficientSignal(signals));
  });

  it("returns false when readme >= 100 chars even with no manifests", () => {
    const signals = makeSignals({ readmeLength: 100 });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when a manifest file is present (even empty readme)", () => {
    const signals = makeSignals({
      readmeLength: 0,
      keyFiles: [
        { path: "package.json", kind: "manifest", content: "{}", sizeBytes: 2, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when a container/CI file is present", () => {
    const signals = makeSignals({
      readmeLength: 0,
      keyFiles: [
        { path: "Dockerfile", kind: "container_ci", content: "FROM node:22", sizeBytes: 12, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when both manifest and readme present", () => {
    const signals = makeSignals({
      readmeLength: 200,
      keyFiles: [
        { path: "package.json", kind: "manifest", content: "{}", sizeBytes: 2, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });
});

// ---------------------------------------------------------------------------
// signalsToRuleInput
// ---------------------------------------------------------------------------

describe("signalsToRuleInput", () => {
  it("concatenates file contents into fileContent", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: "package.json", kind: "manifest", content: '{"name":"test"}', sizeBytes: 15, truncated: false },
        { path: "Dockerfile", kind: "container_ci", content: "FROM node:22", sizeBytes: 12, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileContent.includes("package.json"));
    assert.ok(input.fileContent.includes("Dockerfile"));
    assert.ok(input.fileContent.includes("FROM node:22"));
  });

  it("passes full file paths into fileNames", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: ".github/workflows/ci.yml", kind: "container_ci", content: "name: CI", sizeBytes: 8, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileNames.includes(".github/workflows/ci.yml"));
  });

  it("handles null content files as filename-only signal placeholder", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: "serverless.yml", kind: "container_ci", content: null, sizeBytes: 100, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileContent.includes("serverless.yml"));
    assert.ok(input.fileContent.includes("parse error"));
  });

  it("passes through inputKind, grounding, truncated, parseErrors", () => {
    const signals = makeSignals({ truncated: true, parseErrors: ["bad.yaml"] });
    const input = signalsToRuleInput(signals, "github_url", "description");
    assert.strictEqual(input.inputKind, "github_url");
    assert.strictEqual(input.grounding, "description");
    assert.strictEqual(input.truncated, true);
    assert.deepStrictEqual(input.parseErrors, ["bad.yaml"]);
  });
});

describe("Fix 3 — classifyFile & relevance scoring", () => {
  it("classifies and scores source entrypoints and glob files correctly", async () => {
    const { classifyFile } = await import("../repoFetcher.ts");

    const readme = classifyFile("README.md");
    assert.ok(readme && readme.kind === "readme" && readme.score === 100);

    const handler = classifyFile("src/handler.py");
    assert.ok(handler && handler.kind === "source" && handler.score >= 75);

    const controller = classifyFile("src/users.controller.ts");
    assert.ok(controller && controller.kind === "source" && controller.score >= 70);

    const nestedManifest = classifyFile("packages/auth/package.json");
    assert.ok(nestedManifest && nestedManifest.kind === "manifest");

    const k8s = classifyFile("k8s/deployment.yaml");
    assert.ok(k8s && k8s.kind === "container_ci");

    // Shallow handler ranks higher than deep general source file
    const deepSrc = classifyFile("src/utils/deep.ts");
    assert.ok(deepSrc && handler!.score > deepSrc.score);
  });
});

describe("Fix 3 — extractSdkEvidence", () => {
  it("extracts boto3 S3 call from Lambda handler file", async () => {
    const { extractSdkEvidence } = await import("../repoFetcher.ts");

    const keyFiles = [
      {
        path: "src/handler.py",
        kind: "source" as const,
        content: `
import boto3
import json

s3 = boto3.client('s3')

def lambda_handler(event, context):
    s3.put_object(Bucket='my-bucket', Key='data.json', Body=json.dumps(event))
    return {'status': 200}
`,
        sizeBytes: 150,
        truncated: false,
      },
    ];

    const evidence = extractSdkEvidence(keyFiles);
    assert.ok(evidence.length > 0, "Should detect SDK evidence");
    const s3Evidence = evidence.find((e) => e.service === "S3");
    assert.ok(s3Evidence, "Should contain an S3 entry");
    assert.strictEqual(s3Evidence!.file, "src/handler.py");
  });

  it("extracts AWS SDK v3, SQS, DynamoDB, WebSocket and cron patterns", async () => {
    const { extractSdkEvidence } = await import("../repoFetcher.ts");

    const keyFiles = [
      {
        path: "src/worker.ts",
        kind: "source" as const,
        content: `
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import cron from "node-cron";
import { WebSocketServer } from "ws";

const sqs = new SQSClient({});
await sqs.send(new SendMessageCommand({ QueueUrl: "...", MessageBody: "test" }));

cron.schedule("0 0 * * *", () => {
  console.log("daily job");
});
`,
        sizeBytes: 300,
        truncated: false,
      },
    ];

    const evidence = extractSdkEvidence(keyFiles);
    const services = new Set(evidence.map((e) => e.service));

    assert.ok(services.has("SQS"), "Should detect SQS");
    assert.ok(services.has("DynamoDB"), "Should detect DynamoDB");
    assert.ok(services.has("EventBridge"), "Should detect EventBridge from cron");
    assert.ok(services.has("APIGateway"), "Should detect APIGateway from WebSocket");
  });
});

// ---------------------------------------------------------------------------
// Monorepo service-blindness (microservices-demo shape: src/<service>/)
// ---------------------------------------------------------------------------

describe("selectWorkspaceAware monorepo buckets", () => {
  it("selects at least one manifest per src/<service> within a small cap", () => {
    const services = [
      "cartservice", "frontend", "productcatalogservice", "paymentservice",
      "shippingservice", "checkoutservice", "currencyservice", "adservice",
      "emailservice", "recommendationservice",
    ];
    const cand = (path: string, score: number): FileCandidate => ({
      path, kind: "manifest", priority: 1, score,
    });
    const input: FileCandidate[] = [];
    // 2 manifests per service, middling scores — top-level dirs outscore them.
    for (const svc of services) {
      input.push(cand(`src/${svc}/src/${svc}.csproj`, 55));
      input.push(cand(`src/${svc}/go.mod`, 50));
    }
    input.push(cand("terraform/main.tf", 90));
    input.push(cand("helm-chart/Chart.yaml", 90));
    input.push(cand("docs/guide.md", 90));
    input.push(cand(".github/workflows/ci.yml", 90));

    const selected = selectWorkspaceAware(input, 15);
    const paths = new Set(selected.map((c) => c.path));
    for (const svc of services) {
      assert.ok(
        paths.has(`src/${svc}/src/${svc}.csproj`) || paths.has(`src/${svc}/go.mod`),
        `service ${svc} must have at least one manifest selected`
      );
    }
  });

  it("keeps single-segment buckets for flat top-level dirs", () => {
    const cand = (path: string, score: number): FileCandidate => ({
      path, kind: "manifest", priority: 1, score,
    });
    const input = [
      cand("terraform/a.tf", 80),
      cand("terraform/b.tf", 79),
      cand("src/svc-a/go.mod", 70),
      cand("src/svc-b/go.mod", 70),
    ];
    // cap=4 → manifest reserve 2: round-robin takes one per bucket
    // (terraform, then svc-a); the remainder flows through pass 3 by score.
    const selected = selectWorkspaceAware(input, 4);
    const paths = selected.map((c) => c.path);
    assert.ok(paths.includes("terraform/a.tf"));
    assert.ok(paths.includes("src/svc-a/go.mod"));
    assert.ok(paths.includes("src/svc-b/go.mod"));
  });

  it("reserves manifest budget against a container_ci flood (microservices-demo shape)", () => {
    const cand = (path: string, kind: FileCandidate["kind"], score: number): FileCandidate => ({
      path, kind, priority: 1, score,
    });
    const services = [
      "cartservice", "frontend", "productcatalogservice", "paymentservice",
      "shippingservice", "checkoutservice", "currencyservice", "adservice",
      "emailservice", "recommendationservice",
    ];
    const input: FileCandidate[] = [cand("README.md", "readme", 100)];
    for (const svc of services) {
      input.push(cand(`src/${svc}/go.mod`, "manifest", 50));
    }
    // 55 high-scoring IaC/CI files that used to eat the whole budget in pass 1.
    for (let i = 0; i < 20; i++) input.push(cand(`kubernetes-manifests/svc-${i}.yaml`, "container_ci", 90));
    for (let i = 0; i < 15; i++) input.push(cand(`helm-chart/templates/svc-${i}.yaml`, "container_ci", 90));
    for (let i = 0; i < 10; i++) input.push(cand(`terraform/f${i}.tf`, "container_ci", 90));
    for (let i = 0; i < 10; i++) input.push(cand(`.github/workflows/ci-${i}.yml`, "container_ci", 90));

    const selected = selectWorkspaceAware(input, 60);
    assert.strictEqual(selected.length, 60);
    const paths = new Set(selected.map((c) => c.path));
    let covered = 0;
    for (const svc of services) {
      if (paths.has(`src/${svc}/go.mod`)) covered++;
    }
    assert.ok(covered >= 8, `at least 8 of 10 services must survive, got ${covered}`);
    assert.ok(paths.has("README.md"), "README stays unconditional");
  });
});
