/**
 * repoAnalyzer.ts  —  Project Analysis Layer
 *
 * Takes raw RepoSignals and produces a ProjectProfile — a structured
 * understanding of what the repository actually contains, BEFORE any AWS
 * inference happens.
 *
 * Pipeline position:
 *   RepoSignals → analyzeProject() → ProjectProfile → ruleEngine + llmClient
 *
 * This separates the "what does the project use?" step from the
 * "which AWS services does it need?" step. The LLM previously had to do
 * both at once from raw files, which caused hallucinations. Now it only
 * does the inference step; this module does the analysis step deterministically.
 *
 * No network calls. No LLM. Pure TypeScript signal extraction.
 */

import { parse as parseYaml } from "yaml";
import type { RepoSignals, KeyFile } from "./repoFetcher.ts";
import type { EvidenceRecord } from "./schema.ts";

// ---------------------------------------------------------------------------
// Structural component discovery types
// ---------------------------------------------------------------------------

export type DiscoveredComponentType =
  | "frontend"
  | "backend"
  | "worker"
  | "scheduler"
  | "database"
  | "cache"
  | "queue"
  | "messaging"
  | "search"
  | "api"
  | "auth"
  | "storage"
  | "other";

/**
 * A distinct running process or data-tier component discovered from IaC config
 * or source-code evidence — BEFORE any AWS mapping.
 *
 * Unlike the tech bag in `ProjectProfile.frameworks/databases`, a
 * DiscoveredComponent represents a *separate deployable unit* (e.g. a
 * docker-compose service, a serverless function, a worker process file).
 * Each one maps to a distinct AWS service in the rule engine and LLM prompt.
 */
export interface DiscoveredComponent {
  /** Short kebab-case unique id within the profile (e.g. "dc-worker", "sc-redis") */
  id: string;
  /** Human-readable display name */
  name: string;
  type: DiscoveredComponentType;
  /** Actual technology (PostgreSQL, Redis, Bull/BullMQ, …) — never an AWS name */
  technology: string;
  /** Ordered list of evidence strings (file path + snippet) */
  evidence: string[];
  confidence: "high" | "medium" | "low";
  /** Which extraction pass found this component */
  source: "docker-compose" | "serverless-yml" | "iac" | "source-code" | "file-naming";
}

// ---------------------------------------------------------------------------
// Workload Classification types (Priority 4)
// ---------------------------------------------------------------------------

export type WorkloadType =
  | "web-application"
  | "api"
  | "microservices"
  | "worker"
  | "batch"
  | "ml-training"
  | "ml-inference"
  | "static-frontend"
  | "admin-monitoring-tool"
  | "generic";

export interface WorkloadClassification {
  primaryWorkload: WorkloadType;
  type?: WorkloadType;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface DetectedTech {
  name: string;
  /** Exact file path and field that proved this technology */
  evidence: string;
  /** How strong the signal is */
  confidence: "high" | "medium" | "low";
}

/** Terraform resource type → canonical AWS service label. */
export const TF_RESOURCE_MAP: Record<string, string> = {
  aws_eks_cluster: "EKS",
  aws_eks_node_group: "EC2",
  aws_instance: "EC2",
  aws_db_instance: "RDS",
  aws_rds_cluster: "Aurora",
  aws_vpc: "VPC",
  aws_subnet: "VPC",
  aws_internet_gateway: "VPC",
  aws_nat_gateway: "NATGateway",
  aws_iam_role: "IAM",
  aws_iam_policy: "IAM",
  aws_cloudwatch_log_group: "CloudWatch",
  aws_s3_bucket: "S3",
  aws_dynamodb_table: "DynamoDB",
  aws_sqs_queue: "SQS",
  aws_sns_topic: "SNS",
  aws_lambda_function: "Lambda",
  aws_ecs_cluster: "ECS",
  aws_ecs_service: "ECS",
  aws_ecr_repository: "ECR",
  aws_elasticache_cluster: "ElastiCache",
  aws_api_gateway_rest_api: "APIGateway",
  aws_lb: "ALB",
  aws_msk_cluster: "MSK",
  aws_opensearch_domain: "OpenSearch",
  aws_cognito_user_pool: "Cognito",
  aws_kms_key: "KMS",
  aws_secretsmanager_secret: "SecretsManager",
  aws_cloudwatch_event_rule: "EventBridge",
  aws_sfn_state_machine: "StepFunctions",
};

/** Terraform registry module name fragment → canonical AWS service label. */
export const TF_MODULE_MAP: Record<string, string> = {
  "terraform-aws-modules/vpc": "VPC",
  "terraform-aws-modules/eks": "EKS",
  "terraform-aws-modules/rds": "RDS",
  "terraform-aws-modules/iam": "IAM",
  "terraform-aws-modules/s3": "S3",
  "terraform-aws-modules/ec2": "EC2",
};

/**
 * Pure-library check: no entry points, no root-level container/IaC config,
 * and a manifest indicating a library (deno.json with exports, package.json
 * with lib entry and no start/dev script).
 */
export function detectLibraryRepo(
  files: Array<{ path: string; content: string }>,
  entryPoints: string[]
): boolean {
  if (entryPoints.length > 0) return false;
  const hasRootContainer = files.some((f) => {
    if (f.path.includes("/")) return false;
    return (
      /(?:^|\/)dockerfile(\.[\w.-]+)?$/i.test(f.path) ||
      /docker-compose(\.[\w.-]+)?\.(ya?ml)$/i.test(f.path) ||
      /^(template|sam)\.(ya?ml)$/i.test(f.path) ||
      /^serverless(\.[^.]*)?\.(ya?ml)$/i.test(f.path) ||
      /\.tf$/i.test(f.path)
    );
  });
  if (hasRootContainer) return false;

  // Lambda / function sources mean deployable units, not a library.
  const hasFunctionSources = files.some(
    (f) =>
      /(?:^|\/)(?:handler|lambda_function|lambda)\.(?:js|ts|mjs|cjs|py|go|java)$/i.test(f.path) ||
      (typeof f.content === "string" && /exports\.handler|def lambda_handler/i.test(f.content))
  );
  if (hasFunctionSources) return false;

  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path;
    if (/^deno\.jsonc?$/i.test(base)) {
      try {
        const parsed = JSON.parse(f.content) as Record<string, unknown>;
        if (parsed.exports !== undefined) return true;
      } catch {
        return true;
      }
    }
    if (base === "package.json") {
      try {
        const parsed = JSON.parse(f.content) as {
          main?: string; module?: string; exports?: unknown; bin?: unknown;
          scripts?: Record<string, string>;
        };
        // Build-tooling mains (gulp/grunt/webpack) are not library entries.
        const main = parsed.main ?? "";
        const isToolingMain = /gulp|grunt|webpack|rollup|esbuild/i.test(main);
        const isLibEntry =
          !isToolingMain && Boolean(parsed.main ?? parsed.module ?? parsed.exports);
        const scripts = parsed.scripts ?? {};
        const hasServeScript = Object.entries(scripts).some(
          ([k, v]) => /^(start|dev|serve)$/.test(k) || /node\s+server|next\s+start/i.test(v)
        );
        if (isLibEntry && !hasServeScript && parsed.bin === undefined) return true;
      } catch {
        // unparseable — not library evidence
      }
    }
  }
  return false;
}

/**
 * Walks every .tf file, extracts `resource "aws_X" "name"` blocks and
 * `source = "terraform-aws-modules/..."` strings, and returns one
 * infrastructure entry per distinct service.
 */
export function extractTerraformResources(
  files: Array<{ path: string; content: string | null }>
): DetectedTech[] {
  const found: DetectedTech[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith(".tf") || !file.content) continue;
    const resRe = /resource\s+"(aws_[a-zA-Z0-9_]+)"\s+"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = resRe.exec(file.content)) !== null) {
      const svc = TF_RESOURCE_MAP[m[1]];
      if (!svc || seen.has(svc)) continue;
      seen.add(svc);
      found.push({
        name: `Terraform resource (${svc})`,
        evidence: `${file.path} → resource "${m[1]}" "${m[2]}"`,
        confidence: "high",
      });
    }
    const modRe = /source\s*=\s*"([^"]*terraform-aws-modules\/[^"]*)"/g;
    while ((m = modRe.exec(file.content)) !== null) {
      const src = m[1].toLowerCase();
      for (const [frag, svc] of Object.entries(TF_MODULE_MAP)) {
        if (src.includes(frag) && !seen.has(svc)) {
          seen.add(svc);
          found.push({
            name: `Terraform resource (${svc})`,
            evidence: `${file.path} → module "${m[1]}"`,
            confidence: "high",
          });
        }
      }
      // EKS blueprints manage EC2 node groups even with no aws_instance block.
      if (/terraform-aws-modules\/eks\//.test(src) && !seen.has("EC2")) {
        seen.add("EC2");
        found.push({
          name: "Terraform resource (EC2)",
          evidence: `${file.path} → eks_managed_node_groups (EC2 workers)`,
          confidence: "high",
        });
      }
    }
  }
  return found;
}

