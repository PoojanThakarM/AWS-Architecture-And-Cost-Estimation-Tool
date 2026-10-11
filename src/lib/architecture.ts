/**
 * architecture.ts  —  Architecture Model + Deterministic AWS Mapping
 *
 * Pipeline:
 *   RepoSignals / description → LLM → ArchitectureModel
 *     → validateArchitectureModel() → mapArchitectureModelToServicePlan()
 *     → ServicePlan → diagram.ts + cost.ts
 *
 * The LLM describes the APPLICATION, not AWS: components use real tech names
 * ("PostgreSQL", "Express"), and AWS service selection happens deterministically
 * in mapArchitectureModelToServicePlan() using a lookup table — patterns only
 * used as sanity-check labels, never to constrain component count.
 */

import { z } from "zod";
import {
  SERVICE_IDS,
  SERVICE_CATEGORIES,
  COMPONENT_TYPES,
  DiscoveredComponentSchema,
  ComponentRelationshipSchema,
  DeploymentModelSchema,
  AwsServiceMappingSchema,
  ServicePlanSchema,
  pushDiagnostic,
  type DiagnosticSink,
  type ServiceId,
  type ComponentType,
  type ConfidenceTier,
  type Grounding,
  type ServicePlan,
  type DiscoveredComponent,
  type ComponentRelationship,
  type DeploymentModel,
  type AwsServiceMapping,
  type MappingCategory,
  type EvidenceRecord,
} from "./schema.ts";
import type { WorkloadClassification } from "./repoAnalyzer.ts";
import { serviceTypeFromId } from "./ruleEngine.ts";

// ---------------------------------------------------------------------------
// Architecture Model schema (LLM output)
// ---------------------------------------------------------------------------

export const ArchitectureComponentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  type: z.enum(COMPONENT_TYPES),
  technology: z.string().min(1).max(80),
  details: z.string().max(200).optional(),
  evidence: z.array(z.string().max(200)).max(5).optional().default([]),
  confidence: z.enum(["high", "medium", "low"]).optional().default("medium"),
});
export type ArchitectureComponent = z.infer<typeof ArchitectureComponentSchema>;

export const ArchitectureRelationshipSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  type: z.string().max(40).optional(),
});
export type ArchitectureRelationship = z.infer<typeof ArchitectureRelationshipSchema>;

export const PATTERN_IDS = [
  "static-site", "serverless-api", "containerised-app", "event-driven",
  "ml-pipeline", "full-stack-web", "data-pipeline", "generic",
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export const ArchitectureModelSchema = z.object({
  appType: z.enum(PATTERN_IDS).default("full-stack-web"),
  appName: z.string().max(120).default("Cloud Application"),
  description: z.string().max(1000).default(""),
  components: z.array(ArchitectureComponentSchema).min(1),
  languages: z.array(z.string().max(60)).default([]),
  frameworks: z.array(z.string().max(60)).default([]),
  databases: z.array(z.string().max(60)).default([]),
  apis: z.array(z.string().max(100)).default([]),
  externalServices: z.array(z.string().max(100)).default([]),
  dependencies: z.array(z.string().max(100)).default([]),
  buildConfig: z.array(z.string().max(100)).default([]),
  relationships: z.array(ArchitectureRelationshipSchema).default([]),
});
export type ArchitectureModel = z.infer<typeof ArchitectureModelSchema>;

// ---------------------------------------------------------------------------
// Normalization + validation
// ---------------------------------------------------------------------------

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}

/**
 * Enforces semantic compatibility between component technologies and AWS services.
 * Rejects architecturally incompatible mappings (e.g. Kafka → SQS, OpenSearch → SageMaker, Keycloak → SecretsManager).
 */
export function isMappingCompatible(technology: string, serviceId: ServiceId): boolean {
  const t = technology.toLowerCase();

  // 1. Kafka / Confluent event streaming must NEVER map to SQS, Kinesis, SNS
  if (/kafka|confluent/.test(t)) {
    if (serviceId === "SQS" || serviceId === "Kinesis" || serviceId === "SNS") return false;
  }

  // 2. OpenSearch / Elasticsearch must NEVER map to SageMaker, RDS, DynamoDB, DocumentDB
  if (/opensearch|elasticsearch/.test(t)) {
    if (serviceId === "SageMaker" || serviceId === "RDS" || serviceId === "DynamoDB" || serviceId === "DocumentDB") return false;
  }

  // 3. Keycloak / Identity providers must NEVER map to SecretsManager or KMS
  if (/keycloak|auth0|okta|cognito/.test(t)) {
    if (serviceId === "SecretsManager" || (serviceId as string) === "KMS") return false;
  }

  // 4. Relational databases must NEVER map to DynamoDB or DocumentDB
  if (/postgres|mysql|mariadb|sqlite|sql server|oracle/.test(t)) {
    if (serviceId === "DynamoDB" || serviceId === "DocumentDB") return false;
  }

  // 5. MongoDB must NEVER map to RDS, Aurora, DynamoDB
  if (/mongo|mongodb/.test(t)) {
    if (serviceId === "RDS" || serviceId === "Aurora" || serviceId === "DynamoDB") return false;
  }

  // 6. Redis / In-memory caches must NEVER map to RDS, Aurora, DynamoDB, S3
  if (/redis|memcached|valkey/.test(t)) {
    if (serviceId === "RDS" || serviceId === "Aurora" || serviceId === "DynamoDB" || serviceId === "S3") return false;
  }

  // 7. Kubernetes / Helm manifests must NOT map to Lambda or Lightsail
  if (/kubernetes|k8s/.test(t) || /\bhelm\b/.test(t)) {
    if (serviceId === "Lambda" || serviceId === "Lightsail") return false;
  }

  // 8. ML training scripts / CNN / PyTorch model must NOT map to Lambda or static S3
  if (/\bcnn\b|training|pytorch|tensorflow|keras/.test(t)) {
    if (serviceId === "Lambda") return false;
  }

  // 9. Admin tools (pgAdmin, MailDev, Grafana) must NOT map to S3+CloudFront static hosting
  if (/pgadmin|maildev|grafana|kibana|dashboard/.test(t)) {
    if (serviceId === "S3" || serviceId === "CloudFront") return false;
  }

  // 10. Web / backend frameworks must NOT map directly to APIGateway without serverless / lambda / api gateway context
  if (/\b(?:express|fastapi|flask|spring|django|rails|laravel|gin|axum|actix|aspnet|nest(?:\.js)?)\b/i.test(t)) {
    if (serviceId === "APIGateway" && !/lambda|serverless|sam|apigateway|api gateway|httpapi/.test(t)) {
      return false;
    }
  }

  return true;
}

