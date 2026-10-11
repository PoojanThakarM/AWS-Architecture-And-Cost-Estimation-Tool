/**
 * stage1Generalization.test.ts
 *
 * Stage 1 Generalization Evaluation Suite on 12 Unseen Repositories.
 * None of these repositories were used to implement the fixes or regression tests.
 *
 * Covers:
 *  - Diverse languages: Rust, Python, Go, C#/.NET, Ruby, PHP, TypeScript, Java
 *  - Diverse workloads: api, ml-inference, ml-training, microservices, web-application, static-frontend, admin-monitoring-tool
 *  - Specific checks:
 *      * Kafka → MSK (never SQS/Kinesis)
 *      * OpenSearch → OpenSearch Service (never SageMaker)
 *      * Kubernetes → EKS
 *      * Keycloak → Cognito (never Secrets Manager, managed substitution explicit)
 *      * ECR not inferred from Docker unless AWS container deployment justifies it
 *      * ML training vs ML inference distinguished (ALB presence/suppression)
 *      * Admin/monitoring tools not treated as frontends
 *      * LLM cannot invent evidence (ungrounded citations rejected)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProject,
  classifyWorkload,
  type RepoSignals,
  type DiscoveredComponent,
  type ProjectProfile,
} from "../repoAnalyzer.ts";
import {
  runRuleEngine,
  type RuleInput,
} from "../ruleEngine.ts";
import {
  mapArchitectureModelToServicePlan,
  validateArchitectureModel,
  isMappingCompatible,
} from "../architecture.ts";
import type { ArchitectureModel, ServiceId } from "../schema.ts";

// Helper to construct RepoSignals
function makeSignals(repoName: string, files: Array<{ path: string; kind: "manifest" | "container_ci" | "source" | "readme"; content: string }>): RepoSignals {
  const keyFiles = files.map((f) => ({
    path: f.path,
    kind: f.kind,
    content: f.content,
    sizeBytes: Buffer.byteLength(f.content, "utf8"),
    truncated: false,
  }));
  const readme = files.find((f) => f.kind === "readme")?.content ?? "";
  return {
    repoName,
    defaultBranch: "main",
    keyFiles,
    truncated: false,
    parseErrors: [],
    readmeLength: readme.length,
    sdkEvidence: [],
  };
}

function signalsToInput(signals: RepoSignals, profile?: ProjectProfile): RuleInput {
  const fileContent = signals.keyFiles.map((f) => `=== ${f.path} ===\n${f.content ?? ""}`).join("\n\n");
  const fileNames = signals.keyFiles.map((f) => f.path.split("/").pop() ?? f.path);
  return {
    fileContent,
    fileNames,
    inputKind: "github_url",
    grounding: "repo",
    truncated: false,
    parseErrors: [],
    profile,
  };
}

// ---------------------------------------------------------------------------
// 12 UNSEEN REPOSITORIES DEFINITION
// ---------------------------------------------------------------------------

interface UnseenRepoSpec {
  id: string;
  name: string;
  language: string;
  expectedWorkload: string;
  expectedServices: ServiceId[];
  forbiddenServices: ServiceId[];
  signals: RepoSignals;
}

const UNSEEN_EVALUATION_SET: UnseenRepoSpec[] = [
  // 1. Rust Axum REST API
  {
    id: "repo-1-rust-axum",
    name: "axum-sqlx-rest-api",
    language: "Rust",
    expectedWorkload: "api",
    expectedServices: ["ECS", "ECR", "RDS", "ElastiCache", "ALB"],
    forbiddenServices: ["DynamoDB", "DocumentDB", "SQS", "MSK"],
    signals: makeSignals("acme/rust-microservice", [
      {
        path: "Cargo.toml",
        kind: "manifest",
        content: `
[package]
name = "rust-service"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1.0", features = ["full"] }
sqlx = { version = "0.7", features = ["postgres"] }
redis = "0.24"
`,
      },
      {
        path: "Dockerfile",
        kind: "container_ci",
        content: "FROM rust:1.75 as builder\nRUN cargo build --release\nFROM debian:bookworm-slim\nCMD [\"./rust-service\"]",
      },
      {
        path: "README.md",
        kind: "readme",
        content: "High performance backend REST API written in Rust using Axum, SQLx with PostgreSQL database, and Redis cache.",
      },
    ]),
  },

  // 2. Python FastAPI ML Inference API
  {
    id: "repo-2-ml-inference",
    name: "fastapi-pytorch-inference",
    language: "Python",
    expectedWorkload: "ml-inference",
    expectedServices: ["SageMaker", "ALB", "S3", "CloudWatch"],
    forbiddenServices: ["RDS", "DynamoDB"],
    signals: makeSignals("acme/vision-model-serving", [
      {
        path: "requirements.txt",
        kind: "manifest",
        content: "fastapi==0.110.0\nuvicorn==0.29.0\ntorch==2.2.1\ntransformers==4.38.0\npydantic==2.6.4\n",
      },
      {
        path: "app/main.py",
        kind: "source",
        content: `
from fastapi import FastAPI
import torch

app = FastAPI()
model = torch.load("model.pt")

@app.post("/predict")
def predict_endpoint(payload: dict):
    tensor = torch.tensor(payload["data"])
    return {"prediction": model(tensor).tolist()}
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Real-time deep learning inference service serving a Transformer model via FastAPI REST endpoints. Accepts JSON predict requests and returns model inferences.",
      },
    ]),
  },

  // 3. Python PyTorch ML Training Pipeline
  {
    id: "repo-3-ml-training",
    name: "cifar10-pytorch-training",
    language: "Python",
    expectedWorkload: "ml-training",
    expectedServices: ["SageMaker", "S3", "CloudWatch"],
    forbiddenServices: ["ALB", "Route53", "RDS", "DynamoDB", "CloudFront"],
    signals: makeSignals("acme/cifar-training", [
      {
        path: "requirements.txt",
        kind: "manifest",
        content: "torch==2.2.0\ntorchvision==0.17.0\ntqdm==4.66.1\nnumpy==1.26.4\n",
      },
      {
        path: "train.py",
        kind: "source",
        content: `
import torch
import torch.nn as nn

for epoch in range(100):
    loss = model(inputs)
    loss.backward()
    optimizer.step()
    print(f"Epoch {epoch} complete")
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "PyTorch CNN training script for CIFAR-10 image classification. Runs multi-epoch model training loops, computes loss, and writes model checkpoints. No web API or user frontend.",
      },
    ]),
  },

  // 4. Go Event-Driven Microservices with Kafka
  {
    id: "repo-4-go-kafka",
    name: "go-event-driven-kafka",
    language: "Go",
    expectedWorkload: "microservices",
    expectedServices: ["MSK", "ECS", "RDS"],
    forbiddenServices: ["SQS", "Kinesis"],
    signals: makeSignals("acme/order-processing-system", [
      {
        path: "go.mod",
        kind: "manifest",
        content: `
module order-processing

go 1.22

require (
    github.com/Shopify/sarama v1.38.1
    github.com/gin-gonic/gin v1.9.1
    github.com/lib/pq v1.10.9
)
`,
      },
      {
        path: "docker-compose.yml",
        kind: "container_ci",
        content: `
version: '3.8'
services:
  order-service:
    build: .
    environment:
      KAFKA_BROKERS: kafka:9092
  kafka:
    image: confluentinc/cp-kafka:7.4.0
  zookeeper:
    image: confluentinc/cp-zookeeper:7.4.0
  postgres:
    image: postgres:15
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Event-driven Go microservices using Apache Kafka for pub/sub message streaming and PostgreSQL for persistence.",
      },
    ]),
  },

  // 5. Kubernetes Helm Microservices Deployment
  {
    id: "repo-5-k8s-helm",
    name: "helm-kubernetes-deployment",
    language: "Polyglot",
    expectedWorkload: "microservices",
    expectedServices: ["EKS", "ECR", "ALB"],
    forbiddenServices: ["ElasticBeanstalk"],
    signals: makeSignals("acme/k8s-platform", [
      {
        path: "Chart.yaml",
        kind: "container_ci",
        content: "apiVersion: v2\nname: payments-service\nversion: 1.0.0\n",
      },
      {
        path: "k8s/deployment.yaml",
        kind: "container_ci",
        content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: payments\nspec:\n  replicas: 3\n",
      },
      {
        path: "k8s/ingress.yaml",
        kind: "container_ci",
        content: "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: payments-ingress\n",
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Payment processing microservice deployed to Kubernetes via Helm charts with Ingress load balancing.",
      },
    ]),
  },

  // 6. C#/.NET Core 8 Web API with Microsoft SQL Server
  {
    id: "repo-6-dotnet-sqlserver",
    name: "dotnet-webapi-sqlserver",
    language: "C#",
    expectedWorkload: "api",
    expectedServices: ["ECS", "ECR", "RDS", "ALB"],
    forbiddenServices: ["DynamoDB", "DocumentDB"],
    signals: makeSignals("acme/dotnet-backend", [
      {
        path: "Enterprise.Api.csproj",
        kind: "manifest",
        content: `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />
  </ItemGroup>
</Project>
`,
      },
      {
        path: "Dockerfile",
        kind: "container_ci",
        content: "FROM mcr.microsoft.com/dotnet/aspnet:8.0\nWORKDIR /app\nENTRYPOINT [\"dotnet\", \"Enterprise.Api.dll\"]",
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Enterprise ASP.NET Core 8 Web API with Entity Framework Core and Microsoft SQL Server database.",
      },
    ]),
  },

  // 7. Ruby on Rails + Sidekiq + Redis + AWS S3
  {
    id: "repo-7-rails-sidekiq",
    name: "rails-sidekiq-redis",
    language: "Ruby",
    expectedWorkload: "web-application",
    expectedServices: ["ECS", "RDS", "ElastiCache", "S3", "ALB"],
    forbiddenServices: ["DynamoDB", "MSK"],
    signals: makeSignals("acme/rails-portal", [
      {
        path: "Gemfile",
        kind: "manifest",
        content: `
source 'https://rubygems.org'
gem 'rails', '~> 7.1'
gem 'pg', '~> 1.5'
gem 'sidekiq', '~> 7.2'
gem 'redis', '~> 5.0'
gem 'aws-sdk-s3', '~> 1.140'
`,
      },
      {
        path: "Dockerfile",
        kind: "container_ci",
        content: "FROM ruby:3.2-alpine\nRUN bundle install\nCMD [\"bundle\", \"exec\", \"rails\", \"server\"]",
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Ruby on Rails web portal with Sidekiq background jobs, Redis queue, PostgreSQL database, and S3 file attachments.",
      },
    ]),
  },

  // 8. PHP Laravel + MySQL + Redis + Adminer (auxiliary tool)
  {
    id: "repo-8-laravel-mysql",
    name: "laravel-mysql-adminer",
    language: "PHP",
    expectedWorkload: "web-application",
    expectedServices: ["RDS", "ElastiCache", "ALB"],
    forbiddenServices: ["DynamoDB", "DocumentDB"],
    signals: makeSignals("acme/laravel-app", [
      {
        path: "composer.json",
        kind: "manifest",
        content: JSON.stringify({
          require: {
            "php": "^8.2",
            "laravel/framework": "^10.0",
            "predis/predis": "^2.2",
          },
        }),
      },
      {
        path: "docker-compose.yml",
        kind: "container_ci",
        content: `
version: '3'
services:
  app:
    build: .
  mysql:
    image: mysql:8.0
  redis:
    image: redis:alpine
  adminer:
    image: adminer:latest
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Laravel 10 web application with MySQL database, Redis session cache, and local Adminer database management tool.",
      },
    ]),
  },

  // 9. Serverless SAM Event-Driven API
  {
    id: "repo-9-serverless-sam",
    name: "sam-lambda-dynamodb",
    language: "TypeScript",
    expectedWorkload: "api",
    expectedServices: ["Lambda", "APIGateway", "DynamoDB", "SQS"],
    forbiddenServices: ["ECS", "EKS", "ECR"],
    signals: makeSignals("acme/serverless-orders", [
      {
        path: "package.json",
        kind: "manifest",
        content: JSON.stringify({
          name: "serverless-order-api",
          dependencies: {
            "@aws-sdk/client-dynamodb": "^3.500.0",
            "@aws-sdk/client-sqs": "^3.500.0",
          },
        }),
      },
      {
        path: "serverless.yml",
        kind: "container_ci",
        content: `
service: serverless-orders
provider:
  name: aws
  runtime: nodejs20.x
functions:
  createOrder:
    handler: src/handler.createOrder
    events:
      - http:
          path: /orders
          method: post
  processQueue:
    handler: src/handler.processQueue
    events:
      - sqs:
          arn: arn:aws:sqs:us-east-1:123456789012:orders-queue
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Serverless event-driven architecture using AWS Lambda, API Gateway, SQS queues, and Amazon DynamoDB.",
      },
    ]),
  },

  // 10. Astro Static Documentation Site
  {
    id: "repo-10-astro-static",
    name: "astro-docs-static",
    language: "Astro",
    expectedWorkload: "static-frontend",
    expectedServices: ["S3", "CloudFront", "Route53"],
    forbiddenServices: ["ECS", "EKS", "ECR", "RDS", "DynamoDB", "ALB"],
    signals: makeSignals("acme/developer-docs", [
      {
        path: "package.json",
        kind: "manifest",
        content: JSON.stringify({
          name: "docs-portal",
          dependencies: {
            "astro": "^4.0.0",
            "@astrojs/tailwind": "^5.0.0",
          },
        }),
      },
      {
        path: "astro.config.mjs",
        kind: "source",
        content: "import { defineConfig } from 'astro/config';\nexport default defineConfig({});",
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Static documentation website built with Astro and Markdown. Deployed to edge CDN with no server compute or database.",
      },
    ]),
  },

  // 11. Standalone Prometheus & Grafana Monitoring Tool
  {
    id: "repo-11-monitoring-stack",
    name: "prometheus-grafana-monitoring",
    language: "Docker/YAML",
    expectedWorkload: "admin-monitoring-tool",
    expectedServices: [],
    forbiddenServices: ["RDS", "DynamoDB", "OpenSearch"],
    signals: makeSignals("acme/infra-monitoring", [
      {
        path: "docker-compose.yml",
        kind: "container_ci",
        content: `
version: '3.7'
services:
  prometheus:
    image: prom/prometheus:v2.45.0
  grafana:
    image: grafana/grafana:10.0.0
  alertmanager:
    image: prom/alertmanager:v0.25.0
  node-exporter:
    image: prom/node-exporter:v1.6.0
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Self-contained infrastructure monitoring stack running Prometheus, Grafana, Alertmanager, and Node Exporter.",
      },
    ]),
  },

  // 12. Enterprise Keycloak + OpenSearch + PostgreSQL
  {
    id: "repo-12-keycloak-opensearch",
    name: "enterprise-auth-search-system",
    language: "Java",
    expectedWorkload: "microservices",
    expectedServices: ["OpenSearch", "RDS"],
    forbiddenServices: ["SecretsManager"],
    signals: makeSignals("acme/enterprise-core", [
      {
        path: "docker-compose.yml",
        kind: "container_ci",
        content: `
version: '3.8'
services:
  gateway:
    build: ./gateway
  auth-server:
    image: quay.io/keycloak/keycloak:23.0
  search-engine:
    image: opensearchproject/opensearch:2.11.0
  search-dashboards:
    image: opensearchproject/opensearch-dashboards:2.11.0
  postgres:
    image: postgres:15
`,
      },
      {
        path: "pom.xml",
        kind: "manifest",
        content: `
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>enterprise-core</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
    </dependency>
  </dependencies>
</project>
`,
      },
      {
        path: "README.md",
        kind: "readme",
        content: "Enterprise microservice system using Keycloak for SSO authentication, OpenSearch for search indexing, and PostgreSQL for relational data storage.",
      },
    ]),
  },
];

// ---------------------------------------------------------------------------
// TEST SUITE: STAGE 1 GENERALIZATION EVALUATION
// ---------------------------------------------------------------------------

describe("Stage 1 Generalization Evaluation on 12 Unseen Repositories", () => {
  for (const repo of UNSEEN_EVALUATION_SET) {
    it(`evaluates unseen repo: ${repo.name} (${repo.language} / ${repo.expectedWorkload})`, () => {
      // 1. Extraction phase
      const profile = analyzeProject(repo.signals);
      assert.ok(profile, `Profile extraction failed for ${repo.name}`);

      // Verify evidence register exists and has entries
      assert.ok(profile.evidenceRegister && profile.evidenceRegister.length > 0, `Evidence register missing for ${repo.name}`);
      for (const ev of profile.evidenceRegister) {
        assert.ok(ev.id.startsWith("ev-") && ev.sourcePath, `Invalid evidence record: ${JSON.stringify(ev)}`);
      }

      // 2. Workload classification phase
      const detectedWorkload = profile.workloadClassification?.type ?? profile.workloadClassification?.primaryWorkload;
      assert.strictEqual(detectedWorkload, repo.expectedWorkload, `Workload classification mismatch for ${repo.name}`);

      // 3. AWS mapping via Rule Engine
      const ruleInput = signalsToInput(repo.signals, profile);
      const plan = runRuleEngine(ruleInput, profile);
      const plannedServices = new Set(plan.awsMappings.map((s) => s.serviceId));

      // Check expected services (must not have false negatives)
      for (const expSvc of repo.expectedServices) {
        assert.ok(plannedServices.has(expSvc), `False Negative in ${repo.name}: expected service ${expSvc} was not mapped! Planned: ${Array.from(plannedServices).join(", ")}`);
      }

      // Check forbidden services (must not have false positives)
      for (const forbSvc of repo.forbiddenServices) {
        assert.ok(!plannedServices.has(forbSvc), `False Positive in ${repo.name}: forbidden service ${forbSvc} was mapped! Planned: ${Array.from(plannedServices).join(", ")}`);
      }

      // Check: unsupported services must not have HIGH confidence
      for (const mapping of plan.awsMappings) {
        if (mapping.confidence === "high") {
          const hasEvidence = mapping.evidence && mapping.evidence.trim().length > 0;
          assert.ok(hasEvidence, `Unsupported HIGH confidence service ${mapping.serviceId} in ${repo.name}`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // SPECIFIC ARCHITECTURAL RULES
  // -------------------------------------------------------------------------

  it("Rule 1: Kafka → MSK, never accidental SQS/Kinesis", () => {
    const kafkaRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-4-go-kafka")!;
    const profile = analyzeProject(kafkaRepo.signals);
    const plan = runRuleEngine(signalsToInput(kafkaRepo.signals, profile), profile);
    const services = plan.awsMappings.map((s) => s.serviceId);

    assert.ok(services.includes("MSK"), "Kafka repo must include MSK");
    assert.ok(!services.includes("SQS"), "Kafka repo must NOT include SQS");
    assert.ok(!services.includes("Kinesis"), "Kafka repo must NOT include Kinesis");

    // Also verify semantic capability validator
    assert.ok(isMappingCompatible("Apache Kafka", "MSK"));
    assert.ok(!isMappingCompatible("Apache Kafka", "SQS"));
    assert.ok(!isMappingCompatible("Apache Kafka", "Kinesis"));
  });

  it("Rule 2: OpenSearch → OpenSearch Service, never SageMaker", () => {
    const searchRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-12-keycloak-opensearch")!;
    const profile = analyzeProject(searchRepo.signals);
    const plan = runRuleEngine(signalsToInput(searchRepo.signals, profile), profile);
    const services = plan.awsMappings.map((s) => s.serviceId);

    assert.ok(services.includes("OpenSearch"), "OpenSearch repo must include OpenSearch");
    assert.ok(!services.includes("SageMaker"), "OpenSearch must NOT map to SageMaker");

    assert.ok(isMappingCompatible("OpenSearch", "OpenSearch"));
    assert.ok(!isMappingCompatible("OpenSearch", "SageMaker"));
  });

  it("Rule 3: Kubernetes → EKS + ECR", () => {
    const k8sRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-5-k8s-helm")!;
    const profile = analyzeProject(k8sRepo.signals);
    const plan = runRuleEngine(signalsToInput(k8sRepo.signals, profile), profile);
    const services = plan.awsMappings.map((s) => s.serviceId);

    assert.ok(services.includes("EKS"), "Kubernetes manifests must map to EKS");
    assert.ok(services.includes("ECR"), "Kubernetes deployment requires ECR");
  });

  it("Rule 4: Keycloak is not Secrets Manager and managed substitution is explicit", () => {
    const keycloakRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-12-keycloak-opensearch")!;
    const profile = analyzeProject(keycloakRepo.signals);
    const plan = runRuleEngine(signalsToInput(keycloakRepo.signals, profile), profile);
    const services = plan.awsMappings.map((s) => s.serviceId);

    assert.ok(!services.includes("SecretsManager"), "Keycloak must NOT map to Secrets Manager");

    const cognitoEntry = plan.awsMappings.find((s) => s.serviceId === "Cognito");
    if (cognitoEntry) {
      assert.ok(
        cognitoEntry.evidence.includes("substitution") || cognitoEntry.evidence.includes("Keycloak"),
        "Cognito entry must explicitly document Keycloak managed substitution"
      );
      assert.notStrictEqual(cognitoEntry.confidence, "high", "Substituted service must not receive HIGH confidence");
    }

    assert.ok(!isMappingCompatible("Keycloak", "SecretsManager"));
    assert.ok(!isMappingCompatible("Keycloak", "KMS"));
  });

  it("Rule 5: ECR is not inferred unless AWS container deployment justifies it", () => {
    // Static site has no container deployment
    const staticRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-10-astro-static")!;
    const staticPlan = runRuleEngine(signalsToInput(staticRepo.signals), analyzeProject(staticRepo.signals));
    assert.ok(!staticPlan.awsMappings.some((s) => s.serviceId === "ECR"), "Static site must not infer ECR");

    // Serverless SAM repo has no container deployment
    const samRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-9-serverless-sam")!;
    const samPlan = runRuleEngine(signalsToInput(samRepo.signals), analyzeProject(samRepo.signals));
    assert.ok(!samPlan.awsMappings.some((s) => s.serviceId === "ECR"), "Serverless app without container must not infer ECR");
  });

  it("Rule 6: ML training vs ML inference distinguished (ALB presence/suppression)", () => {
    const trainingRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-3-ml-training")!;
    const trainingProfile = analyzeProject(trainingRepo.signals);
    const trainingPlan = runRuleEngine(signalsToInput(trainingRepo.signals, trainingProfile), trainingProfile);

    assert.strictEqual(trainingProfile.workloadClassification?.type, "ml-training");
    assert.ok(!trainingPlan.awsMappings.some((s) => s.serviceId === "ALB"), "ML training must NOT include ALB");
    assert.ok(trainingPlan.awsMappings.some((s) => s.serviceId === "SageMaker"), "ML training must include SageMaker");

    const inferenceRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-2-ml-inference")!;
    const inferenceProfile = analyzeProject(inferenceRepo.signals);
    const inferencePlan = runRuleEngine(signalsToInput(inferenceRepo.signals, inferenceProfile), inferenceProfile);

    assert.strictEqual(inferenceProfile.workloadClassification?.type, "ml-inference");
    assert.ok(inferencePlan.awsMappings.some((s) => s.serviceId === "ALB"), "ML inference HTTP API must include ALB");
    assert.ok(inferencePlan.awsMappings.some((s) => s.serviceId === "SageMaker"), "ML inference must include SageMaker");
  });

  it("Rule 7: Admin/monitoring tools not treated as frontends", () => {
    const monitoringRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-11-monitoring-stack")!;
    const profile = analyzeProject(monitoringRepo.signals);
    const plan = runRuleEngine(signalsToInput(monitoringRepo.signals, profile), profile);

    // Should not infer CloudFront or user frontend
    assert.ok(!plan.awsMappings.some((s) => s.serviceId === "CloudFront"), "Monitoring stack must not infer CloudFront");
    for (const comp of profile.discoveredComponents) {
      assert.strictEqual(comp.type, "other", `Monitoring component ${comp.name} must be classified as 'other'`);
    }

    // Also check Adminer in Laravel repo
    const laravelRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-8-laravel-mysql")!;
    const laravelProfile = analyzeProject(laravelRepo.signals);
    const adminerComp = laravelProfile.discoveredComponents.find((c) => c.name === "adminer");
    assert.ok(adminerComp, "Adminer component must be discovered");
    assert.strictEqual(adminerComp.type, "other", "Adminer must be classified as 'other', not frontend");
  });

  it("Rule 8: LLM cannot invent evidence (ungrounded citations rejected)", () => {
    const rustRepo = UNSEEN_EVALUATION_SET.find((r) => r.id === "repo-1-rust-axum")!;
    const profile = analyzeProject(rustRepo.signals);
    const validEvidenceIds = (profile.evidenceRegister || []).map((e) => e.id);

    // 1. Model citing a non-existent evidence ID
    const hallucinatedModel: ArchitectureModel = {
      summary: "Hallucinated Architecture",
      components: [
        {
          id: "comp-hallucinated",
          name: "PaymentProcessor",
          type: "backend",
          technology: "Stripe SDK",
          evidence: ["ev-99999"], // Does not exist in register!
        },
      ],
      databases: [],
      frameworks: [],
      buildConfig: [],
      languages: [],
      dependencies: [],
    };

    const validation = validateArchitectureModel(hallucinatedModel, profile.evidenceRegister);
    assert.strictEqual(validation.model, null, "Model with fabricated evidence ID must be rejected");
    assert.strictEqual(validation.reason, "no-evidence");

    // 2. Model claiming technology not present in cited evidence
    const validEv = validEvidenceIds[0];
    const mismatchedModel: ArchitectureModel = {
      summary: "Mismatched Architecture",
      components: [
        {
          id: "comp-mismatch",
          name: "UserDB",
          type: "database",
          technology: "DynamoDB",
          evidence: [validEv], // Valid file (Cargo.toml), but does NOT contain DynamoDB!
        },
      ],
      databases: [],
      frameworks: [],
      buildConfig: [],
      languages: [],
      dependencies: [],
    };

    const mismatchValidation = validateArchitectureModel(mismatchedModel, profile.evidenceRegister);
    assert.strictEqual(
      mismatchValidation.model,
      null,
      "Model claiming unsupported technology must be rejected"
    );
    assert.strictEqual(mismatchValidation.reason, "no-evidence");
  });
});