export interface ProjectProfile {
  /** Primary programming languages detected */
  languages: DetectedTech[];
  /** Frameworks and major libraries (React, Express, Django, etc.) */
  frameworks: DetectedTech[];
  /** Database technologies (PostgreSQL, MongoDB, Redis, etc.) */
  databases: DetectedTech[];
  /** Infrastructure configs found (Docker, K8s, Serverless, Terraform) */
  infrastructure: DetectedTech[];
  /** Entry-point files detected (index.js, main.py, handler.ts, etc.) */
  entryPoints: string[];
  /** Explicit AWS SDK / service references found in code or configs */
  awsUsage: DetectedTech[];
  /** PaaS / hosting configs (Vercel, Netlify, Amplify) */
  deploymentHints: DetectedTech[];
  /** File paths where structured manifest parsing failed */
  parseFailures?: string[];
  /**
   * True when the repo is IaC-only (.tf files with no application code).
   * Suppresses inferring application-tier services not declared as resources.
   */
  isIacOnly?: boolean;
  /** True when the repo is a pure library/framework, not a deployable app. */
  isLibraryOrFramework?: boolean;
  /**
   * Structurally distinct running processes/data-tiers discovered from
   * docker-compose services, serverless functions, IaC resources, or
   * source-code client instantiations / worker file naming.
   */
  discoveredComponents: DiscoveredComponent[];
  /** Registered real evidence records from repository files with stable IDs */
  evidenceRegister?: EvidenceRecord[];
  /** Workload classification performed before compute selection */
  workloadClassification?: WorkloadClassification;
  /**
   * A concise, structured summary of detected technologies.
   * This is what gets passed to the LLM instead of raw file content.
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// Framework / library fingerprint tables
// ---------------------------------------------------------------------------

// Maps package name → { framework label, category }
export const NPM_FRAMEWORK_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  // Frontend frameworks
  react: { label: "React", category: "framework" },
  "react-dom": { label: "React", category: "framework" },
  vue: { label: "Vue.js", category: "framework" },
  "@vue/core": { label: "Vue.js", category: "framework" },
  angular: { label: "Angular", category: "framework" },
  "@angular/core": { label: "Angular", category: "framework" },
  svelte: { label: "Svelte", category: "framework" },
  "solid-js": { label: "SolidJS", category: "framework" },
  // Meta-frameworks
  next: { label: "Next.js", category: "framework" },
  nuxt: { label: "Nuxt.js", category: "framework" },
  remix: { label: "Remix", category: "framework" },
  gatsby: { label: "Gatsby", category: "framework" },
  astro: { label: "Astro", category: "framework" },
  // Build tools (signal for static site)
  vite: { label: "Vite", category: "framework" },
  webpack: { label: "Webpack", category: "framework" },
  // Backend frameworks
  express: { label: "Express.js", category: "framework" },
  fastify: { label: "Fastify", category: "framework" },
  koa: { label: "Koa", category: "framework" },
  "@nestjs/core": { label: "NestJS", category: "framework" },
  hono: { label: "Hono", category: "framework" },
  // Databases (npm packages → DB technology)
  mongoose: { label: "MongoDB", category: "database" },
  mongodb: { label: "MongoDB", category: "database" },
  pg: { label: "PostgreSQL", category: "database" },
  "pg-promise": { label: "PostgreSQL", category: "database" },
  postgres: { label: "PostgreSQL", category: "database" },
  mysql: { label: "MySQL", category: "database" },
  mysql2: { label: "MySQL", category: "database" },
  mariadb: { label: "MariaDB", category: "database" },
  sqlite3: { label: "SQLite", category: "database" },
  "better-sqlite3": { label: "SQLite", category: "database" },
  ioredis: { label: "Redis", category: "database" },
  redis: { label: "Redis", category: "database" },
  "@prisma/client": { label: "Prisma ORM", category: "database" },
  prisma: { label: "Prisma ORM", category: "database" },
  typeorm: { label: "TypeORM", category: "database" },
  sequelize: { label: "Sequelize ORM", category: "database" },
  knex: { label: "Knex.js (SQL)", category: "database" },
  "@aws-sdk/client-dynamodb": { label: "DynamoDB", category: "database" },
  "aws-sdk": { label: "AWS SDK v2", category: "framework" },
  // AWS SDK v3 (individual clients → explicit AWS usage)
  "@aws-sdk/client-s3": { label: "S3", category: "framework" },
  "@aws-sdk/client-lambda": { label: "Lambda", category: "framework" },
  "@aws-sdk/client-sqs": { label: "SQS", category: "framework" },
  "@aws-sdk/client-sns": { label: "SNS", category: "framework" },
  "@aws-sdk/client-rds": { label: "RDS", category: "framework" },
  "@aws-sdk/client-cognito-identity-provider": { label: "Cognito", category: "framework" },
  "@aws-sdk/client-cloudwatch": { label: "CloudWatch", category: "framework" },
  "@aws-sdk/client-ec2": { label: "EC2", category: "framework" },
  "@aws-sdk/client-ecs": { label: "ECS", category: "framework" },
  "@aws-sdk/client-ses": { label: "SES", category: "framework" },
  "@aws-sdk/client-eventbridge": { label: "EventBridge", category: "framework" },
  "@aws-sdk/client-kinesis": { label: "Kinesis", category: "framework" },
  // Messaging & Queues (npm)
  kafkajs: { label: "Kafka", category: "framework" },
  "@confluentinc/kafka-javascript": { label: "Kafka", category: "framework" },
  bull: { label: "Bull (queue)", category: "framework" },
  bullmq: { label: "BullMQ (queue)", category: "framework" },
  // Search & Storage (npm)
  "@opensearch-project/opensearch": { label: "OpenSearch", category: "database" },
  "@elastic/elasticsearch": { label: "OpenSearch", category: "database" },
  "express-fileupload": { label: "File Upload (S3)", category: "framework" },
  multer: { label: "File Upload (S3)", category: "framework" },
  formidable: { label: "File Upload (S3)", category: "framework" },
  // Email (npm)
  nodemailer: { label: "SES / Email", category: "framework" },
  "@sendgrid/mail": { label: "SES / Email", category: "framework" },
  // Auth (npm)
  "keycloak-js": { label: "Keycloak", category: "framework" },
  "keycloak-connect": { label: "Keycloak", category: "framework" },
  // ML
  "@tensorflow/tfjs": { label: "TensorFlow.js", category: "framework" },
  "@tensorflow/tfjs-node": { label: "TensorFlow.js", category: "framework" },
  "openai": { label: "OpenAI SDK", category: "framework" },
  "@anthropic-ai/sdk": { label: "Anthropic SDK", category: "framework" },
};

// Maps pip package name → label
export const PYTHON_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  django: { label: "Django", category: "framework" },
  flask: { label: "Flask", category: "framework" },
  fastapi: { label: "FastAPI", category: "framework" },
  starlette: { label: "Starlette", category: "framework" },
  tornado: { label: "Tornado", category: "framework" },
  aiohttp: { label: "aiohttp", category: "framework" },
  celery: { label: "Celery (task queue)", category: "framework" },
  gunicorn: { label: "Gunicorn", category: "framework" },
  uvicorn: { label: "Uvicorn", category: "framework" },
  // Messaging & Search (pip)
  "confluent-kafka": { label: "Kafka", category: "framework" },
  "kafka-python": { label: "Kafka", category: "framework" },
  "opensearch-py": { label: "OpenSearch", category: "database" },
  elasticsearch: { label: "OpenSearch", category: "database" },
  // Databases
  psycopg2: { label: "PostgreSQL", category: "database" },
  "psycopg2-binary": { label: "PostgreSQL", category: "database" },
  pymysql: { label: "MySQL", category: "database" },
  pymongo: { label: "MongoDB", category: "database" },
  motor: { label: "MongoDB (async)", category: "database" },
  redis: { label: "Redis", category: "database" },
  aioredis: { label: "Redis (async)", category: "database" },
  sqlalchemy: { label: "SQLAlchemy ORM", category: "database" },
  "django-redis": { label: "Redis", category: "database" },
  boto3: { label: "AWS SDK (boto3)", category: "framework" },
  // ML
  tensorflow: { label: "TensorFlow", category: "framework" },
  torch: { label: "PyTorch", category: "framework" },
  "scikit-learn": { label: "scikit-learn", category: "framework" },
  transformers: { label: "HuggingFace Transformers", category: "framework" },
  openai: { label: "OpenAI SDK", category: "framework" },
};

// Maps Go module path fragment → label
export const GO_MODULE_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  "gin-gonic/gin": { label: "Gin", category: "framework" },
  "gorm.io/gorm": { label: "GORM ORM", category: "framework" },
  "gorm.io/driver/postgres": { label: "PostgreSQL", category: "database" },
  "gorm.io/driver/mysql": { label: "MySQL", category: "database" },
  "gorm.io/driver/sqlite": { label: "SQLite", category: "database" },
  "mattn/go-sqlite3": { label: "SQLite", category: "database" },
  "modernc.org/sqlite": { label: "SQLite", category: "database" },
  "labstack/echo": { label: "Echo", category: "framework" },
  "gofiber/fiber": { label: "Fiber", category: "framework" },
  "gorilla/mux": { label: "Gorilla Mux", category: "framework" },
  "go-chi/chi": { label: "Chi", category: "framework" },
  "jackc/pgx": { label: "PostgreSQL", category: "database" },
  "lib/pq": { label: "PostgreSQL", category: "database" },
  "go-sql-driver/mysql": { label: "MySQL", category: "database" },
  "go-redis/redis": { label: "Redis", category: "database" },
  "mongodb/mongo-go-driver": { label: "MongoDB", category: "database" },
  "aws/aws-sdk-go": { label: "AWS SDK (Go v1)", category: "framework" },
  "aws/aws-sdk-go-v2": { label: "AWS SDK (Go v2)", category: "framework" },
};

// Maps Cargo crate name → label (Fix 6)
export const CARGO_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  tokio: { label: "Tokio", category: "framework" },
  "actix-web": { label: "Actix Web", category: "framework" },
  axum: { label: "Axum", category: "framework" },
  rocket: { label: "Rocket", category: "framework" },
  diesel: { label: "Diesel ORM", category: "database" },
  sqlx: { label: "SQLx", category: "database" },
  "sea-orm": { label: "SeaORM", category: "database" },
  redis: { label: "Redis", category: "database" },
  mongodb: { label: "MongoDB", category: "database" },
  "aws-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-sdk-lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "aws-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  "aws-sdk-sns": { label: "AWS SDK (SNS)", category: "aws" },
  rusoto_core: { label: "AWS SDK (Rusoto)", category: "aws" },
  rusoto_s3: { label: "AWS SDK (S3 / Rusoto)", category: "aws" },
  rusoto_dynamodb: { label: "AWS SDK (DynamoDB / Rusoto)", category: "aws" },
  rusoto_sqs: { label: "AWS SDK (SQS / Rusoto)", category: "aws" },
};

// Maps Maven / Gradle artifact name → label (Fix 6)
export const MAVEN_ARTIFACT_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "spring-boot": { label: "Spring Boot", category: "framework" },
  "spring-boot-starter-web": { label: "Spring Boot", category: "framework" },
  "spring-boot-starter-webflux": { label: "Spring WebFlux", category: "framework" },
  "spring-boot-starter-data-jpa": { label: "Spring Data JPA", category: "framework" },
  "spring-boot-starter-data-mongodb": { label: "MongoDB", category: "database" },
  "mongodb-driver-sync": { label: "MongoDB", category: "database" },
  "mongo-java-driver": { label: "MongoDB", category: "database" },
  "spring-boot-starter-data-redis": { label: "Redis", category: "database" },
  "spring-kafka": { label: "Kafka", category: "framework" },
  "kafka-clients": { label: "Kafka", category: "framework" },
  "spring-cloud-starter-stream-kafka": { label: "Kafka", category: "framework" },
  "kafka-avro-serializer": { label: "Avro / Schema Registry", category: "framework" },
  avro: { label: "Apache Avro", category: "framework" },
  "spring-cloud-starter-gateway": { label: "Spring Cloud Gateway", category: "framework" },
  "spring-cloud-starter-gateway-mvc": { label: "Spring Cloud Gateway", category: "framework" },
  "spring-cloud-starter-netflix-eureka-client": { label: "Eureka", category: "framework" },
  "spring-cloud-starter-netflix-eureka-server": { label: "Eureka Server", category: "framework" },
  "eureka-client": { label: "Eureka", category: "framework" },
  "spring-cloud-config-server": { label: "Spring Cloud Config", category: "framework" },
  "spring-cloud-starter-config": { label: "Spring Cloud Config", category: "framework" },
  "keycloak-spring-boot-starter": { label: "Keycloak", category: "framework" },
  "keycloak-adapter-core": { label: "Keycloak", category: "framework" },
  "keycloak-spring-security-adapter": { label: "Keycloak", category: "framework" },
  "spring-boot-starter-oauth2-resource-server": { label: "Keycloak / OAuth2", category: "framework" },
  "spring-boot-starter-mail": { label: "Spring Mail", category: "framework" },
  "opensearch-rest-high-level-client": { label: "OpenSearch", category: "database" },
  "opensearch-rest-client": { label: "OpenSearch", category: "database" },
  opensearch: { label: "OpenSearch", category: "database" },
  "opensearch-java": { label: "OpenSearch", category: "database" },
  "spring-data-opensearch": { label: "OpenSearch", category: "database" },
  "spring-data-elasticsearch": { label: "OpenSearch", category: "database" },
  elasticsearch: { label: "OpenSearch", category: "database" },
  "jib-maven-plugin": { label: "Docker (Jib)", category: "framework" },
  "flyway-core": { label: "Flyway (Migrations)", category: "database" },
  "liquibase-core": { label: "Liquibase (Migrations)", category: "database" },
  resilience4j: { label: "Resilience4j", category: "framework" },
  "resilience4j-spring-boot3": { label: "Resilience4j", category: "framework" },
  "micrometer-registry-prometheus": { label: "Prometheus", category: "framework" },
  "zipkin-reporter": { label: "Zipkin", category: "framework" },
  quarkus: { label: "Quarkus", category: "framework" },
  "quarkus-core": { label: "Quarkus", category: "framework" },
  micronaut: { label: "Micronaut", category: "framework" },
  "micronaut-core": { label: "Micronaut", category: "framework" },
  hibernate: { label: "Hibernate ORM", category: "database" },
  "hibernate-core": { label: "Hibernate ORM", category: "database" },
  postgresql: { label: "PostgreSQL", category: "database" },
  "mysql-connector-java": { label: "MySQL", category: "database" },
  "mysql-connector-j": { label: "MySQL", category: "database" },
  jedis: { label: "Redis", category: "database" },
  lettuce: { label: "Redis", category: "database" },
  "aws-java-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-java-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-java-sdk-lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "aws-java-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  s3: { label: "AWS SDK v2 (S3)", category: "aws" },
  dynamodb: { label: "AWS SDK v2 (DynamoDB)", category: "aws" },
  lambda: { label: "AWS SDK v2 (Lambda)", category: "aws" },
  sqs: { label: "AWS SDK v2 (SQS)", category: "aws" },
};

// Maps Ruby gem name → label (Fix 6)
export const RUBY_GEM_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  rails: { label: "Ruby on Rails", category: "framework" },
  sinatra: { label: "Sinatra", category: "framework" },
  pg: { label: "PostgreSQL", category: "database" },
  mysql2: { label: "MySQL", category: "database" },
  redis: { label: "Redis", category: "database" },
  sidekiq: { label: "Sidekiq (task queue)", category: "framework" },
  "aws-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  "aws-sdk": { label: "AWS SDK (Ruby)", category: "aws" },
};

// Maps PHP Composer package name → label (Fix 6)
export const PHP_COMPOSER_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "laravel/framework": { label: "Laravel", category: "framework" },
  "symfony/framework-bundle": { label: "Symfony", category: "framework" },
  "doctrine/orm": { label: "Doctrine ORM", category: "database" },
  "predis/predis": { label: "Redis", category: "database" },
  "aws/aws-sdk-php": { label: "AWS SDK (PHP)", category: "aws" },
};

// Maps .NET / NuGet package name → label (Fix 6)
export const DOTNET_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "Microsoft.AspNetCore.App": { label: "ASP.NET Core", category: "framework" },
  "Microsoft.EntityFrameworkCore": { label: "Entity Framework Core", category: "database" },
  "Npgsql.EntityFrameworkCore.PostgreSQL": { label: "PostgreSQL", category: "database" },
  "Npgsql": { label: "PostgreSQL", category: "database" },
  "Pomelo.EntityFrameworkCore.MySql": { label: "MySQL", category: "database" },
  "MySql.Data": { label: "MySQL", category: "database" },
  "MySqlConnector": { label: "MySQL", category: "database" },
  "Microsoft.EntityFrameworkCore.SqlServer": { label: "SQL Server", category: "database" },
  "Microsoft.Data.SqlClient": { label: "SQL Server", category: "database" },
  "System.Data.SqlClient": { label: "SQL Server", category: "database" },
  "MongoDB.Driver": { label: "MongoDB", category: "database" },
  "MongoDB.Driver.Core": { label: "MongoDB", category: "database" },
  "StackExchange.Redis": { label: "Redis", category: "database" },
  "Microsoft.Extensions.Caching.StackExchangeRedis": { label: "Redis", category: "database" },
  "Google.Cloud.Spanner.Data": { label: "Cloud Spanner", category: "database" },
  "AWSSDK.S3": { label: "AWS SDK (S3)", category: "aws" },
  "AWSSDK.DynamoDBv2": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "AWSSDK.SQS": { label: "AWS SDK (SQS)", category: "aws" },
  "AWSSDK.Lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "AWSSDK.Core": { label: "AWS SDK (.NET)", category: "aws" },
};

// ---------------------------------------------------------------------------
// Language detection from file extensions in the tree
// ---------------------------------------------------------------------------

export const ELIXIR_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  phoenix: { label: "Phoenix", category: "framework" },
  plug: { label: "Plug", category: "framework" },
  ecto: { label: "Ecto ORM", category: "database" },
  ecto_sql: { label: "Ecto ORM", category: "database" },
  postgrex: { label: "PostgreSQL", category: "database" },
  redix: { label: "Redis", category: "database" },
  broadway: { label: "Broadway (pipeline)", category: "framework" },
  ex_aws: { label: "AWS SDK (Elixir)", category: "aws" },
  aws_elixir: { label: "AWS SDK (Elixir)", category: "aws" },
};

export function parseMixExs(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = line.match(/\{:\s*([a-zA-Z0-9_]+)\s*,/);
    if (match) {
      packages.push({ name: match[1].toLowerCase() });
    }
  }
  return packages;
}

export const LANG_FROM_MANIFEST: Array<{ file: RegExp; lang: string }> = [
  { file: /^deno\.jsonc?$/, lang: "Deno/TypeScript" },
  { file: /^mix\.exs$/, lang: "Elixir" },
  { file: /^package\.json$/, lang: "Node.js/TypeScript" },
  { file: /^requirements\.txt$|^pyproject\.toml$|^setup\.py$/, lang: "Python" },
  { file: /^go\.mod$/, lang: "Go" },
  { file: /^cargo\.toml$/i, lang: "Rust" },
  { file: /^gemfile$/i, lang: "Ruby" },
  { file: /^composer\.json$/, lang: "PHP" },
  { file: /^pom\.xml$|^build\.gradle(\.kts)?$/, lang: "Java/JVM" },
  { file: /^[\w.-]+\.csproj$/, lang: "C#/.NET" },
];

// ---------------------------------------------------------------------------
// Infrastructure detection
// ---------------------------------------------------------------------------

export interface InfraSignal {
  pattern: RegExp;
  label: string;
  confidence: "high" | "medium" | "low";
}

export const INFRA_FILE_SIGNALS: InfraSignal[] = [
  { pattern: /(?:^|\/)deno\.jsonc?$/i, label: "Deno runtime config", confidence: "high" },
  { pattern: /(?:^|\/)Dockerfile(\.[\w.-]+)?$/i, label: "Docker (Dockerfile)", confidence: "high" },
  { pattern: /(?:^|\/)docker-compose(\.[\w.-]+)?\.(ya?ml)$/i, label: "Docker Compose", confidence: "high" },
  { pattern: /(?:^|\/)serverless(\.[\w.-]+)?\.(ya?ml)$/i, label: "Serverless Framework", confidence: "high" },
  { pattern: /(?:^|\/)(?:template|sam)\.(ya?ml)$/i, label: "AWS SAM (template.yaml)", confidence: "high" },
  { pattern: /^(?:terraform|infra|\.infra)\/.*\.tf$|^.*\.tf$/i, label: "Terraform", confidence: "high" },
  { pattern: /^\.github\/workflows\/.+\.(ya?ml)$/i, label: "GitHub Actions CI/CD", confidence: "medium" },
  { pattern: /(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\//i, label: "Kubernetes manifests", confidence: "high" },
  { pattern: /(?:^|\/)Chart\.ya?ml$/i, label: "Kubernetes manifests", confidence: "high" },
  { pattern: /^vercel\.json$/i, label: "Vercel deployment config", confidence: "high" },
  { pattern: /^netlify\.toml$/i, label: "Netlify deployment config", confidence: "high" },
  { pattern: /^amplify\.ya?ml$|^amplify\//i, label: "AWS Amplify config", confidence: "high" },
  { pattern: /^\.ebextensions\//i, label: "Elastic Beanstalk config", confidence: "high" },
  { pattern: /^appspec\.ya?ml$/i, label: "AWS CodeDeploy config", confidence: "high" },
  { pattern: /^buildspec\.ya?ml$/i, label: "AWS CodeBuild config", confidence: "high" },
  { pattern: /^(?:\.cloudformation|cloudformation)\/.*$/i, label: "AWS CloudFormation", confidence: "high" },
  { pattern: /^cdk\.json$/i, label: "AWS CDK config", confidence: "high" },
];

export const DEPLOYMENT_HINT_SIGNALS: InfraSignal[] = [
  { pattern: /^vercel\.json$/i, label: "Vercel", confidence: "high" },
  { pattern: /^netlify\.toml$/i, label: "Netlify", confidence: "high" },
  { pattern: /^amplify\.ya?ml$|^amplify\//i, label: "AWS Amplify", confidence: "high" },
  { pattern: /^\.ebextensions\//i, label: "AWS Elastic Beanstalk", confidence: "high" },
];

// ---------------------------------------------------------------------------
// AWS SDK content-level detection
// ---------------------------------------------------------------------------

const AWS_SDK_CONTENT_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /from\s+['"]@aws-sdk\/client-s3['"]/,         service: "S3" },
  { pattern: /from\s+['"]@aws-sdk\/client-lambda['"]/,     service: "Lambda" },
  { pattern: /from\s+['"]@aws-sdk\/client-sqs['"]/,        service: "SQS" },
  { pattern: /from\s+['"]@aws-sdk\/client-sns['"]/,        service: "SNS" },
  { pattern: /from\s+['"]@aws-sdk\/client-dynamodb['"]/,   service: "DynamoDB" },
  { pattern: /from\s+['"]@aws-sdk\/client-rds['"]/,        service: "RDS" },
  { pattern: /from\s+['"]@aws-sdk\/client-cognito/,        service: "Cognito" },
  { pattern: /from\s+['"]@aws-sdk\/client-cloudwatch['"]/,  service: "CloudWatch" },
  { pattern: /from\s+['"]@aws-sdk\/client-ec2['"]/,        service: "EC2" },
  { pattern: /from\s+['"]@aws-sdk\/client-ecs['"]/,        service: "ECS" },
  { pattern: /from\s+['"]@aws-sdk\/client-ses['"]/,        service: "SES" },
  { pattern: /from\s+['"]@aws-sdk\/client-eventbridge['"]/,service: "EventBridge" },
  { pattern: /from\s+['"]@aws-sdk\/client-kinesis['"]/,    service: "Kinesis" },
  { pattern: /import boto3/,                                service: "AWS SDK (boto3)" },
  { pattern: /boto3\.client\(['"]([a-z0-9-]+)['"]\)/,      service: "AWS SDK (boto3)" },
  { pattern: /aws-sdk-go/,                                  service: "AWS SDK (Go)" },
];

// ---------------------------------------------------------------------------
// Parsers for specific manifest formats (Fix 6)
// ---------------------------------------------------------------------------

export interface ParsedPackage {
  name: string;
  version?: string;
}

export function parsePyprojectToml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  let section = "";
  let inDepArray = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      inDepArray = false;
      continue;
    }

    if (section === "project.dependencies" || section === "project") {
      if (line.startsWith("dependencies")) {
        inDepArray = true;
      }
      if (inDepArray || section === "project.dependencies") {
        const matches = line.matchAll(/['"]([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?(?:[><=~!^@][^'"]*)?['"]/g);
        for (const m of matches) {
          if (m[1].toLowerCase() !== "dependencies") {
            packages.push({ name: m[1].toLowerCase() });
          }
        }
        // Only terminate array if line ends with ] (not inside a string like [standard])
        if (/\]\s*,?$/.test(line) && !line.startsWith("dependencies")) {
          inDepArray = false;
        } else if (line.startsWith("dependencies") && line.endsWith("]")) {
          inDepArray = false;
        }
      }
    }

    if (
      section === "tool.poetry.dependencies" ||
      section === "tool.poetry.dev-dependencies" ||
      section.startsWith("tool.poetry.group.")
    ) {
      const poetryMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(?:['"]([^'"]+)['"]|\{.*?version\s*=\s*['"]([^'"]+)['"].*\}|.+)/);
      if (poetryMatch && poetryMatch[1].toLowerCase() !== "python") {
        packages.push({
          name: poetryMatch[1].toLowerCase(),
          version: poetryMatch[2] || poetryMatch[3],
        });
      }
    }
  }

  return packages;
}

export function parseCargoToml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  let inDeps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      const sec = sectionMatch[1].trim().toLowerCase();
      inDeps = /dependencies/.test(sec);
      continue;
    }

    if (inDeps) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(?:['"]([^'"]+)['"]|\{.*?(?:version\s*=\s*['"]([^'"]+)['"])?.*?\})/);
      if (match) {
        packages.push({
          name: match[1].toLowerCase(),
          version: match[2] || match[3],
        });
      }
    }
  }

  return packages;
}

export function parsePomXml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const depBlocks = content.match(/<(?:dependency|plugin)>[\s\S]*?<\/(?:dependency|plugin)>/gi) || [];
  for (const block of depBlocks) {
    const groupMatch = block.match(/<groupId>([\s\S]*?)<\/groupId>/i);
    const artifactMatch = block.match(/<artifactId>([\s\S]*?)<\/artifactId>/i);
    const versionMatch = block.match(/<version>([\s\S]*?)<\/version>/i);

    const groupId = groupMatch ? groupMatch[1].trim() : "";
    const artifactId = artifactMatch ? artifactMatch[1].trim() : "";
    const version = versionMatch ? versionMatch[1].trim() : undefined;

    if (artifactId) {
      packages.push({
        name: groupId ? `${groupId}:${artifactId}` : artifactId,
        version,
      });
    }
  }
  return packages;
}

export function parseBuildGradle(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("/*")) continue;

    const match = line.match(/(?:implementation|compile|api|runtimeOnly|testImplementation)\s*[\(\s]['"]([^:'"\s]+):([^:'"\s]+)(?::([^'"\s]+))?['"]\)?/);
    if (match) {
      packages.push({
        name: `${match[1]}:${match[2]}`,
        version: match[3],
      });
    }
  }
  return packages;
}

export function parseGemfile(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;

    const match = line.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (match) {
      packages.push({
        name: match[1].toLowerCase(),
        version: match[2],
      });
    }
  }
  return packages;
}

export function parseComposerJson(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const all = {
    ...((parsed.require as Record<string, string>) ?? {}),
    ...((parsed["require-dev"] as Record<string, string>) ?? {}),
  };
  for (const [pkg, ver] of Object.entries(all)) {
    packages.push({ name: pkg.toLowerCase(), version: typeof ver === "string" ? ver : undefined });
  }
  return packages;
}

export function parseCsProj(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const matches = content.matchAll(/<PackageReference\s+[^>]*Include=["']([^"']+)["'][^>]*(?:Version=["']([^"']+)["'])?[^>]*\/?>/gi);
  for (const m of matches) {
    packages.push({
      name: m[1],
      version: m[2],
    });
  }
  return packages;
}

/**
 * Normalization helper mapping parsed packages to tech entries
 */
export function mapParsedPackages(
  pkgs: ParsedPackage[],
  filePath: string,
  mappingTable: Record<string, { label: string; category: "framework" | "database" | "aws" | "runtime" }>
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const pkg of pkgs) {
    let match = mappingTable[pkg.name];
    if (!match) {
      const parts = pkg.name.split(":");
      if (parts.length > 1 && mappingTable[parts[1]]) {
        match = mappingTable[parts[1]];
      } else {
        const normPkg = pkg.name.toLowerCase();
        for (const [key, val] of Object.entries(mappingTable)) {
          const normKey = key.toLowerCase();
          if (normPkg === normKey) {
            match = val;
            break;
          }
        }
        if (!match) {
          for (const [key, val] of Object.entries(mappingTable)) {
            const normKey = key.toLowerCase();
            if (normKey.length < 4) continue;
            const tokenRe = new RegExp(`(^|[/_.-])${normKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[/_.-])`);
            if (tokenRe.test(normPkg)) {
              match = val;
              break;
            }
          }
        }
      }
    }

    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${pkg.name}${pkg.version ? `@${pkg.version}` : ""}`,
      confidence: "high",
    };

    if (match.category === "aws" || match.label.startsWith("AWS SDK")) {
      awsUsage.push(entry);
    } else if (match.category === "database") {
      databases.push(entry);
    } else {
      frameworks.push(entry);
    }
  }

  return { frameworks, databases, awsUsage };
}

/**
 * Parses package.json and extracts frameworks + databases from dependencies.
 */
function analyzePackageJson(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse package.json at ${filePath}`);
  }

  const allDeps: Record<string, string> = {
    ...((parsed.dependencies as Record<string, string>) ?? {}),
    ...((parsed.devDependencies as Record<string, string>) ?? {}),
  };

  for (const [pkg, _version] of Object.entries(allDeps)) {
    const match = NPM_FRAMEWORK_MAP[pkg];
    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${parsed.dependencies && pkg in (parsed.dependencies as object) ? "dependencies" : "devDependencies"}.${pkg}`,
      confidence: "high",
    };

    if (match.category === "database") {
      databases.push(entry);
    } else if (match.label.startsWith("AWS") || match.label.includes("DynamoDB") || match.label.includes("S3") || match.label.includes("Lambda") || match.label.includes("SQS") || match.label.includes("SNS") || match.label.includes("Cognito") || match.label.includes("CloudWatch") || match.label.includes("EC2") || match.label.includes("ECS") || match.label.includes("SES") || match.label.includes("EventBridge") || match.label.includes("Kinesis") || match.label.includes("RDS")) {
      awsUsage.push(entry);
    } else {
      frameworks.push(entry);
    }
  }

  // Also check scripts for hints (e.g. "build": "vite build", "start": "node server.js")
  const scripts = (parsed.scripts as Record<string, string>) ?? {};
  if (scripts.build?.includes("vite") && !seen.has("Vite")) {
    seen.add("Vite");
    frameworks.push({ name: "Vite", evidence: `${filePath} → scripts.build`, confidence: "high" });
  }
  if ((scripts.start?.includes("next") || scripts.dev?.includes("next")) && !seen.has("Next.js")) {
    seen.add("Next.js");
    frameworks.push({ name: "Next.js", evidence: `${filePath} → scripts.start/dev`, confidence: "medium" });
  }

  return { frameworks, databases, awsUsage };
}

/**
 * Parses requirements.txt line by line and extracts Python packages.
 */
function analyzeRequirementsTxt(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith("#")) continue;
    // Strip version specifiers: flask>=2.0 → flask
    const pkgName = line.replace(/[><=!~\s].*/g, "").replace(/\[.*\]/, "");
    const match = PYTHON_PACKAGE_MAP[pkgName];
    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${pkgName}`,
      confidence: "high",
    };

    if (match.label.startsWith("AWS SDK")) {
      awsUsage.push(entry);
    } else if (match.category === "database") {
      databases.push(entry);
    } else {
      frameworks.push(entry);
    }
  }
  return { frameworks, databases, awsUsage };
}