/**
 * Verifies that a cited EvidenceRecord genuinely supports the claimed component technology and type.
 * Prevents LLMs from citing irrelevant real files (e.g. citing pom.xml with only Spring Web to claim Lambda or DynamoDB).
 */
export function isEvidenceSupportingComponent(
  record: EvidenceRecord,
  compTech: string,
  compType: ComponentType
): boolean {
  const recTech = (record.technology || "").toLowerCase();
  const recDetail = record.detail.toLowerCase();
  const recPath = record.sourcePath.toLowerCase();
  const t = compTech.toLowerCase();

  // If the record explicitly mentions the tech:
  if (recTech && (recTech.includes(t) || t.includes(recTech))) return true;
  if (recDetail.includes(t)) return true;

  // Type-based and semantic capability checks:
  // Container: Dockerfile, docker-compose, Jib supports Docker, container, backend, microservices, ECS
  if (recPath.includes("dockerfile") || recDetail.includes("jib") || recDetail.includes("docker") || recTech === "docker") {
    if (/docker|container|fargate|ecs|backend|api|worker|service|microservice/.test(t) || compType === "worker") {
      if (/lambda|serverless/.test(t)) return false;
      return true;
    }
  }

  // Kubernetes manifests support Kubernetes, EKS, backend, api
  if (recPath.includes("k8s") || recPath.includes("helm") || recDetail.includes("kubernetes") || recTech === "kubernetes") {
    if (/kubernetes|k8s|eks|helm|backend|api|service/.test(t) || compType === "backend" || compType === "api") {
      return true;
    }
  }

  // Kafka / messaging
  if (recDetail.includes("kafka") || recTech.includes("kafka")) {
    if (/kafka|messaging|streaming|event/.test(t) || compType === "messaging" || compType === "queue") {
      return true;
    }
  }

  // OpenSearch / Elasticsearch
  if (recDetail.includes("opensearch") || recDetail.includes("elasticsearch") || recTech.includes("opensearch")) {
    if (/opensearch|elasticsearch|search/.test(t) || compType === "search") {
      return true;
    }
  }

  // Relational DB (Postgres, MySQL, MariaDB, SQLite)
  if (
    recDetail.includes("postgres") ||
    recDetail.includes("mysql") ||
    recDetail.includes("mariadb") ||
    recDetail.includes("jpa") ||
    recDetail.includes("hibernate") ||
    recDetail.includes("r2dbc") ||
    recDetail.includes("jdbc") ||
    recTech.includes("postgres") ||
    recTech.includes("mysql")
  ) {
    if (/postgres|mysql|mariadb|sqlite|sql|database|relational|rds|aurora/.test(t) || compType === "database") {
      if (/dynamo|mongo/.test(t)) return false;
      return true;
    }
  }

  // MongoDB
  if (recDetail.includes("mongo") || recTech.includes("mongo")) {
    if (/mongo|documentdb|nosql/.test(t) || compType === "database") {
      return true;
    }
  }

  // Redis / Cache
  if (recDetail.includes("redis") || recDetail.includes("memcached") || recTech.includes("redis")) {
    if (/redis|memcached|cache|elasticache/.test(t) || compType === "cache") {
      return true;
    }
  }

  // Keycloak / Auth
  if (recDetail.includes("keycloak") || recDetail.includes("security") || recDetail.includes("oauth") || recTech.includes("keycloak")) {
    if (/keycloak|auth|oauth|security|cognito|identity/.test(t) || compType === "auth") {
      return true;
    }
  }

  // Web framework record supports a component only when tech names same family
  if (
    recDetail.includes("spring-boot") ||
    recDetail.includes("spring-web") ||
    recDetail.includes("express") ||
    recDetail.includes("fastapi") ||
    recDetail.includes("django") ||
    recDetail.includes("flask") ||
    recDetail.includes("next") ||
    recDetail.includes("react") ||
    recDetail.includes("vue")
  ) {
    const family = ["spring", "express", "fastapi", "django", "flask", "next", "react", "vue", "node", "backend", "api", "frontend", "service"];
    if (family.some((f) => t.includes(f))) {
      if (/lambda|serverless/.test(t) && !recDetail.includes("lambda") && !recDetail.includes("serverless")) {
        return false;
      }
      return true;
    }
    return false;
  }

  // Machine Learning
  if (
    recDetail.includes("tensorflow") ||
    recDetail.includes("pytorch") ||
    recDetail.includes("keras") ||
    recDetail.includes("sagemaker") ||
    recDetail.includes("cnn") ||
    recTech.includes("pytorch") ||
    recTech.includes("tensorflow")
  ) {
    if (/ml|training|pytorch|tensorflow|keras|sagemaker|model|cnn/.test(t)) {
      return true;
    }
  }

  // S3 / object storage / file upload
  if (recDetail.includes("s3") || recDetail.includes("upload") || recDetail.includes("multer") || recDetail.includes("fileupload")) {
    if (/s3|storage|upload|bucket/.test(t) || compType === "object-storage") {
      return true;
    }
  }

  // Mail / SES
  if (recDetail.includes("mail") || recDetail.includes("ses") || recDetail.includes("nodemailer") || recDetail.includes("smtp")) {
    if (/mail|email|ses|smtp|notification/.test(t)) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizes a parsed architecture model.
 *
 * Drops any component with an empty `evidence` array. If an `evidenceRegister` is
 * provided, drops any citations that do not correspond to authentic evidence records,
 * and drops any component whose evidence does not support its claimed technology.
 */
/**
 * True when a free-text technology name from the model's summary lists
 * (databases, frameworks, dependencies…) appears in the evidence corpus.
 * Those lists feed `mapListTechnologies`, which adds AWS services — so an
 * uncorroborated "DynamoDB" in `databases` used to add DynamoDB to the plan
 * with no evidence check at all.
 */
export function isListEntryCorroborated(entry: string, corpus: string): boolean {
  const e = entry
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\.js\b/g, "")
    .replace(/\b(orm|database|db|framework|library|sdk|driver|client)\b/g, " ")
    .trim();
  if (!e) return false;
  if (corpus.includes(e)) return true;
  const tokens = e.split(/[^a-z0-9+#]+/).filter((t) => t.length >= 3);
  return tokens.length > 0 && tokens.some((t) => corpus.includes(t));
}

export function normalizeArchitectureModel(
  model: ArchitectureModel,
  evidenceRegister?: EvidenceRecord[],
  /** Extra corroboration text (the user's description on the description path). */
  extraCorpus?: string
): ArchitectureModel {
  const seenIds = new Set<string>();
  const register = evidenceRegister && evidenceRegister.length > 0 ? evidenceRegister : null;
  const corpus = [
    ...(register ?? []).map((r) => `${r.technology ?? ""} ${r.detail} ${r.sourcePath}`),
    extraCorpus ?? "",
  ]
    .join("\n")
    .toLowerCase();
  const gateList = (arr: string[]) =>
    corpus.trim().length === 0 ? arr : arr.filter((x) => isListEntryCorroborated(x, corpus));

  const components = model.components.reduce<ArchitectureComponent[]>((acc, c) => {
    if (seenIds.has(c.id)) return acc;

    let evidence = c.evidence.map((e) => e.trim()).filter((e) => e.length > 0);

    if (register) {
      evidence = evidence.filter((evStr) => {
        const clean = evStr.trim().toLowerCase();

        // 1. Direct ID match (e.g. "ev-1", "ev-12")
        const matchById = register.find((r) => r.id.toLowerCase() === clean);
        if (matchById) {
          return isEvidenceSupportingComponent(matchById, c.technology, c.type);
        }

        // 2. Match by sourcePath, technology, or detail
        const matchByContent = register.find((r) => {
          const src = r.sourcePath.toLowerCase();
          const tech = (r.technology || "").toLowerCase();
          const detail = r.detail.toLowerCase();
          return (
            clean === src ||
            clean.includes(src) ||
            src.includes(clean) ||
            (tech && (clean.includes(tech) || tech.includes(clean))) ||
            (detail && clean.includes(detail))
          );
        });

        if (matchByContent) {
          return isEvidenceSupportingComponent(matchByContent, c.technology, c.type);
        }

        return false;
      });
    } else if (extraCorpus && extraCorpus.trim().length > 0) {
      // Description path: there is no evidence register, so a citation is
      // accepted only if the phrase it quotes really is in the description,
      // or the component's technology is named there.
      const techNamed =
        isListEntryCorroborated(c.technology, corpus) || isListEntryCorroborated(c.name, corpus);
      evidence = evidence.filter((evStr) => {
        const quoted = [...evStr.matchAll(/['"‘’“”]([^'"‘’“”]{3,})['"‘’“”]/g)].map((m) => m[1].toLowerCase().trim());
        if (quoted.length > 0) return quoted.some((q) => corpus.includes(q)) || techNamed;
        return techNamed;
      });
    }

    if (evidence.length === 0) return acc;
    seenIds.add(c.id);
    acc.push({ ...c, evidence });
    return acc;
  }, []);

  const ids = seenIds;

  return {
    ...model,
    appName: model.appName.trim(),
    description: model.description.trim(),
    components,
    languages: gateList(dedupeStrings(model.languages)),
    frameworks: gateList(dedupeStrings(model.frameworks)),
    databases: gateList(dedupeStrings(model.databases)),
    apis: dedupeStrings(model.apis),
    externalServices: dedupeStrings(model.externalServices),
    dependencies: gateList(dedupeStrings(model.dependencies)),
    buildConfig: gateList(dedupeStrings(model.buildConfig)),
    relationships: model.relationships.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

/**
 * Why an LLM answer was rejected.
 *   "schema"       — the object did not match ArchitectureModelSchema.
 *   "no-evidence"  — it parsed, but every component was dropped for citing
 *                    evidence that does not exist in the register.
 */
export type ArchitectureValidationReason = "schema" | "no-evidence";

export interface ArchitectureValidationFailure {
  model: null;
  reason: ArchitectureValidationReason;
  /** Human-readable specifics: zod issues, or the count of dropped components. */
  detail: string;
}

export type ArchitectureValidationResult =
  | { model: ArchitectureModel; reason: null; detail: null }
  | ArchitectureValidationFailure;

/**
 * Validates and normalizes a raw LLM answer.
 *
 * Returns a result object rather than `ArchitectureModel | null`: the two
 * failure modes need different handling upstream and were previously
 * indistinguishable at the call site, visible only as a console.warn.
 */
export function validateArchitectureModel(
  raw: unknown,
  evidenceRegister?: EvidenceRecord[],
  extraCorpus?: string
): ArchitectureValidationResult {
  const result = ArchitectureModelSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    console.warn("[architecture] LLM architecture model failed validation:", detail);
    return { model: null, reason: "schema", detail };
  }

  const rawComponentCount = result.data.components.length;
  const model = normalizeArchitectureModel(result.data, evidenceRegister, extraCorpus);
  if (model.components.length === 0) {
    const detail =
      `all ${rawComponentCount} component(s) were dropped: none cited evidence ` +
      `present in the evidence register (${evidenceRegister?.length ?? 0} record(s))`;
    console.warn(
      "[architecture] every LLM component lacked evidence — discarding model, falling back to rules"
    );
    return { model: null, reason: "no-evidence", detail };
  }

  return { model, reason: null, detail: null };
}

// ---------------------------------------------------------------------------
// Deterministic AWS service mapping (based ONLY on the architecture model)
// Pattern lookup table — used as SANITY CHECK only, never to constrain components
// ---------------------------------------------------------------------------

const COMPUTE_SERVICES: ServiceId[] = ["Lambda", "EC2", "ECS", "EKS", "Fargate", "Batch", "Lightsail", "SageMaker"];

// Pattern → expected services lookup (for UI label only)
const PATTERN_SERVICE_LOOKUP: Record<PatternId, ServiceId[]> = {
  "static-site": ["S3", "CloudFront", "Route53"],
  "serverless-api": ["Lambda", "APIGateway", "DynamoDB", "SQS", "SNS", "Cognito"],
  "containerised-app": ["ECS", "ECR", "ALB", "RDS", "ElastiCache", "S3"],
  "event-driven": ["Lambda", "SQS", "SNS", "EventBridge", "DynamoDB", "RDS", "MSK"],
  "ml-pipeline": ["SageMaker", "S3", "Lambda", "ECS"],
  "full-stack-web": ["CloudFront", "ALB", "ECS", "RDS", "ElastiCache", "S3", "Cognito"],
  "data-pipeline": ["Kinesis", "S3", "Lambda", "Redshift"],
  "generic": [],
};

// Component type + technology → AWS service mapping
function mapComponentToAws(
  c: ArchitectureComponent,
  context?: { workloadClassification?: WorkloadClassification }
): AwsServiceMapping[] {
  const tech = `${c.name} ${c.technology} ${c.details ?? ""}`.toLowerCase();
  const ev = `component ${c.name} (${c.technology})`;
  const mappings: AwsServiceMapping[] = [];

  switch (c.type) {
    case "database":
      if (/dynamo/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "DynamoDB", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/mongo/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "DocumentDB", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/redis|memcached|valkey/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "ElastiCache", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/aurora/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Aurora", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/postgres|postgresql/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "RDS", confidence: "high", evidence: `${ev} → RDS (PostgreSQL)`, fromPattern: false, category: "repository-evidence" });
      } else if (/mysql|mariadb/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "RDS", confidence: "high", evidence: `${ev} → RDS (MySQL)`, fromPattern: false, category: "repository-evidence" });
      } else if (/sql\s?server|mssql/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "RDS", confidence: "high", evidence: `${ev} → RDS (SQL Server)`, fromPattern: false, category: "repository-evidence" });
      } else if (/cassandra|scylla/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Keyspaces", confidence: "medium", evidence: `${ev} → Amazon Keyspaces (Cassandra-compatible)`, fromPattern: false, category: "inference" });
      } else if (/neo4j|gremlin|graph\s?db|graph database/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Neptune", confidence: "medium", evidence: `${ev} → Amazon Neptune (graph)`, fromPattern: false, category: "inference" });
      } else if (/sqlite|firebase|firestore|supabase|planetscale|neon\b|atlas/.test(tech)) {
        // Embedded (SQLite lives on the compute host's disk) or an external
        // managed service — not an AWS database to provision. Mapping these
        // to RDS invented a database server the project does not use.
      } else {
        // Unknown engine: a relational store is a reasonable guess, but it is
        // a guess — never "high".
        mappings.push({ componentId: c.id, serviceId: "RDS", confidence: "low", evidence: `${ev} (database engine not identified — RDS assumed)`, fromPattern: false, category: "inference" });
      }
      break;

    case "cache":
      mappings.push({ componentId: c.id, serviceId: "ElastiCache", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      break;

    case "queue":
    case "messaging":
      if (/kafka|confluent/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "MSK", confidence: "high", evidence: `${ev} → Amazon MSK (Managed Streaming for Kafka)`, fromPattern: false, category: "repository-evidence" });
      } else if (/kinesis/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Kinesis", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/sns|notification/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "SNS", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/eventbridge|event.bus/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "EventBridge", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/rabbit|activemq|amqp/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "MQ", confidence: "high", evidence: `${ev} → Amazon MQ (RabbitMQ/ActiveMQ-compatible)`, fromPattern: false, category: "repository-evidence" });
      } else {
        mappings.push({ componentId: c.id, serviceId: "SQS", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      }
      break;

    case "object-storage":
      mappings.push({ componentId: c.id, serviceId: "S3", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      break;

    case "search":
      mappings.push({ componentId: c.id, serviceId: "OpenSearch", confidence: "high", evidence: `${ev} → Amazon OpenSearch Service`, fromPattern: false, category: "repository-evidence" });
      break;

    case "auth":
      if (/cognito/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Cognito", confidence: "high", evidence: `${ev} → Amazon Cognito`, fromPattern: false, category: "repository-evidence" });
      } else if (/keycloak|oauth|openid|oidc|identity provider|sso/.test(tech)) {
        // A self-hosted IdP replaced by a managed one: a recommendation, not evidence.
        mappings.push({ componentId: c.id, serviceId: "Cognito", confidence: "medium", evidence: `${ev} → Amazon Cognito as managed identity provider (alternative: keep the existing IdP on compute)`, fromPattern: false, category: "recommendation" });
      } else if (/auth0|okta|clerk|firebase/.test(tech)) {
        // External SaaS identity: stays external, nothing to provision on AWS.
      } else if (/secrets|vault|credentials|\bkms\b/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "SecretsManager", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else {
        // In-app auth (JWT, sessions, passport, bcrypt) runs inside the app's
        // own compute. Cognito is an option, not a requirement.
        mappings.push({ componentId: c.id, serviceId: "Cognito", confidence: "low", evidence: `${ev} (in-app authentication detected; Cognito is optional — keeping auth in the application is equally valid)`, fromPattern: false, category: "recommendation" });
      }
      break;

    case "frontend":
      if (/next|nuxt|remix|svelte\s?kit/.test(tech) && !/static\s+export|output:\s*['"]?export|\bssg\b|static site/.test(tech)) {
        // Server-rendered meta-framework: needs a running Node.js process.
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "medium", evidence: `${ev} → server-side rendering needs a Node.js host (alternatives: Amplify Hosting, App Runner)`, fromPattern: false, category: "inference" },
          { componentId: `${c.id}-alb`, serviceId: "ALB", confidence: "medium", evidence: `${ev} → HTTP ingress for the SSR server`, fromPattern: false, category: "recommendation" }
        );
      } else {
        mappings.push(
          { componentId: `${c.id}-storage`, serviceId: "S3", confidence: "high", evidence: `${ev} → static assets`, fromPattern: false, category: "repository-evidence" },
          { componentId: c.id, serviceId: "CloudFront", confidence: "high", evidence: `${ev} → CDN`, fromPattern: false, category: "deployment-requirement" }
        );
      }
      break;

    case "backend":
    case "worker":
      if (context?.workloadClassification?.type === "ml-training" || /\bcnn\b|training|tensorflow|pytorch|keras|deep learning|machine learning/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "SageMaker", confidence: "high", evidence: `${ev} → Amazon SageMaker (ML training)`, fromPattern: false, category: "repository-evidence" });
      } else if (/serverless|lambda/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-gateway`, serviceId: "APIGateway", confidence: "medium", evidence: `${ev} → HTTP entry`, fromPattern: false, category: "deployment-requirement" }
        );
      } else if (/kubernetes|k8s/.test(tech) || /\bhelm\b/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "EKS", confidence: "high", evidence: `${ev} → Amazon EKS`, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-registry`, serviceId: "ECR", confidence: "medium", evidence: `${ev} → container image registry`, fromPattern: false, category: "deployment-requirement" }
        );
      } else if (/container|docker|jib|ecs|fargate/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-registry`, serviceId: "ECR", confidence: "medium", evidence: `${ev} → container image registry`, fromPattern: false, category: "deployment-requirement" }
        );
      } else if (/ec2|virtual machine|vm|instance/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "EC2", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else {
        mappings.push({ componentId: c.id, serviceId: "ECS", confidence: "low", evidence: `${ev} (possible container host, no container evidence)`, fromPattern: false, category: "inference" });
      }
      break;

    case "scheduler":
      if (/serverless|lambda/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-scheduler`, serviceId: "EventBridge", confidence: "medium", evidence: `${ev} → schedule trigger`, fromPattern: false, category: "deployment-requirement" }
        );
      } else {
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "low", evidence: `${ev} (possible container host, no container evidence)`, fromPattern: false, category: "inference" },
          { componentId: `${c.id}-scheduler`, serviceId: "EventBridge", confidence: "medium", evidence: `${ev} → schedule trigger`, fromPattern: false, category: "deployment-requirement" }
        );
      }
      break;

    case "api":
      if (/alb|load balancer|ingress/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "ALB", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/apigateway|api gateway|httpapi|aws_api_gateway/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "APIGateway", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      } else if (/serverless|lambda/.test(tech)) {
        mappings.push(
          { componentId: `${c.id}-compute`, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" },
          { componentId: c.id, serviceId: "APIGateway", confidence: "medium", evidence: `${ev} → Serverless HTTP entry`, fromPattern: false, category: "deployment-requirement" }
        );
      } else if (/kubernetes|k8s/.test(tech) || /\bhelm\b/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "EKS", confidence: "high", evidence: `${ev} → Amazon EKS`, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-registry`, serviceId: "ECR", confidence: "medium", evidence: `${ev} → container image registry`, fromPattern: false, category: "deployment-requirement" },
          { componentId: `${c.id}-alb`, serviceId: "ALB", confidence: "medium", evidence: `${ev} → Ingress load balancer`, fromPattern: false, category: "recommendation" }
        );
      } else if (/container|docker|jib|ecs|fargate/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" },
          { componentId: `${c.id}-registry`, serviceId: "ECR", confidence: "medium", evidence: `${ev} → container image registry`, fromPattern: false, category: "deployment-requirement" },
          { componentId: `${c.id}-alb`, serviceId: "ALB", confidence: "medium", evidence: `${ev} → Ingress load balancer`, fromPattern: false, category: "recommendation" }
        );
      } else {
        // Framework API alone (Express, FastAPI, Flask, Spring Boot, etc.) does NOT prove compute.
        // Ingress recommended as ALB, host guessed low-confidence.
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "low", evidence: `${ev} (possible container host, no container evidence)`, fromPattern: false, category: "inference" },
          { componentId: `${c.id}-alb`, serviceId: "ALB", confidence: "medium", evidence: `${ev} → Application Load Balancer recommendation`, fromPattern: false, category: "recommendation" }
        );
      }
      break;

    case "proxy":
      if (/route ?53|dns/.test(tech)) mappings.push({ componentId: c.id, serviceId: "Route53", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      else if (/alb|load balancer/.test(tech)) mappings.push({ componentId: c.id, serviceId: "ALB", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      else if (/waf|firewall/.test(tech)) mappings.push({ componentId: c.id, serviceId: "WAF", confidence: "high", evidence: ev, fromPattern: false, category: "repository-evidence" });
      break;

    case "external-service":
    case "websocket":
      break;
  }

  return mappings.filter((m) => isMappingCompatible(c.technology, m.serviceId));
}

// Additional mappings from structured lists
function mapListTechnologies(model: ArchitectureModel, alreadyMapped: AwsServiceMapping[]): AwsServiceMapping[] {
  const mappings: AwsServiceMapping[] = [];
  const listText = [
    ...model.databases,
    ...model.frameworks,
    ...model.buildConfig,
    ...model.languages,
    ...model.dependencies,
  ].join(" ").toLowerCase();

  const hasService = (s: ServiceId) =>
    alreadyMapped.some((m) => m.serviceId === s) || mappings.some((m) => m.serviceId === s);
  const add = (service: ServiceId, confidence: ConfidenceTier, evidence: string) => {
    if (hasService(service)) return;
    const pseudoId = `list-${service.toLowerCase()}`;
    mappings.push({
      componentId: pseudoId,
      serviceId: service,
      confidence,
      evidence,
      fromPattern: false,
      category: "inference",
    });
  };

  if (/dynamo/.test(listText)) add("DynamoDB", "medium", "DynamoDB listed in model");
  if (/mongo/.test(listText)) add("DocumentDB", "medium", "MongoDB listed in model");
  if (/redis|memcached|valkey/.test(listText)) add("ElastiCache", "medium", "Redis/cache listed in model");
  if (/aurora/.test(listText)) add("Aurora", "medium", "Aurora listed in model");
  if (/(postgres|postgresql|mysql|mariadb)/.test(listText) || /\bsql\b/.test(listText)) {
    if (!hasService("RDS") && !hasService("Aurora")) {
      add("RDS", "medium", "relational database listed in model");
    }
  }
  if (/kafka|confluent/.test(listText) && !hasService("MSK")) {
    add("MSK", "medium", "Kafka event streaming listed in model");
  }
  if (/(opensearch|elasticsearch)/.test(listText) && !hasService("OpenSearch")) {
    add("OpenSearch", "medium", "OpenSearch/Elasticsearch listed in model");
  }
  if (/(kubernetes|k8s)/.test(listText) || /\bhelm\b/.test(listText)) {
    if (!hasService("EKS")) add("EKS", "medium", "Kubernetes listed in model");
  }
  if (/(sagemaker|tensorflow|pytorch|scikit|huggingface|transformers|cnn)/.test(listText) && !hasService("SageMaker")) {
    add("SageMaker", "medium", "ML framework/model training listed in model");
  }
  if (/(bucket|object storage)/.test(listText) || /\bs3\b/.test(listText)) {
    if (!hasService("S3")) add("S3", "medium", "object storage referenced in model");
  }

  return mappings.filter((m) => isMappingCompatible(listText, m.serviceId));
}

// Pattern baselines — ensures complete enterprise cloud blueprint
function applyPatternBaselines(
  model: ArchitectureModel,
  alreadyMapped: AwsServiceMapping[],
  workloadClassification?: WorkloadClassification
): AwsServiceMapping[] {
  // Evidence-gated baselines (Decision 51): every mapping must carry a real
  // evidence string per commit 6286583. Baseline services have no component
  // citing them, so unconditional injection is disabled. Component-derived
  // mappings in mapComponentToAws already cover frontend/backend/compute tiers
  // with genuine evidence. No fabricated evidence strings are invented here.
  void model;
  void alreadyMapped;
  void workloadClassification;
  return [];
}

// ---------------------------------------------------------------------------
// AWS Service Deduplication & Provenance Merging
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_RANK: Record<MappingCategory, number> = {
  "repository-evidence": 4,
  "deployment-requirement": 3,
  "inference": 2,
  "recommendation": 1,
};

/**
 * Merges multiple AwsServiceMapping entries for the same AWS serviceId into one logical service.
 * Preserves all applicable provenance and evidence from all contributing sources.
 */
export function deduplicateAwsMappings(mappings: AwsServiceMapping[]): AwsServiceMapping[] {
  const byService = new Map<ServiceId, AwsServiceMapping[]>();

  for (const m of mappings) {
    const list = byService.get(m.serviceId) || [];
    list.push(m);
    byService.set(m.serviceId, list);
  }

  const result: AwsServiceMapping[] = [];

  for (const [serviceId, list] of byService.entries()) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }

    // 1. Highest confidence
    let highestConf: ConfidenceTier = "low";
    for (const item of list) {
      if (CONFIDENCE_RANK[item.confidence] > CONFIDENCE_RANK[highestConf]) {
        highestConf = item.confidence;
      }
    }

    // 2. Highest category
    let highestCat: MappingCategory | undefined = undefined;
    for (const item of list) {
      if (item.category) {
        if (!highestCat || CATEGORY_RANK[item.category] > CATEGORY_RANK[highestCat]) {
          highestCat = item.category;
        }
      }
    }

    // 3. Combine unique evidence fragments
    const evidenceSet = new Set<string>();
    for (const item of list) {
      if (item.evidence) {
        const segments = item.evidence.split(";").map((s) => s.trim()).filter(Boolean);
        for (const seg of segments) {
          if (!Array.from(evidenceSet).some((existing) => existing.toLowerCase() === seg.toLowerCase())) {
            evidenceSet.add(seg);
          }
        }
      }
    }
    const combinedEvidence = Array.from(evidenceSet).join("; ").slice(0, 200);

    // 4. fromPattern is true ONLY if ALL sources were fromPattern
    const allFromPattern = list.every((item) => item.fromPattern === true);

    // 5. Select best componentId (prefer real component ID over pattern- or list- or svc-)
    const isGenericId = (id: string) =>
      id.startsWith("pattern-") || id.startsWith("list-") || id.startsWith("svc-") || id === "fallback";

    let bestComponentId = list[0].componentId;
    for (const item of list) {
      if (!isGenericId(item.componentId)) {
        bestComponentId = item.componentId;
        break;
      }
    }
    if (isGenericId(bestComponentId)) {
      const preferred =
        list.find((i) => i.componentId.startsWith("svc-")) ||
        list.find((i) => i.componentId.startsWith("list-")) ||
        list[0];
      bestComponentId = preferred.componentId;
    }

    result.push({
      componentId: bestComponentId,
      serviceId,
      confidence: highestConf,
      evidence: combinedEvidence || `${serviceId} mapped from architecture analysis`,
      fromPattern: allFromPattern,
      category: highestCat,
    });
  }

  return result;
}

function detectPatternFromComponents(components: ArchitectureComponent[]): PatternId {
  // Simple heuristic for UI label only
  const types = new Set(components.map((c) => c.type));
  const techs = components.map((c) => c.technology.toLowerCase()).join(" ");

  if (types.has("frontend") && !types.has("backend") && !types.has("api")) return "static-site";
  if (techs.includes("lambda") || techs.includes("serverless")) return "serverless-api";
  if (techs.includes("docker") || techs.includes("kubernetes") || techs.includes("ecs") || techs.includes("fargate")) return "containerised-app";
  if (types.has("queue") || types.has("messaging") || techs.includes("sqs") || techs.includes("eventbridge")) return "event-driven";
  if (techs.includes("sagemaker") || techs.includes("tensorflow") || techs.includes("pytorch")) return "ml-pipeline";
  if (types.has("frontend") && (types.has("backend") || types.has("api"))) return "full-stack-web";
  if (techs.includes("kinesis") || techs.includes("redshift") || techs.includes("airflow")) return "data-pipeline";
  return "generic";
}

// ---------------------------------------------------------------------------
// Main mapping function
// ---------------------------------------------------------------------------

export interface ModelContext {
  inputKind: "github_url" | "description";
  grounding: Grounding;
  truncated: boolean;
  parseErrors: string[];
  workloadClassification?: WorkloadClassification;
  evidenceRegister?: EvidenceRecord[];
  /**
   * Optional collector. When supplied, a validation failure of the mapped plan
   * is reported here instead of only reaching a console.warn — the caller can
   * then tell the user their diagram came from the emergency floor rather than
   * from their repository.
   */
  diagnostics?: DiagnosticSink;
}

export function mapArchitectureModelToServicePlan(
  model: ArchitectureModel,
  ctx: ModelContext
): ServicePlan {
  const componentServices = new Map<string, ServiceId>();
  const awsMappings: AwsServiceMapping[] = [];

  // 1. Map each discovered component to AWS services
  for (const c of model.components) {
    const mapped = mapComponentToAws(c, { workloadClassification: ctx.workloadClassification });
    for (const m of mapped) {
      if (!componentServices.has(c.id)) componentServices.set(c.id, m.serviceId);
      // Deduplicate by (componentId, serviceId)
      const exists = awsMappings.some((a) => a.componentId === m.componentId && a.serviceId === m.serviceId);
      if (!exists) awsMappings.push(m);
    }
  }

  // 2. Map technologies from structured lists
  const listMappings = mapListTechnologies(model, awsMappings);
  awsMappings.push(...listMappings);

  // 3. Apply pattern baselines (marked fromPattern: true for sanity-check only)
  const patternMappings = applyPatternBaselines(model, awsMappings, ctx.workloadClassification);
  awsMappings.push(...patternMappings);

  // 4. Global deduplication of logical AWS services (merges multiple instances, preserves provenance)
  const finalAwsMappings = deduplicateAwsMappings(awsMappings);

  // 5. Build DiscoveredComponent output (pass through with status)
  const components: DiscoveredComponent[] = model.components.map((c) => ({
    id: c.id,
    type: c.type,
    technology: c.technology,
    evidence: c.evidence,
    confidence: c.confidence,
    status: c.evidence.length > 0 ? "detected" : "inferred",
  }));

  // Ensure every mapping has a matching component
  for (const m of finalAwsMappings) {
    if (!components.some((c) => c.id === m.componentId)) {
      components.push({
        id: m.componentId,
        type: serviceTypeFromId(m.serviceId),
        technology: m.serviceId,
        evidence: m.evidence ? [m.evidence] : [],
        confidence: m.confidence,
        status: m.confidence === "high" ? "detected" : "inferred",
      });
    }
  }

  // 6. Build Relationships output
  const relationships: ComponentRelationship[] = model.relationships.map((r) => ({
    from: r.from,
    to: r.to,
    type: r.type,
  }));

  // Add auxiliary component links
  for (const c of model.components) {
    const storageComp = `${c.id}-storage`;
    if (components.some((x) => x.id === storageComp) && !relationships.some((r) => r.from === c.id && r.to === storageComp)) {
      relationships.push({ from: c.id, to: storageComp, type: "reads/writes" });
    }
    const registryComp = `${c.id}-registry`;
    if (components.some((x) => x.id === registryComp) && !relationships.some((r) => r.from === c.id && r.to === registryComp)) {
      relationships.push({ from: c.id, to: registryComp, type: "reads/writes" });
    }
    const albComp = `${c.id}-alb`;
    if (components.some((x) => x.id === albComp) && !relationships.some((r) => r.from === albComp && r.to === c.id)) {
      relationships.push({ from: albComp, to: c.id, type: "calls" });
    }
  }

  // 7. Build DeploymentModel per component (inferred, not templated)
  const deploymentModel: DeploymentModel[] = components.map((c) => {
    const mapped = componentServices.get(c.id) ?? finalAwsMappings.find((m) => m.componentId === c.id)?.serviceId;
    const isCompute = mapped && COMPUTE_SERVICES.includes(mapped);
    const isDatabase = c.type === "database";
    const isCache = c.type === "cache";

    return {
      componentId: c.id,
      public: c.type === "frontend" || c.type === "api",
      needsVpc: Boolean(isCompute || isDatabase || isCache),
      needsMultiAz: Boolean(isDatabase || isCache),
      needsAutoscaling: Boolean(isCompute && (mapped === "ECS" || mapped === "EC2" || mapped === "EKS")),
      source: "recommended" as const,
      notes: isDatabase ? "Production DB → recommend Multi-AZ" : undefined,
    };
  });

  // 8. Detect pattern for UI label (never constrains output)
  const detectedPattern = detectPatternFromComponents(model.components);

  // 8b. Derive dbEngine for RDS cost labelling (postgres/mysql/none)
  // Use component technology + details text plus RDS/Aurora mapping evidence
  function deriveDbEngine(): "postgres" | "mysql" | "none" {
    const textParts: string[] = [];
    for (const c of model.components) {
      textParts.push(c.technology, c.details ?? "");
    }
    for (const m of finalAwsMappings) {
      if (m.serviceId === "RDS" || m.serviceId === "Aurora") {
        textParts.push(m.evidence ?? "");
      }
    }
    const text = textParts.join(" ").toLowerCase();
    if (/postgres|postgresql/.test(text)) return "postgres";
    if (/mysql|mariadb/.test(text)) return "mysql";
    return "none";
  }
  const dbEngine = deriveDbEngine();

  // 9. Build ServicePlan
  const plan = {
    inputKind: ctx.inputKind,
    components,
    relationships,
    deploymentModel,
    awsMappings: finalAwsMappings,
    detectedPattern,
    metadata: {
      grounding: ctx.grounding,
      truncated: ctx.truncated,
      parseErrors: ctx.parseErrors,
      dbEngine,
    },
  };

  const check = ServicePlanSchema.safeParse(plan);
  if (check.success) return check.data;

  // The floor is a single S3 bucket. It is NOT an architecture — it is what we
  // show when our own mapping produced something the contract rejects. Say so.
  const detail = check.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  console.warn("[architecture] mapped plan failed validation — using minimal floor:", detail);
  pushDiagnostic(ctx.diagnostics, {
    stage: "architecture",
    severity: "error",
    code: "mapped-plan-validation-failed",
    message:
      "The AWS mapping produced a plan that failed the ServicePlan contract. " +
      "The result shown is a placeholder, not an inference from your project.",
    detail,
  });

  const floor = ServicePlanSchema.safeParse({
    inputKind: ctx.inputKind,
    components: [{ id: "fallback", type: "object-storage" as ComponentType, technology: "S3", evidence: [], confidence: "low" as ConfidenceTier, status: "inferred" as const }],
    relationships: [],
    deploymentModel: [],
    awsMappings: [{ componentId: "fallback", serviceId: "S3", confidence: "low" as ConfidenceTier, evidence: "fallback", fromPattern: false }],
    detectedPattern: "generic",
    metadata: { grounding: ctx.grounding, truncated: ctx.truncated, parseErrors: [...ctx.parseErrors, "mapped-plan-validation-failed"] },
  });
  if (floor.success) return floor.data;

  // The floor itself failed to parse — that can only be a bug in this file, and
  // returning an unvalidated plan downstream would corrupt diagram and cost.
  pushDiagnostic(ctx.diagnostics, {
    stage: "architecture",
    severity: "error",
    code: "floor-plan-validation-failed",
    message: "Internal error: even the minimal fallback plan failed validation.",
    detail: floor.error.issues.map((i) => i.message).join("; "),
  });
  return plan as unknown as ServicePlan;
}