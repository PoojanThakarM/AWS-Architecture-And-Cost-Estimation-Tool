/**
 * stage1Regression.test.ts
 *
 * Comprehensive tests for Stage 1 (Repo → Tech Stack → AWS Services):
 *   1. Priority 1 — Evidence Trustworthiness: Reject fabricated evidence & unsupported claims.
 *   2. Priority 2 — Generic Capability Mapping: Semantic roles (Kafka→MSK, OpenSearch→OpenSearch,
 *                   Keycloak→Cognito, Postgres→RDS, Kubernetes→EKS) and rejection of incompatible mappings.
 *   3. Priority 3 — Global Repository Extraction: Multi-module Maven pom.xml, Docker Compose, k8s manifests.
 *   4. Priority 4 — Workload Classification: Classify before selecting compute (e.g. CNN→SageMaker, not ECS; no ALB).
 *   5. Priority 5 — Fact vs Recommendation Separation: Baseline services have category "recommendation" and never "high" confidence.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/stage1Regression.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateArchitectureModel,
  mapArchitectureModelToServicePlan,
  isMappingCompatible,
  deduplicateAwsMappings,
} from "../architecture.ts";
import type { ArchitectureModel, ArchitectureComponent, ModelContext } from "../architecture.ts";
import {
  analyzeProject,
  classifyWorkload,
} from "../repoAnalyzer.ts";
import type { EvidenceRecord } from "../schema.ts";
import type { RepoSignals } from "../repoFetcher.ts";

const BASE_CTX: ModelContext = {
  inputKind: "github_url",
  grounding: "repoFiles",
  truncated: false,
  parseErrors: [],
};

function comp(
  id: string,
  name: string,
  type: ArchitectureComponent["type"],
  technology: string,
  confidence: "high" | "medium" | "low" = "high",
  evidence: string[] = ["ev-1"]
): ArchitectureComponent {
  return { id, name, type, technology, confidence, evidence };
}

function makeModel(overrides?: Partial<ArchitectureModel>): ArchitectureModel {
  return {
    appType: "full-stack-web",
    appName: "Test System",
    description: "Test description",
    components: [
      comp("order", "Order Service", "backend", "Spring Boot"),
    ],
    languages: ["Java"],
    frameworks: ["Spring Boot"],
    databases: [],
    apis: [],
    externalServices: [],
    dependencies: [],
    buildConfig: [],
    relationships: [],
    ...overrides,
  };
}

// ===========================================================================
// Priority 1 — Evidence must be trustworthy
// ===========================================================================

describe("Priority 1: Evidence Trustworthiness", () => {
  const register: EvidenceRecord[] = [
    {
      id: "ev-1",
      kind: "manifest",
      sourcePath: "pom.xml",
      technology: "spring-boot",
      detail: "dependency: spring-boot-starter-web",
      confidence: "high",
    },
    {
      id: "ev-2",
      kind: "manifest",
      sourcePath: "order-service/pom.xml",
      technology: "kafka",
      detail: "dependency: spring-kafka",
      confidence: "high",
    },
    {
      id: "ev-3",
      kind: "iac",
      sourcePath: "docker-compose.yml",
      technology: "postgres",
      detail: "service: postgres (postgres:15-alpine)",
      confidence: "high",
    },
  ];

  it("accepts components whose cited evidence matches registered evidence", () => {
    const raw = makeModel({
      components: [
        comp("order", "Order Service", "backend", "Spring Boot", "high", ["ev-1"]),
        comp("kafka", "Event Bus", "messaging", "Kafka", "high", ["ev-2"]),
        comp("db", "Database", "database", "PostgreSQL", "high", ["docker-compose.yml"]),
      ],
    });

    const { model } = validateArchitectureModel(raw, register);
    assert.ok(model, "Model should validate successfully");
    assert.strictEqual(model!.components.length, 3);
  });

  it("rejects hallucinated components citing non-existent files/handlers (Kuzma02 scenario)", () => {
    const raw = makeModel({
      components: [
        comp("order", "Order Service", "backend", "Spring Boot", "high", ["ev-1"]),
        // Invented component with hallucinated evidence strings:
        comp("fn", "Order Processor Lambda", "backend", "AWS Lambda", "high", [
          "Lambda handler in order-service/handler.py",
          "serverless.yml",
        ]),
        // Invented Kubernetes cluster with no k8s manifests:
        comp("k8s", "EKS Cluster", "backend", "Kubernetes", "high", [
          "k8s/deployment.yaml",
        ]),
      ],
    });

    const { model } = validateArchitectureModel(raw, register);
    assert.ok(model, "Valid model returned");
    // Only 'order' should survive; 'fn' and 'k8s' must be dropped!
    assert.strictEqual(model!.components.length, 1);
    assert.strictEqual(model!.components[0].id, "order");
  });

  it("rejects components citing real files when the file content does not support the technology", () => {
    const raw = makeModel({
      components: [
        comp("order", "Order Service", "backend", "Spring Boot", "high", ["pom.xml"]),
        // Cites real pom.xml, but claims DynamoDB (pom.xml only has spring-boot-starter-web)
        comp("db", "User Table", "database", "DynamoDB", "high", ["pom.xml"]),
        // Cites real pom.xml, but claims AWS Lambda
        comp("fn", "Serverless Fn", "backend", "AWS Lambda", "high", ["pom.xml"]),
      ],
    });

    const { model } = validateArchitectureModel(raw, register);
    assert.ok(model, "Valid model returned");
    assert.strictEqual(model!.components.length, 1);
    assert.strictEqual(model!.components[0].id, "order");
  });

  it("discards model and falls back to rules if all components lack valid evidence", () => {
    const raw = makeModel({
      components: [
        comp("fn", "Invented Lambda", "backend", "AWS Lambda", "high", ["imaginary.js"]),
      ],
    });

    const result = validateArchitectureModel(raw, register);
    assert.strictEqual(result.model, null, "Should return no model to trigger rule engine fallback");
    assert.strictEqual(result.reason, "no-evidence");
  });
});

// ===========================================================================
// Priority 2 — Fix AWS mapping generically
// ===========================================================================

describe("Priority 2: Semantic Capability & Incompatible Mapping Prevention", () => {
  it("enforces isMappingCompatible rules", () => {
    // 1. Kafka must NOT map to SQS, Kinesis, SNS
    assert.strictEqual(isMappingCompatible("Kafka", "MSK"), true);
    assert.strictEqual(isMappingCompatible("spring-kafka", "MSK"), true);
    assert.strictEqual(isMappingCompatible("Apache Kafka", "SQS"), false);
    assert.strictEqual(isMappingCompatible("Kafka", "Kinesis"), false);
    assert.strictEqual(isMappingCompatible("Kafka", "SNS"), false);

    // 2. OpenSearch must NOT map to SageMaker, RDS, DynamoDB
    assert.strictEqual(isMappingCompatible("OpenSearch", "OpenSearch"), true);
    assert.strictEqual(isMappingCompatible("Elasticsearch", "OpenSearch"), true);
    assert.strictEqual(isMappingCompatible("OpenSearch", "SageMaker"), false);
    assert.strictEqual(isMappingCompatible("Elasticsearch", "RDS"), false);
    assert.strictEqual(isMappingCompatible("OpenSearch", "DynamoDB"), false);

    // 3. Keycloak must NOT map to SecretsManager or KMS
    assert.strictEqual(isMappingCompatible("Keycloak", "Cognito"), true);
    assert.strictEqual(isMappingCompatible("Keycloak Auth", "SecretsManager"), false);
    assert.strictEqual(isMappingCompatible("Keycloak", "KMS"), false);

    // 4. Relational DB must NOT map to DynamoDB or DocumentDB
    assert.strictEqual(isMappingCompatible("PostgreSQL", "RDS"), true);
    assert.strictEqual(isMappingCompatible("MySQL", "RDS"), true);
    assert.strictEqual(isMappingCompatible("Postgres", "DynamoDB"), false);
    assert.strictEqual(isMappingCompatible("MySQL", "DocumentDB"), false);

    // 5. MongoDB must NOT map to RDS
    assert.strictEqual(isMappingCompatible("MongoDB", "DocumentDB"), true);
    assert.strictEqual(isMappingCompatible("MongoDB", "RDS"), false);

    // 6. Redis must NOT map to RDS or DynamoDB
    assert.strictEqual(isMappingCompatible("Redis", "ElastiCache"), true);
    assert.strictEqual(isMappingCompatible("Redis", "RDS"), false);
    assert.strictEqual(isMappingCompatible("Redis", "DynamoDB"), false);

    // 7. Kubernetes must NOT map to Lambda
    assert.strictEqual(isMappingCompatible("Kubernetes", "EKS"), true);
    assert.strictEqual(isMappingCompatible("Kubernetes", "Lambda"), false);
  });

  it("maps Kafka to MSK (never SQS/Kinesis)", () => {
    const model = makeModel({
      components: [
        comp("kafka", "Kafka Cluster", "messaging", "Apache Kafka", "high", ["ev-1"]),
      ],
    });
    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(serviceIds.includes("MSK"), `Expected MSK, got ${serviceIds.join(", ")}`);
    assert.ok(!serviceIds.includes("SQS"), "Must not include SQS for Kafka");
    assert.ok(!serviceIds.includes("Kinesis"), "Must not include Kinesis for Kafka");
  });

  it("maps OpenSearch to Amazon OpenSearch Service (never SageMaker)", () => {
    const model = makeModel({
      components: [
        comp("search", "Search Engine", "search", "OpenSearch 2.11", "high", ["ev-1"]),
      ],
    });
    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(serviceIds.includes("OpenSearch"), `Expected OpenSearch, got ${serviceIds.join(", ")}`);
    assert.ok(!serviceIds.includes("SageMaker"), "Must not map OpenSearch to SageMaker");
  });

  it("maps Keycloak to Cognito (never SecretsManager)", () => {
    const model = makeModel({
      components: [
        comp("auth", "Identity Provider", "auth", "Keycloak", "high", ["ev-1"]),
      ],
    });
    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const authMapping = plan.awsMappings.find((m) => m.componentId === "auth");
    assert.ok(authMapping, "auth component must be mapped");
    assert.strictEqual(authMapping!.serviceId, "Cognito");
    assert.notStrictEqual(authMapping!.serviceId, "SecretsManager");
  });

  it("maps Kubernetes manifests to EKS + ECR", () => {
    const model = makeModel({
      components: [
        comp("api", "K8s Microservice", "backend", "Kubernetes", "high", ["ev-1"]),
      ],
    });
    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(serviceIds.includes("EKS"), "Kubernetes must map to EKS");
    assert.ok(serviceIds.includes("ECR"), "Kubernetes requires ECR");
  });
});

// ===========================================================================
// Priority 3 — Global Repository Extraction
// ===========================================================================

describe("Priority 3: Global Manifest & Component Extraction", () => {
  it("extracts nested multi-module Maven dependencies (e.g. spring-kafka, postgres, eureka)", () => {
    const signals: RepoSignals = {
      manifests: [
        {
          path: "pom.xml",
          content: `<project>
            <modules>
              <module>order-service</module>
              <module>inventory-service</module>
            </modules>
          </project>`,
        },
        {
          path: "order-service/pom.xml",
          content: `<project>
            <dependencies>
              <dependency>
                <groupId>org.springframework.kafka</groupId>
                <artifactId>spring-kafka</artifactId>
              </dependency>
              <dependency>
                <groupId>org.postgresql</groupId>
                <artifactId>postgresql</artifactId>
              </dependency>
            </dependencies>
          </project>`,
        },
        {
          path: "inventory-service/pom.xml",
          content: `<project>
            <dependencies>
              <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
              </dependency>
              <dependency>
                <groupId>org.opensearch.client</groupId>
                <artifactId>opensearch-rest-client</artifactId>
              </dependency>
            </dependencies>
          </project>`,
        },
      ],
      containerCi: [],
      sdkEvidence: [],
      keyFiles: [],
      fileTree: ["pom.xml", "order-service/pom.xml", "inventory-service/pom.xml"],
      githubReadme: "",
    };

    const profile = analyzeProject(signals, "");
    assert.ok(profile.databases.some((d) => d.name === "PostgreSQL"), "PostgreSQL extracted from order-service");
    assert.ok(profile.frameworks.some((f) => f.name === "Kafka"), "Kafka extracted from order-service");
    assert.ok(profile.databases.some((d) => d.name === "OpenSearch"), "OpenSearch extracted from inventory-service");
    assert.ok(profile.evidenceRegister && profile.evidenceRegister.length >= 3, "Evidence register built");
  });

  it("correctly categorizes Docker Compose services into semantic types", () => {
    const signals: RepoSignals = {
      manifests: [],
      containerCi: [
        {
          path: "docker-compose.yml",
          content: `version: '3.8'
services:
  kafka:
    image: confluentinc/cp-kafka:7.5.0
  opensearch:
    image: opensearchproject/opensearch:2.11.0
  keycloak:
    image: quay.io/keycloak/keycloak:22.0
  postgres:
    image: postgres:15
  pgadmin:
    image: dpage/pgadmin4
  maildev:
    image: maildev/maildev
`,
        },
      ],
      sdkEvidence: [],
      keyFiles: [],
      fileTree: ["docker-compose.yml"],
      githubReadme: "",
    };

    const profile = analyzeProject(signals, "");
    const dcMap = new Map(profile.discoveredComponents.map((c) => [c.name, c]));

    assert.strictEqual(dcMap.get("kafka")?.type, "messaging", "Kafka is messaging");
    assert.strictEqual(dcMap.get("opensearch")?.type, "search", "OpenSearch is search");
    assert.strictEqual(dcMap.get("keycloak")?.type, "auth", "Keycloak is auth");
    assert.strictEqual(dcMap.get("postgres")?.type, "database", "Postgres is database");
    assert.strictEqual(dcMap.get("pgadmin")?.type, "other", "pgAdmin is auxiliary tool (other)");
    assert.strictEqual(dcMap.get("maildev")?.type, "other", "maildev is auxiliary tool (other)");
  });
});

// ===========================================================================
// Priority 4 — Workload Classification
// ===========================================================================

describe("Priority 4: Workload Classification & Compute Mapping", () => {
  it("classifies CNN/training repo as ml-training and maps compute to SageMaker without ALB", () => {
    const signals: RepoSignals = {
      manifests: [
        {
          path: "requirements.txt",
          content: "torch\ntorchvision\ntensorflow\nnumpy\npandas\nscikit-learn\n",
        },
      ],
      containerCi: [],
      sdkEvidence: [],
      keyFiles: [
        {
          path: "train.py",
          content: "import torch\nimport torchvision\n# CNN model training loop\nfor epoch in range(10):\n  train_model()",
          kind: "source",
          tokenCount: 20,
        },
      ],
      fileTree: ["requirements.txt", "train.py", "model.py", "dataset/"],
      githubReadme: "Plant Disease Detection using Deep Learning CNN",
    };

    const profile = analyzeProject(signals, "");
    assert.strictEqual(profile.workloadClassification?.type, "ml-training");

    // Test compute mapping under ml-training workload
    const model = makeModel({
      components: [
        comp("cnn", "Plant Disease CNN", "backend", "PyTorch CNN model training", "high", ["requirements.txt"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, {
      ...BASE_CTX,
      workloadClassification: profile.workloadClassification,
    });

    const serviceIds = plan.awsMappings.map((m) => m.serviceId);
    assert.ok(serviceIds.includes("SageMaker"), `ML training must produce SageMaker; got ${serviceIds.join(", ")}`);
    assert.ok(!serviceIds.includes("ALB"), "ML training must NOT include Application Load Balancer");
    assert.ok(!serviceIds.includes("Route53"), "ML training must NOT include Route 53");
    assert.ok(!serviceIds.includes("S3"), "ML training must NOT include S3 without dataset evidence (Decision 51)");
  });

  it("classifies multi-module Spring Boot backend as microservices", () => {
    const signals: RepoSignals = {
      manifests: [
        {
          path: "pom.xml",
          content: "<project><modules><module>order</module><module>inventory</module><module>gateway</module></modules></project>",
        },
      ],
      containerCi: [
        {
          path: "docker-compose.yml",
          content: "services:\n  order:\n    build: .\n  inventory:\n    build: .\n  gateway:\n    build: .",
        },
      ],
      sdkEvidence: [],
      keyFiles: [],
      fileTree: ["pom.xml", "docker-compose.yml"],
      githubReadme: "E-Commerce Microservices",
    };

    const classification = classifyWorkload(signals, "E-Commerce Microservices");
    assert.strictEqual(classification.type, "microservices");
  });
});

// ===========================================================================
// Priority 5 — Separate Facts from Recommendations
// ===========================================================================

describe("Priority 5: Separation of Facts from Recommendations", () => {
  it("assigns appropriate categories and never assigns HIGH confidence to baseline services", () => {
    const model = makeModel({
      components: [
        comp("api", "API Service", "backend", "Node.js Express Docker", "high", ["ev-1"]),
        comp("db", "Database", "database", "PostgreSQL", "high", ["ev-2"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);

    for (const mapping of plan.awsMappings) {
      if (mapping.fromPattern) {
        // Baseline recommendations / inferences:
        assert.notStrictEqual(
          mapping.confidence,
          "high",
          `Baseline service ${mapping.serviceId} must NEVER have high confidence`
        );
        assert.ok(
          mapping.category === "recommendation" || mapping.category === "inference",
          `Baseline service ${mapping.serviceId} must have category recommendation or inference, got ${mapping.category}`
        );
      } else {
        // Grounded component mappings:
        assert.ok(
          mapping.category === "repository-evidence" || mapping.category === "deployment-requirement",
          `Component mapping ${mapping.serviceId} should have repository-evidence or deployment-requirement category`
        );
      }
    }
  });
});

// ===========================================================================
// Hardening: Final AWS Service Output Hardening
// ===========================================================================

describe("Hardening: Global Deduplication of Logical AWS Services", () => {
  it("merges frontend CloudFront and pattern CloudFront into one entry preserving provenance", () => {
    const rawMappings = [
      {
        componentId: "frontend",
        serviceId: "CloudFront" as const,
        confidence: "high" as const,
        evidence: "component frontend (React) → CDN",
        fromPattern: false,
        category: "deployment-requirement" as const,
      },
      {
        componentId: "pattern-cloudfront",
        serviceId: "CloudFront" as const,
        confidence: "medium" as const,
        evidence: "CloudFront CDN edge distribution",
        fromPattern: true,
        category: "recommendation" as const,
      },
    ];

    const deduplicated = deduplicateAwsMappings(rawMappings);
    assert.strictEqual(deduplicated.length, 1, "Must merge to exactly 1 CloudFront");
    const cf = deduplicated[0];
    assert.strictEqual(cf.serviceId, "CloudFront");
    assert.strictEqual(cf.componentId, "frontend", "Must preserve primary component ID over pattern ID");
    assert.strictEqual(cf.confidence, "high", "Must preserve highest confidence");
    assert.strictEqual(cf.category, "deployment-requirement", "deployment-requirement takes precedence over recommendation");
    assert.strictEqual(cf.fromPattern, false, "fromPattern is false when any source was not from pattern");
    assert.ok(cf.evidence.includes("component frontend (React) → CDN"), "Must preserve component evidence");
    assert.ok(cf.evidence.includes("CloudFront CDN edge distribution"), "Must preserve pattern evidence");
  });

  it("merges multiple S3 entries into one entry with combined evidence", () => {
    const rawMappings = [
      {
        componentId: "uploads",
        serviceId: "S3" as const,
        confidence: "high" as const,
        evidence: "express-fileupload → S3 bucket",
        fromPattern: false,
        category: "repository-evidence" as const,
      },
      {
        componentId: "frontend",
        serviceId: "S3" as const,
        confidence: "high" as const,
        evidence: "Next.js static assets",
        fromPattern: false,
        category: "repository-evidence" as const,
      },
      {
        componentId: "pattern-s3",
        serviceId: "S3" as const,
        confidence: "medium" as const,
        evidence: "S3 static asset storage & hosting",
        fromPattern: true,
        category: "recommendation" as const,
      },
    ];

    const deduplicated = deduplicateAwsMappings(rawMappings);
    assert.strictEqual(deduplicated.length, 1, "Must merge to exactly 1 S3");
    const s3 = deduplicated[0];
    assert.strictEqual(s3.serviceId, "S3");
    assert.strictEqual(s3.confidence, "high");
    assert.strictEqual(s3.category, "repository-evidence");
    assert.strictEqual(s3.fromPattern, false);
    assert.ok(s3.evidence.includes("express-fileupload"));
    assert.ok(s3.evidence.includes("Next.js static assets"));
  });

  it("mapArchitectureModelToServicePlan produces exactly one CloudFront for full-stack apps", () => {
    const model = makeModel({
      components: [
        comp("web", "Frontend", "frontend", "React Next.js", "high", ["ev-1"]),
        comp("api", "Backend", "backend", "Express", "high", ["ev-2"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const cloudFrontEntries = plan.awsMappings.filter((m) => m.serviceId === "CloudFront");
    assert.strictEqual(cloudFrontEntries.length, 1, "Must contain exactly ONE CloudFront mapping");
    assert.strictEqual(cloudFrontEntries[0].componentId, "web");
    assert.strictEqual(cloudFrontEntries[0].confidence, "high");
  });
});

describe("Hardening: Prevent Framework → AWS-Service Over-Inference", () => {
  it("Express alone does NOT map to APIGateway; recommends ALB and infers ECS", () => {
    const model = makeModel({
      components: [
        comp("api", "Express API", "api", "Express.js", "high", ["ev-1"]),
        comp("db", "Database", "database", "MySQL", "high", ["ev-2"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);

    assert.ok(!serviceIds.includes("APIGateway"), `Express alone must NOT produce APIGateway; got ${serviceIds.join(", ")}`);
    assert.ok(serviceIds.includes("ALB"), "Express API should recommend ALB for ingress");
    assert.ok(serviceIds.includes("ECS"), "Express API should infer container compute (ECS)");

    const albMapping = plan.awsMappings.find((m) => m.serviceId === "ALB")!;
    assert.strictEqual(albMapping.category, "recommendation", "ALB for framework API must be recommendation");
    assert.strictEqual(albMapping.confidence, "medium", "ALB recommendation must not be HIGH confidence");

    const ecsMapping = plan.awsMappings.find((m) => m.serviceId === "ECS")!;
    assert.strictEqual(ecsMapping.category, "inference", "ECS compute for framework must be inference");
  });

  it("enforces isMappingCompatible rejection of frameworks mapping directly to APIGateway", () => {
    assert.strictEqual(isMappingCompatible("Express", "APIGateway"), false);
    assert.strictEqual(isMappingCompatible("FastAPI", "APIGateway"), false);
    assert.strictEqual(isMappingCompatible("Spring Boot", "APIGateway"), false);
    assert.strictEqual(isMappingCompatible("Axum", "APIGateway"), false);
    assert.strictEqual(isMappingCompatible("Django", "APIGateway"), false);

    // Allowed when serverless/lambda/apigateway context is present
    assert.strictEqual(isMappingCompatible("Express Serverless Lambda", "APIGateway"), true);
    assert.strictEqual(isMappingCompatible("AWS APIGateway", "APIGateway"), true);
    assert.strictEqual(isMappingCompatible("Serverless HttpApi", "APIGateway"), true);
  });

  it("maps serverless API component to Lambda + APIGateway when serverless evidence exists", () => {
    const model = makeModel({
      components: [
        comp("api", "Serverless API", "api", "Node.js Serverless Lambda API", "high", ["ev-1"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);

    assert.ok(serviceIds.includes("Lambda"), "Serverless API must produce Lambda");
    assert.ok(serviceIds.includes("APIGateway"), "Serverless API must produce APIGateway");

    const gwMapping = plan.awsMappings.find((m) => m.serviceId === "APIGateway")!;
    assert.strictEqual(gwMapping.category, "deployment-requirement");
  });
});

describe("Hardening: Benchmark Repo 1 (Kuzma02 Electronics eCommerce)", () => {
  it("produces correct, deduplicated, properly-categorized services without APIGateway", () => {
    // Kuzma02 stack: Next.js 15 App Router, React 18, Express-fileupload, Prisma, MySQL
    const model = makeModel({
      appName: "Electronics eCommerce Shop With Admin Dashboard",
      components: [
        comp("web", "Next.js Frontend", "frontend", "Next.js React", "high", ["ev-1"]),
        comp("uploads", "File Uploads", "object-storage", "express-fileupload", "high", ["ev-2"]),
        comp("db", "MySQL Database", "database", "Prisma MySQL", "high", ["ev-3"]),
        comp("api", "API Layer", "api", "Express", "high", ["ev-4"]),
      ],
    });

    const plan = mapArchitectureModelToServicePlan(model, BASE_CTX);
    const serviceIds = plan.awsMappings.map((m) => m.serviceId);

    // 1. Deduplication checks
    const cloudFrontCount = plan.awsMappings.filter((m) => m.serviceId === "CloudFront").length;
    assert.strictEqual(cloudFrontCount, 1, `CloudFront must appear exactly once; count = ${cloudFrontCount}`);

    const s3Count = plan.awsMappings.filter((m) => m.serviceId === "S3").length;
    assert.strictEqual(s3Count, 1, `S3 must appear exactly once; count = ${s3Count}`);

    // 2. Over-inference checks: Express does NOT force APIGateway
    assert.ok(!serviceIds.includes("APIGateway"), "Must NOT infer APIGateway for Kuzma02");

    // 3. Expected architectural components
    assert.ok(serviceIds.includes("RDS"), "Must include RDS for MySQL database");
    assert.ok(serviceIds.includes("ECS"), "Must include ECS for container compute");
    assert.ok(serviceIds.includes("ALB"), "Must include ALB for public ingress");
    assert.ok(!serviceIds.includes("CloudWatch"), "Must NOT include CloudWatch without real evidence (Decision 51)");

    // 4. Forbidden hallucinations (from benchmark specification)
    const forbidden: ServiceId[] = ["DynamoDB", "Cognito", "SES", "ElastiCache", "SQS", "OpenSearch", "EKS"];
    for (const f of forbidden) {
      assert.ok(!serviceIds.includes(f), `Must NOT infer ${f} for Kuzma02`);
    }

    // 5. Provenance checks: recommendations must never be marked high confidence
    for (const mapping of plan.awsMappings) {
      assert.ok(mapping.category, `Service ${mapping.serviceId} must have category defined`);
      if (mapping.category === "recommendation") {
        assert.notStrictEqual(
          mapping.confidence,
          "high",
          `Recommendation service ${mapping.serviceId} must not have HIGH confidence`
        );
      }
    }
  });
});