/**
 * Parses go.mod and extracts Go packages/frameworks.
 */
function analyzeGoMod(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    // require lines: github.com/gin-gonic/gin v1.9.1
    const requireMatch = line.match(/^(?:require\s+)?(\S+)\s+v\S+/);
    if (!requireMatch) continue;
    const modulePath = requireMatch[1];

    for (const [fragment, info] of Object.entries(GO_MODULE_MAP)) {
      if (modulePath.includes(fragment) && !seen.has(info.label)) {
        seen.add(info.label);
        const entry: DetectedTech = {
          name: info.label,
          evidence: `${filePath} → ${modulePath}`,
          confidence: "high",
        };
        if (info.label.startsWith("AWS SDK")) {
          awsUsage.push(entry);
        } else if (info.category === "database") {
          databases.push(entry);
        } else {
          frameworks.push(entry);
        }
      }
    }
  }
  return { frameworks, databases, awsUsage };
}

/**
 * Scans raw file content for AWS SDK import patterns.
 */
function scanContentForAwsUsage(content: string, filePath: string): DetectedTech[] {
  const found: DetectedTech[] = [];
  const seen = new Set<string>();
  for (const { pattern, service } of AWS_SDK_CONTENT_PATTERNS) {
    if (pattern.test(content) && !seen.has(service)) {
      seen.add(service);
      found.push({
        name: service,
        evidence: `${filePath} → SDK import`,
        confidence: "high",
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry-point detection
// ---------------------------------------------------------------------------

export const ENTRY_POINT_PATTERNS = [
  /^(src\/)?index\.(js|ts|mjs|cjs)$/,
  /^(src\/)?main\.(js|ts|py|go|rs)$/,
  /^(src\/)?app\.(js|ts|py)$/,
  /^(src\/)?server\.(js|ts)$/,
  /^(src\/)?handler\.(js|ts|py)$/,
  /^cmd\/main\.go$/,
  /^main\.py$/,
  /^manage\.py$/,
  /^wsgi\.py$/,
  /^asgi\.py$/,
];

// ---------------------------------------------------------------------------
// Pass A — IaC/config structural extraction (docker-compose, serverless.yml)
// ---------------------------------------------------------------------------

/**
 * Parses a docker-compose.yml and emits one DiscoveredComponent per service.
 * Type is inferred from the image name first, then from the service name.
 */
function extractDockerComposeComponents(
  content: string,
  filePath: string
): DiscoveredComponent[] {
  const components: DiscoveredComponent[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return components;
  }
  if (typeof parsed !== "object" || parsed === null) return components;
  const doc = parsed as Record<string, unknown>;
  const services = doc["services"];
  if (typeof services !== "object" || services === null) return components;

  for (const [serviceName, serviceCfg] of Object.entries(
    services as Record<string, unknown>
  )) {
    const cfg = (serviceCfg ?? {}) as Record<string, unknown>;
    const image = String(cfg["image"] ?? "").toLowerCase();
    const hasBuild = cfg["build"] !== undefined;

    let type: DiscoveredComponentType = "other";
    let technology = serviceName;

    // Image-driven classification (strong signal)
    if (/postgres|postgresql/.test(image)) {
      type = "database"; technology = "PostgreSQL";
    } else if (/mysql|mariadb/.test(image)) {
      type = "database"; technology = "MySQL";
    } else if (/mongo/.test(image)) {
      type = "database"; technology = "MongoDB";
    } else if (/redis/.test(image)) {
      type = "cache"; technology = "Redis";
    } else if (/memcached/.test(image)) {
      type = "cache"; technology = "Memcached";
    } else if (/rabbitmq/.test(image)) {
      type = "queue"; technology = "RabbitMQ";
    } else if (/kafka/.test(image)) {
      type = "messaging"; technology = "Kafka";
    } else if (/zookeeper/.test(image)) {
      type = "other"; technology = "ZooKeeper";
    } else if (/keycloak/.test(image)) {
      type = "auth"; technology = "Keycloak";
    } else if (/opensearch-dashboards|kibana/.test(image)) {
      type = "other"; technology = "OpenSearch Dashboards";
    } else if (/opensearch|elasticsearch/.test(image)) {
      type = "search"; technology = "OpenSearch";
    } else if (/pgadmin/.test(image)) {
      type = "other"; technology = "pgAdmin";
    } else if (/adminer/.test(image)) {
      type = "other"; technology = "Adminer";
    } else if (/phpmyadmin/.test(image)) {
      type = "other"; technology = "phpMyAdmin";
    } else if (/flower/.test(image)) {
      type = "other"; technology = "Flower";
    } else if (/portainer/.test(image)) {
      type = "other"; technology = "Portainer";
    } else if (/maildev|mailhog/.test(image)) {
      type = "other"; technology = "MailDev";
    } else if (/prometheus/.test(image)) {
      type = "other"; technology = "Prometheus";
    } else if (/grafana/.test(image)) {
      type = "other"; technology = "Grafana";
    } else if (/zipkin|jaeger/.test(image)) {
      type = "other"; technology = "Zipkin";
    } else if (/nginx/.test(image)) {
      type = "api"; technology = "Nginx";
    } else if (/traefik|caddy/.test(image)) {
      type = "api"; technology = image.includes("traefik") ? "Traefik" : "Caddy";
    } else if (/adminer|phpmyadmin|pgadmin|grafana|prometheus|kibana|flower|jaeger|zipkin|portainer|monitoring/.test(serviceName)) {
      type = "other"; technology = serviceName;
    } else if (hasBuild || image === "") {
      // Application code service — classify by service name
      if (/worker|consumer|processor/.test(serviceName)) {
        type = "worker"; technology = "custom";
      } else if (/cron|scheduler|schedule/.test(serviceName)) {
        type = "scheduler"; technology = "custom";
      } else if (/(?:^|[-_])(frontend|web|client|ui)(?:$|[-_])/.test(serviceName) || /frontend|client/.test(serviceName)) {
        type = "frontend"; technology = "custom";
      } else {
        type = "backend"; technology = "custom";
      }
    }

    const evidence: string[] = [`${filePath} → services.${serviceName}`];
    if (image) evidence.push(`image: ${image}`);
    if (hasBuild) evidence.push("build: (local Dockerfile)");

    components.push({
      id: `dc-${serviceName}`,
      name: serviceName,
      type,
      technology,
      evidence,
      confidence: "high",
      source: "docker-compose",
    });
  }

  return components;
}

/**
 * Parses a serverless.yml / serverless.yaml and emits one DiscoveredComponent
 * per function, classifying by event type (http → api, sqs/sns → worker,
 * schedule → scheduler, none → backend Lambda).
 */
function extractServerlessComponents(
  content: string,
  filePath: string
): DiscoveredComponent[] {
  const components: DiscoveredComponent[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return components;
  }
  if (typeof parsed !== "object" || parsed === null) return components;
  const doc = parsed as Record<string, unknown>;

  // Only handle AWS provider
  const provider = doc["provider"];
  const providerName =
    typeof provider === "object" && provider !== null
      ? String((provider as Record<string, unknown>)["name"] ?? "")
      : String(provider ?? "");
  if (!providerName.toLowerCase().includes("aws")) return components;

  const functions = doc["functions"];
  if (typeof functions !== "object" || functions === null) return components;

  for (const [fnName, fnCfg] of Object.entries(
    functions as Record<string, unknown>
  )) {
    const cfg = (fnCfg ?? {}) as Record<string, unknown>;
    const events = Array.isArray(cfg["events"]) ? cfg["events"] : [];

    let type: DiscoveredComponentType = "backend";
    for (const event of events) {
      if (typeof event !== "object" || event === null) continue;
      const keys = Object.keys(event as object);
      if (keys.some((k) => k === "http" || k === "httpApi")) {
        type = "api"; break;
      }
      if (keys.some((k) => k === "sqs" || k === "sns" || k === "stream" || k === "kafka")) {
        type = "worker"; break;
      }
      if (keys.some((k) => k === "schedule")) {
        type = "scheduler"; break;
      }
    }

    // Name-based override (more specific than event type)
    if (/worker|consumer|processor/.test(fnName)) type = "worker";
    else if (/cron|scheduler|scheduled/.test(fnName)) type = "scheduler";

    components.push({
      id: `sls-${fnName}`,
      name: fnName,
      type,
      technology: "AWS Lambda",
      evidence: [`${filePath} → functions.${fnName}`],
      confidence: "high",
      source: "serverless-yml",
    });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Passes B+C — Source-code instantiation + worker file naming
// ---------------------------------------------------------------------------

// Client-instantiation patterns → component type + technology.
// Each pattern is tested against file content; the first match per
// (type, technology) pair is recorded as a new DiscoveredComponent.
const SOURCE_INSTANTIATION_PATTERNS: Array<{
  pattern: RegExp;
  type: DiscoveredComponentType;
  technology: string;
  confidence: "high" | "medium" | "low";
}> = [
  // PostgreSQL clients
  {
    pattern: /new\s+Pool\s*\(|pg\.Pool\s*\(|createPool\s*\(.*postgres/i,
    type: "database", technology: "PostgreSQL", confidence: "high",
  },
  // MongoDB clients
  {
    pattern: /mongoose\.connect\s*\(|new\s+MongoClient\s*\(/i,
    type: "database", technology: "MongoDB", confidence: "high",
  },
  // MySQL clients
  {
    pattern: /createConnection\s*\(\s*\{|mysql\.createPool\s*\(|mariadb\.createPool\s*\(/i,
    type: "database", technology: "MySQL", confidence: "high",
  },
  // Redis clients (ioredis `new Redis(…)` OR node-redis `redis.createClient(…)`)
  {
    pattern: /redis\.createClient\s*\(|new\s+Redis\s*\(|createClient\s*\(\s*\{?\s*url\s*:\s*['"]redis/i,
    type: "cache", technology: "Redis", confidence: "high",
  },
  // Bull / BullMQ queues
  {
    pattern: /new\s+Bull\s*\(|new\s+Queue\s*\(|new\s+Worker\s*\(.*[Bb]ull|BullMQ/i,
    type: "queue", technology: "Bull/BullMQ", confidence: "high",
  },
  // Celery (Python)
  {
    pattern: /Celery\s*\(|celery\s*=\s*Celery\s*\(|@app\.task|@celery\.task/i,
    type: "queue", technology: "Celery", confidence: "high",
  },
  // node-cron / cron
  {
    pattern: /cron\.schedule\s*\(|new\s+CronJob\s*\(|schedule\.scheduleJob\s*\(/i,
    type: "scheduler", technology: "node-cron", confidence: "high",
  },
  // Python APScheduler
  {
    pattern: /APScheduler|BlockingScheduler\s*\(|BackgroundScheduler\s*\(/i,
    type: "scheduler", technology: "APScheduler", confidence: "high",
  },
];

// File-path patterns → component role (no content needed, Path B).
const WORKER_FILE_PATH_PATTERNS: Array<{
  pattern: RegExp;
  type: DiscoveredComponentType;
  nameHint: string;
}> = [
  {
    pattern: /(?:^|\/)workers?\.(?:ts|js|mjs|py|go|java|rb)$/i,
    type: "worker", nameHint: "worker",
  },
  {
    pattern: /(?:^|\/)consumer\.(?:ts|js|mjs|py|go)$/i,
    type: "worker", nameHint: "consumer",
  },
  {
    pattern: /(?:^|\/)processor\.(?:ts|js|mjs|py|go)$/i,
    type: "worker", nameHint: "processor",
  },
  {
    pattern: /(?:^|\/)jobs?\.(?:ts|js|mjs|py|go)$/i,
    type: "worker", nameHint: "job-runner",
  },
  {
    pattern: /(?:^|\/)(?:cron|scheduler)\.(?:ts|js|mjs|py|go)$/i,
    type: "scheduler", nameHint: "scheduler",
  },
];

/**
 * Scans all fetched key files for:
 *   B) Client instantiation patterns in source content
 *   C) Worker/scheduler role signals from file naming
 *
 * This is the critical pass for plain repos (no IaC) — a repo that just
 * has `redis.createClient(…)` in src/cache.ts and a worker.ts file will
 * produce a cache component and a worker component even with no docker-compose.
 */
function extractSourceCodeComponents(keyFiles: KeyFile[]): DiscoveredComponent[] {
  const components: DiscoveredComponent[] = [];
  // Deduplicate by (type, technology) for instantiation matches,
  // by (type, nameHint) for file-naming matches.
  const seenInstantiation = new Map<string, DiscoveredComponent>();
  const seenFileNaming = new Set<string>();

  for (const file of keyFiles) {
    // --- Pass C: file-naming (runs on ALL files, no content needed) ---
    for (const { pattern, type, nameHint } of WORKER_FILE_PATH_PATTERNS) {
      if (!pattern.test(file.path)) continue;
      const key = `${type}:${nameHint}`;
      if (seenFileNaming.has(key)) continue;
      seenFileNaming.add(key);
      components.push({
        id: `fn-${nameHint}`,
        name: nameHint,
        type,
        technology: "custom",
        evidence: [`${file.path} — filename indicates ${type} role`],
        confidence: "medium",
        source: "file-naming",
      });
    }

    // --- Pass B: content instantiation (source + config files only) ---
    if (!file.content) continue;
    // Run on source files; also run on manifests and container_ci because
    // docker-compose env-vars and serverless.yml handler paths sometimes
    // contain the instantiation patterns.
    if (
      file.kind !== "source" &&
      file.kind !== "manifest" &&
      file.kind !== "container_ci"
    ) continue;

    for (const { pattern, type, technology, confidence } of SOURCE_INSTANTIATION_PATTERNS) {
      const match = pattern.exec(file.content);
      if (!match) continue;
      const key = `${type}:${technology}`;
      const snippet = match[0].trim().slice(0, 80);
      const existing = seenInstantiation.get(key);
      if (existing) {
        // Accumulate evidence across multiple files (cap at 3 to avoid bloat)
        if (existing.evidence.length < 3) {
          existing.evidence.push(`${file.path} → ${snippet}`);
        }
      } else {
        const comp: DiscoveredComponent = {
          id: `sc-${technology.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: technology.toLowerCase(),
          type,
          technology,
          evidence: [`${file.path} → ${snippet}`],
          confidence,
          source: "source-code",
        };
        seenInstantiation.set(key, comp);
        components.push(comp);
      }
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Analyzes a set of RepoSignals and returns a structured ProjectProfile.
 * This runs deterministically — no network calls, no LLM.
 *
 * The resulting profile is what gets passed to both the rule engine and
 * the LLM prompt, replacing the raw file dump.
 */
export function analyzeProject(signals: RepoSignals): ProjectProfile {
  const languages: DetectedTech[] = [];
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const infrastructure: DetectedTech[] = [];
  const entryPoints: string[] = [];
  const awsUsage: DetectedTech[] = [];
  const deploymentHints: DetectedTech[] = [];

  // Track deduplication
  const seenLangs = new Set<string>();
  const seenFrameworks = new Set<string>();
  const seenDatabases = new Set<string>();
  const seenInfra = new Set<string>();
  const seenAwsUsage = new Set<string>();
  const seenHints = new Set<string>();

  const addUnique = <T extends DetectedTech>(arr: T[], item: T, seen: Set<string>) => {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      arr.push(item);
    }
  };

  // Consolidate keyFiles, manifests, and containerCi so multi-module manifests are never missed
  const allFiles: Array<{ path: string; content: string | null; kind?: string }> = [
    ...(signals.keyFiles || []),
  ];
  const seenPaths = new Set(allFiles.map((f) => f.path));

  for (const m of signals.manifests || []) {
    if (!seenPaths.has(m.path)) {
      seenPaths.add(m.path);
      allFiles.push({ path: m.path, content: m.content, kind: "manifest" });
    }
  }

  for (const c of signals.containerCi || []) {
    if (!seenPaths.has(c.path)) {
      seenPaths.add(c.path);
      allFiles.push({ path: c.path, content: c.content, kind: "containerCi" });
    }
  }

  // ── Pass 1: file-path signals (no content needed) ─────────────────────────

  for (const file of allFiles) {
    const fileName = file.path.split("/").pop() ?? file.path;

    // Language detection from manifest presence
    for (const { file: re, lang } of LANG_FROM_MANIFEST) {
      if (re.test(fileName) && !seenLangs.has(lang)) {
        seenLangs.add(lang);
        languages.push({ name: lang, evidence: file.path, confidence: "high" });
      }
    }

    // Infrastructure detection
    for (const sig of INFRA_FILE_SIGNALS) {
      if (sig.pattern.test(file.path) && !seenInfra.has(sig.label)) {
        seenInfra.add(sig.label);
        infrastructure.push({ name: sig.label, evidence: file.path, confidence: sig.confidence });
      }
    }

    // Deployment hints
    for (const sig of DEPLOYMENT_HINT_SIGNALS) {
      if (sig.pattern.test(file.path) && !seenHints.has(sig.label)) {
        seenHints.add(sig.label);
        deploymentHints.push({ name: sig.label, evidence: file.path, confidence: sig.confidence });
      }
    }

    // Entry-point detection
    for (const re of ENTRY_POINT_PATTERNS) {
      if (re.test(file.path)) {
        entryPoints.push(file.path);
        break;
      }
    }
  }

  // ── Pass 2: file-content signals (manifest parsing + SDK scan) ────────────

  const parseFailures: string[] = [];

  for (const file of allFiles) {
    if (!file.content) continue;
    const fileName = file.path.split("/").pop() ?? file.path;

    try {
      // package.json
      if (fileName === "package.json") {
        const result = analyzePackageJson(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // requirements.txt
      if (fileName === "requirements.txt") {
        const result = analyzeRequirementsTxt(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // pyproject.toml (Fix 6)
      if (fileName === "pyproject.toml") {
        const pkgs = parsePyprojectToml(file.content);
        const result = mapParsedPackages(pkgs, file.path, PYTHON_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // go.mod
      if (fileName === "go.mod") {
        const result = analyzeGoMod(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // Cargo.toml (Fix 6)
      if (/^cargo\.toml$/i.test(fileName)) {
        const pkgs = parseCargoToml(file.content);
        const result = mapParsedPackages(pkgs, file.path, CARGO_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // pom.xml (Fix 6)
      if (fileName === "pom.xml") {
        const pkgs = parsePomXml(file.content);
        const result = mapParsedPackages(pkgs, file.path, MAVEN_ARTIFACT_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // build.gradle / build.gradle.kts (Fix 6)
      if (/^build\.gradle(\.kts)?$/i.test(fileName)) {
        const pkgs = parseBuildGradle(file.content);
        const result = mapParsedPackages(pkgs, file.path, MAVEN_ARTIFACT_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // Gemfile (Fix 6)
      if (/^gemfile$/i.test(fileName)) {
        const pkgs = parseGemfile(file.content);
        const result = mapParsedPackages(pkgs, file.path, RUBY_GEM_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // composer.json (Fix 6)
      if (fileName === "composer.json") {
        const pkgs = parseComposerJson(file.content);
        const result = mapParsedPackages(pkgs, file.path, PHP_COMPOSER_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // schema.prisma (Prisma datasource provider names the engine)
      if (fileName === "schema.prisma") {
        const provider = file.content.match(/provider\s*=\s*"([^"]+)"/)?.[1]?.toLowerCase();
        if (provider === "postgresql" || provider === "postgres") {
          addUnique(databases, { name: "PostgreSQL", evidence: `${file.path} → datasource provider`, confidence: "high" }, seenDatabases);
        } else if (provider === "mysql") {
          addUnique(databases, { name: "MySQL", evidence: `${file.path} → datasource provider`, confidence: "high" }, seenDatabases);
        } else if (provider === "mongodb") {
          addUnique(databases, { name: "MongoDB", evidence: `${file.path} → datasource provider`, confidence: "high" }, seenDatabases);
        } else if (provider === "sqlserver") {
          addUnique(databases, { name: "SQL Server", evidence: `${file.path} → datasource provider`, confidence: "high" }, seenDatabases);
        }
        // sqlite/cockroachdb providers: no AWS mapping (SQLite never maps to RDS).
      }

      // mix.exs (Elixir)
      if (fileName === "mix.exs") {
        const pkgs = parseMixExs(file.content);
        const result = mapParsedPackages(pkgs, file.path, ELIXIR_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
        if (!seenLangs.has("Elixir")) {
          seenLangs.add("Elixir");
          languages.push({ name: "Elixir", evidence: file.path, confidence: "high" });
        }
      }

      // *.csproj (Fix 6)
      if (/\.csproj$/i.test(fileName)) {
        const pkgs = parseCsProj(file.content);
        const result = mapParsedPackages(pkgs, file.path, DOTNET_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }
    } catch (err) {
      console.warn(`[repoAnalyzer] Failed to parse manifest ${file.path}:`, err);
      parseFailures.push(file.path);
    }

    // Scan all files for AWS SDK import statements
    const sdkHits = scanContentForAwsUsage(file.content, file.path);
    for (const a of sdkHits) addUnique(awsUsage, a, seenAwsUsage);

    // Serverless.yml: scan for explicit AWS resources (provider: aws)
    if (fileName === "serverless.yml" || fileName === "serverless.yaml") {
      if (file.content.includes("provider:") && file.content.includes("aws")) {
        if (!seenInfra.has("Serverless Framework (AWS provider)")) {
          seenInfra.add("Serverless Framework (AWS provider)");
          infrastructure.push({
            name: "Serverless Framework (AWS provider)",
            evidence: `${file.path} → provider: aws`,
            confidence: "high",
          });
        }
      }
    }

    // template.yaml (SAM): look for Transform: AWS::Serverless
    if (fileName === "template.yaml") {
      if (file.content.includes("AWS::Serverless") || file.content.includes("Transform")) {
        if (!seenInfra.has("AWS SAM template")) {
          seenInfra.add("AWS SAM template");
          infrastructure.push({
            name: "AWS SAM template",
            evidence: `${file.path} → AWS::Serverless Transform`,
            confidence: "high",
          });
        }
      }
    }
  }

  // ── Pass A: IaC structural discovery (docker-compose, serverless.yml) ──────

  const discoveredRaw: DiscoveredComponent[] = [];

  for (const file of allFiles) {
    if (!file.content) continue;
    const fileName = file.path.split("/").pop() ?? file.path;

    if (/^docker-compose(\.[^.]+)?\.(yml|yaml)$/i.test(fileName)) {
      discoveredRaw.push(...extractDockerComposeComponents(file.content, file.path));
    }
    if (/^serverless(\.[^.]+)?\.(yml|yaml)$/i.test(fileName)) {
      discoveredRaw.push(...extractServerlessComponents(file.content, file.path));
    }
  }

  // ── Passes B+C: source-code instantiation + file-naming ─────────────────

  discoveredRaw.push(...extractSourceCodeComponents(allFiles as any));

  // Deduplicate discoveredComponents by id (first wins — IaC evidence is
  // stronger than source-code inference for the same logical component).
  const seenDiscoveredIds = new Set<string>();
  const discoveredComponents: DiscoveredComponent[] = [];
  for (const dc of discoveredRaw) {
    if (!seenDiscoveredIds.has(dc.id)) {
      seenDiscoveredIds.add(dc.id);
      discoveredComponents.push(dc);
    }
  }

  // ── Kubernetes Manifest Discovery ─────────────────────────────
  for (const file of allFiles) {
    const p = file.path.toLowerCase();
    const isK8sName = /(?:k8s|kubernetes|helm|deploy)\//.test(p) ||
                      /(?:ingress|deployment|service|k8s|kubernetes|statefulset|daemonset)\.ya?ml$/.test(p) ||
                      p.endsWith("chart.yaml");
    const hasK8sContent = Boolean(file.content &&
      file.content.includes("apiVersion:") &&
      (file.content.includes("kind: Deployment") || file.content.includes("kind: Ingress") || file.content.includes("kind: Service")));
    if (isK8sName || hasK8sContent) {
      if (!seenInfra.has("Kubernetes manifests")) {
        seenInfra.add("Kubernetes manifests");
        infrastructure.push({
          name: "Kubernetes manifests",
          evidence: `${file.path} → Kubernetes configuration`,
          confidence: "high",
        });
      }
    }
  }

  // ── Terraform Resource Discovery ─────────────────────────────
  const tfResources = extractTerraformResources(
    allFiles.filter((f): f is { path: string; content: string } => typeof f.content === "string")
  );
  for (const t of tfResources) {
    if (!seenInfra.has(t.name)) {
      seenInfra.add(t.name);
      infrastructure.push(t);
    }
  }
  const hasTfFiles = allFiles.some((f) => f.path.endsWith(".tf"));
  const isIacOnly =
    hasTfFiles &&
    languages.length === 0 &&
    frameworks.length === 0 &&
    entryPoints.length === 0;

  const isLibraryOrFramework = detectLibraryRepo(
    allFiles.filter((f): f is { path: string; content: string } => typeof f.content === "string"),
    entryPoints
  );

  // ── Workload Classification (Priority 4) ────────────────────
  const workloadClassification = classifyWorkload({
    languages,
    frameworks,
    databases,
    infrastructure,
    discoveredComponents,
    signals,
  });

  // ── Build Evidence Register (Priority 1) ────────────────────
  const evidenceRegister: EvidenceRecord[] = [];
  let evId = 1;
  const seenEvidence = new Set<string>();

  const registerEv = (
    kind: EvidenceRecord["kind"],
    sourcePath: string,
    technology: string | undefined,
    detail: string,
    confidence: "high" | "medium" | "low"
  ) => {
    const key = `${sourcePath}:${technology}:${detail}`;
    if (seenEvidence.has(key)) return;
    seenEvidence.add(key);
    evidenceRegister.push({
      id: `ev-${evId++}`,
      kind,
      sourcePath,
      technology,
      detail: detail.slice(0, 300),
      confidence,
    });
  };

  for (const l of languages) {
    registerEv("manifest", l.evidence, l.name, `Language/runtime detected: ${l.name}`, l.confidence);
  }
  for (const f of frameworks) {
    registerEv("manifest", f.evidence.split(" → ")[0] || "manifest", f.name, f.evidence, f.confidence);
  }
  for (const d of databases) {
    registerEv("manifest", d.evidence.split(" → ")[0] || "manifest", d.name, d.evidence, d.confidence);
  }
  for (const i of infrastructure) {
    registerEv("iac", i.evidence.split(" → ")[0] || "infra", i.name, i.evidence, i.confidence);
  }
  for (const h of deploymentHints) {
    registerEv("iac", h.evidence.split(" → ")[0] || "config", h.name, h.evidence, h.confidence);
  }
  for (const a of awsUsage) {
    registerEv("sdk", a.evidence.split(" → ")[0] || "code", a.name, a.evidence, a.confidence);
  }
  for (const s of signals.sdkEvidence) {
    registerEv("sdk", s.filePath || s.file, s.service, `SDK match: ${s.match}`, "high");
  }
  for (const c of discoveredComponents) {
    registerEv("iac", c.evidence[0] || "component", c.technology, `Component: ${c.name} (${c.technology}) [${c.type}]`, c.confidence);
  }
  const readmeFile = signals.keyFiles.find((f) => f.kind === "readme");
  if (readmeFile?.content) {
    const lines = readmeFile.content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10 || trimmed.length > 250) continue;
      if (/kafka|postgres|mysql|mongo|redis|s3|sqs|opensearch|keycloak|sagemaker|cnn|tensorflow|pytorch|docker/i.test(trimmed)) {
        registerEv("readme", readmeFile.path, "readme-evidence", trimmed, "medium");
      }
    }
  }

  // ── Build summary ──────────────────────────────────────────
  const summary = buildSummary({
    languages,
    frameworks,
    databases,
    infrastructure,
    entryPoints,
    awsUsage,
    deploymentHints,
    discoveredComponents,
    evidenceRegister,
    workloadClassification,
    repoName: signals.repoName,
  });

  return {
    languages,
    frameworks,
    databases,
    infrastructure,
    entryPoints,
    awsUsage,
    deploymentHints,
    parseFailures,
    isIacOnly,
    isLibraryOrFramework,
    discoveredComponents,
    evidenceRegister,
    workloadClassification,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Workload classifier implementation (Priority 4)
// ---------------------------------------------------------------------------

export function classifyWorkload(
  dataOrSignals:
    | {
        languages?: DetectedTech[];
        frameworks?: DetectedTech[];
        databases?: DetectedTech[];
        infrastructure?: DetectedTech[];
        discoveredComponents?: DiscoveredComponent[];
        signals: RepoSignals;
        description?: string;
      }
    | RepoSignals,
  description?: string
): WorkloadClassification {
  const isSignals = "manifests" in dataOrSignals || "fileTree" in dataOrSignals || "keyFiles" in dataOrSignals;
  const signals: RepoSignals = isSignals ? (dataOrSignals as RepoSignals) : (dataOrSignals as any).signals;
  const languages: DetectedTech[] = isSignals ? [] : ((dataOrSignals as any).languages ?? []);
  const frameworks: DetectedTech[] = isSignals ? [] : ((dataOrSignals as any).frameworks ?? []);
  const databases: DetectedTech[] = isSignals ? [] : ((dataOrSignals as any).databases ?? []);
  const infrastructure: DetectedTech[] = isSignals ? [] : ((dataOrSignals as any).infrastructure ?? []);
  const discoveredComponents: DiscoveredComponent[] = isSignals ? [] : ((dataOrSignals as any).discoveredComponents ?? []);
  const desc = (description ?? (isSignals ? "" : (dataOrSignals as any).description) ?? "").toLowerCase();

  const reasons: string[] = [];
  const allTech = [
    ...languages.map((l) => l.name),
    ...frameworks.map((f) => f.name),
    ...databases.map((d) => d.name),
    ...infrastructure.map((i) => i.name),
    ...discoveredComponents.map((c) => `${c.name} ${c.technology} ${c.type}`),
    ...(signals.keyFiles || []).map((f) => f.path + " " + (f.content || "")),
    ...(signals.manifests || []).map((m) => m.path + " " + m.content),
    ...(signals.containerCi || []).map((c) => c.path + " " + c.content),
    ...(signals.fileTree || []),
    desc,
  ].join(" ").toLowerCase();

  const readme = (
    signals.keyFiles?.find((f) => f.kind === "readme")?.content ??
    signals.githubReadme ??
    desc
  ).toLowerCase();

  const makeResult = (primaryWorkload: WorkloadType, confidence: "high" | "medium" | "low", r: string[]): WorkloadClassification => ({
    primaryWorkload,
    type: primaryWorkload,
    confidence,
    reasons: r,
  });

  // 1. ML Training vs ML Inference
  const hasMlLib = /tensorflow|keras|pytorch|torch|scikit-learn|\bcnn\b|plantvillage|onnx|transformers|huggingface/.test(allTech) ||
                   /cnn|convolutional|plantvillage|dataset from kaggle|model\.fit|train\.py/.test(readme);
  const hasWebServer = /express|fastapi|flask|django|spring boot|rails|next\.js|nuxt|nestjs|\bgin\b|\becho\b|\bfiber\b|bentoml|triton|asp\.net|aspnet|webapi|dotnet|laravel|symfony|actix|axum|rocket/.test(allTech);
  const hasTrainingScript = /train\.py|single training script|training job|epochs|batch_size|model\.fit\(/.test(readme) ||
                            (signals.keyFiles || []).some((f) => /(?:train|model_training)\.py/i.test(f.path)) ||
                            (signals.fileTree || []).some((f) => /(?:train|model_training)\.py/i.test(f));
  const hasInferenceServing = /inference|prediction|predict|serve|endpoint|bentoml|triton|torchserve/.test(allTech) ||
                              /inference|prediction|predict|serve model|model serving|endpoint/.test(readme) ||
                              (signals.keyFiles || []).some((f) => /(?:predict|infer|serve)\.py/i.test(f.path)) ||
                              (signals.fileTree || []).some((f) => /(?:predict|infer|serve)\.py/i.test(f));

  if (hasMlLib) {
    if (hasWebServer && (hasInferenceServing || !hasTrainingScript)) {
      reasons.push("Machine learning model serving / inference API detected");
      return makeResult("ml-inference", "high", reasons);
    }
    reasons.push("Machine learning framework / training code detected without full-stack web service");
    return makeResult("ml-training", "high", reasons);
  }

  // 2. Microservices
  const hasK8s = /kubernetes|\bk8s\b|\bhelm\b/.test(allTech);
  const multiModulePom =
    (signals.keyFiles || []).filter((f) => f.path.endsWith("pom.xml")).length > 1 ||
    (signals.manifests || []).filter((m) => m.path.endsWith("pom.xml")).length > 1 ||
    (signals.fileTree || []).filter((f) => f.endsWith("pom.xml")).length > 1;
  const multiBackendComponents = discoveredComponents.filter((c) => c.type === "backend" || c.type === "api").length >= 2;
  const hasDiscoveryOrGateway =
    /eureka|spring cloud config|consul|service mesh|istio|linkerd/.test(allTech) ||
    /eureka|spring cloud config|consul|service mesh|istio/.test(readme) ||
    (/(?:spring cloud|kong|zuul|ambassador)\s+gateway/i.test(allTech) || /(?:spring cloud|kong|zuul|ambassador)\s+gateway/i.test(readme));
  const hasMultiServicesInCompose = /services:\s*\n\s+([a-zA-Z0-9_-]+):[\s\S]+?\n\s+([a-zA-Z0-9_-]+):/.test(allTech);

  if (hasK8s || (multiModulePom && (multiBackendComponents || hasDiscoveryOrGateway)) || (multiModulePom && hasMultiServicesInCompose) || hasDiscoveryOrGateway || /micro-?services?/.test(allTech) || /micro-?services?/.test(readme)) {
    reasons.push(hasK8s ? "Kubernetes orchestration manifests present" : "Multi-module microservice architecture with service discovery/gateway");
    return makeResult("microservices", "high", reasons);
  }

  // 3. Static Frontend
  const hasStaticSiteGen = /gatsby|hugo|jekyll|astro/.test(allTech);
  const hasFrontendLib = frameworks.some((f) => /react|vue|svelte|vite/.test(f.name.toLowerCase())) || /react|vue|svelte|vite/.test(allTech);
  if ((hasStaticSiteGen || hasFrontendLib) && !hasWebServer && databases.length === 0) {
    reasons.push("Static frontend / client SPA without server backend");
    return makeResult("static-frontend", "high", reasons);
  }

  // 4. Web Application
  const isNext = /next\.js/.test(allTech);
  const isMvxFramework = /rails|laravel|django/.test(allTech) && !/api only|headless|backend api|pure api/.test(readme);
  const isWebPortal = /web application|web portal|full-stack/.test(readme);
  if (isNext || (hasFrontendLib && hasWebServer) || isMvxFramework || (hasWebServer && isWebPortal)) {
    reasons.push(isNext ? "Full-stack Next.js web application" : "Web application with frontend or server-rendered UI");
    return makeResult("web-application", "high", reasons);
  }

  // 5. API
  const hasServerlessApi = discoveredComponents.some((c) => c.type === "api") || (/serverless|sam|lambda/.test(allTech) && /http:|apigateway|api gateway/.test(allTech));
  if ((hasWebServer || hasServerlessApi) && !hasFrontendLib) {
    reasons.push(hasServerlessApi ? "Serverless event-driven API" : "Backend API service without frontend UI");
    return makeResult("api", "high", reasons);
  }

  // 6. Worker / Batch
  if (/celery|bull|batch|cron|worker/.test(allTech) && !hasWebServer) {
    reasons.push("Background worker or batch processing");
    return makeResult("worker", "medium", reasons);
  }

  // 7. Admin / Monitoring Tooling
  const hasMonitoringTool = /prometheus|grafana|alertmanager|node-exporter|jaeger|zipkin|kibana/.test(allTech);
  if (hasMonitoringTool && !hasWebServer && (discoveredComponents.length === 0 || discoveredComponents.every((c) => c.type === "other"))) {
    reasons.push("Infrastructure monitoring and observability tooling stack");
    return makeResult("admin-monitoring-tool", "high", reasons);
  }

  return makeResult("generic", "low", ["Standard generic application profile"]);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  data: Omit<ProjectProfile, "summary" | "parseFailures"> & { repoName: string }
): string {
  const lines: string[] = [`Repository: ${data.repoName}`, ""];
  lines.push("DETECTED TECHNOLOGIES (extracted from repository files before inference):");
  lines.push("");

  if (data.workloadClassification) {
    lines.push(`WORKLOAD CLASSIFICATION: ${data.workloadClassification.primaryWorkload} (${data.workloadClassification.confidence} confidence)`);
    for (const r of data.workloadClassification.reasons) {
      lines.push(`  - ${r}`);
    }
    lines.push("");
  }

  if (data.languages.length > 0) {
    lines.push(
      `Languages/Runtime: ${data.languages.map((l) => `${l.name} [${l.evidence}]`).join(", ")}`
    );
  }
  if (data.frameworks.length > 0) {
    lines.push("Frameworks/Libraries:");
    for (const f of data.frameworks) {
      lines.push(`  - ${f.name}  [evidence: ${f.evidence}]`);
    }
  }
  if (data.databases.length > 0) {
    lines.push("Databases:");
    for (const d of data.databases) {
      lines.push(`  - ${d.name}  [evidence: ${d.evidence}]`);
    }
  }
  if (data.infrastructure.length > 0) {
    lines.push("Infrastructure/DevOps:");
    for (const i of data.infrastructure) {
      lines.push(`  - ${i.name}  [evidence: ${i.evidence}]`);
    }
  }
  if (data.deploymentHints.length > 0) {
    lines.push("Deployment Hints:");
    for (const h of data.deploymentHints) {
      lines.push(`  - ${h.name}  [evidence: ${h.evidence}]`);
    }
  }
  if (data.awsUsage.length > 0) {
    lines.push("Explicit AWS SDK Usage:");
    for (const a of data.awsUsage) {
      lines.push(`  - ${a.name}  [evidence: ${a.evidence}]`);
    }
  } else {
    lines.push("Explicit AWS SDK Usage: none detected");
  }
  if (data.entryPoints.length > 0) {
    lines.push(`Entry Points: ${data.entryPoints.join(", ")}`);
  }

  // Discovered components (distinct deployable units found in IaC / source)
  if (data.discoveredComponents.length > 0) {
    lines.push("");
    lines.push("DISCOVERED DEPLOYABLE COMPONENTS:");
    for (const dc of data.discoveredComponents) {
      const evidenceSummary = dc.evidence.slice(0, 2).join("; ");
      lines.push(
        `  - [${dc.type}] ${dc.name} (${dc.technology}) — ${dc.confidence} confidence` +
          (evidenceSummary ? ` [${evidenceSummary}]` : "")
      );
    }
    lines.push(
      "Each component above represents a SEPARATE deployable unit. " +
        "Map each one to its own AWS service — do NOT collapse them."
    );
  }

  if (data.evidenceRegister && data.evidenceRegister.length > 0) {
    lines.push("");
    lines.push("EVIDENCE INVENTORY (registered evidence from repository files):");
    for (const ev of data.evidenceRegister) {
      lines.push(`  [${ev.id}] (${ev.kind}: ${ev.sourcePath}) ${ev.technology ? `[${ev.technology}] ` : ""}${ev.detail}`);
    }
    lines.push("");
    lines.push("CRITICAL EVIDENCE RULE: Every component in the architecture model MUST cite one or more valid Evidence IDs (e.g. ['ev-1']) from the EVIDENCE INVENTORY above. Do not invent evidence.");
  }

  lines.push("");
  lines.push(
    "This structured analysis is the evidence base for building the application's " +
      "architecture model. Use only the technologies above; do not invent technologies " +
      "absent from this analysis."
  );

  return lines.join("\n");
}
