/**
 * schema.ts
 *
 * Single source of truth for the ServicePlan contract.
 * New design: open component discovery, no pattern/slot constraints.
 * Patterns only participate in final AWS mapping as sanity-check lookup.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Catalog allowlist (155 practical AWS services)
// ---------------------------------------------------------------------------
export const SERVICE_IDS = [
  // Compute
  "EC2", "Lambda", "ECS", "EKS", "Fargate", "Lightsail", "Batch",
  "AppRunner", "ElasticBeanstalk", "Outposts", "Wavelength", "LocalZones",
  "ServerlessApplicationRepository", "EC2ImageBuilder", "SimSpaceWeaver",

  // Storage
  "S3", "EBS", "EFS", "Glacier", "FSx", "StorageGateway", "Backup",
  "Snowball", "Snowcone", "S3GlacierDeepArchive",

  // Database, Cache & Data Warehouse
  "RDS", "Aurora", "DynamoDB", "ElastiCache", "Redshift", "DocumentDB",
  "Neptune", "Keyspaces", "Timestream", "MemoryDB", "QLDB",

  // Networking & Content Delivery
  "CloudFront", "APIGateway", "ALB", "NLB", "GLB", "Route53", "VPC",
  "NATGateway", "DirectConnect", "TransitGateway", "GlobalAccelerator",
  "PrivateLink", "AppMesh", "CloudMap", "VPCEndpoints", "SiteToSiteVPN",
  "ClientVPN",

  // Messaging, Integration & Streaming
  "SQS", "SNS", "EventBridge", "Kinesis", "KinesisDataFirehose",
  "KinesisDataStreams", "KinesisDataAnalytics", "MSK", "MQ", "AppSync",
  "StepFunctions", "ManagedAirflow", "EventBridgePipes", "EventBridgeScheduler",

  // Security, Identity & Compliance
  "WAF", "Shield", "IAM", "Cognito", "SecretsManager", "KMS", "GuardDuty",
  "Inspector", "Macie", "SecurityHub", "CertificateManager", "DirectoryService",
  "IAMIdentityCenter", "NetworkFirewall", "Artifact", "AuditManager",
  "Detective", "CloudHSM", "SystemsManager", "ParameterStore",

  // Observability, Management & Governance
  "CloudWatch", "CloudWatchLogs", "CloudWatchSynthetics", "CloudWatchEvidently",
  "CloudWatchRUM", "CloudTrail", "XRay", "Config", "ServiceCatalog",
  "ComputeOptimizer", "TrustedAdvisor", "HealthDashboard", "Organizations",
  "ControlTower", "LicenseManager", "WellArchitectedTool",

  // Developer Tools & CI/CD
  "CodePipeline", "CodeBuild", "CodeDeploy", "CodeCommit", "CodeArtifact",
  "CodeCatalyst", "CloudFormation", "CDK", "ECR", "Cloud9",
  "FaultInjectionSimulator",

  // AI & Machine Learning
  "SageMaker", "Rekognition", "Comprehend", "Transcribe", "Translate",
  "Polly", "Textract", "Kendra", "Lex", "Personalize", "Forecast",
  "Bedrock", "Q", "CodeWhisperer",

  // Analytics & Big Data
  "OpenSearch", "EMR", "Athena", "Glue", "QuickSight", "LakeFormation",
  "DataPipeline", "CleanRooms", "MSKConnect",

  // Application Integration, Web & Mobile
  "SES", "Amplify", "AppFlow", "DeviceFarm", "LocationService", "Pinpoint",
  "Connect", "WorkSpaces", "AppStream",

  // Migration & Transfer
  "DMS", "DataSync", "TransferFamily", "ApplicationDiscoveryService",
  "MigrationHub",

  // IoT
  "IoTCore", "Greengrass", "IoTEvents", "IoTAnalytics",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

// ---------------------------------------------------------------------------
// Service categories
// ---------------------------------------------------------------------------
export const SERVICE_CATEGORIES: Record<ServiceId, string> = {
  EC2: "compute", Lambda: "compute", ECS: "compute", EKS: "compute",
  Fargate: "compute", Lightsail: "compute", Batch: "compute",
  AppRunner: "compute", ElasticBeanstalk: "compute", Outposts: "compute",
  Wavelength: "compute", LocalZones: "compute", ServerlessApplicationRepository: "compute",
  EC2ImageBuilder: "compute", SimSpaceWeaver: "compute",

  S3: "storage", EBS: "storage", EFS: "storage", Glacier: "storage",
  FSx: "storage", StorageGateway: "storage", Backup: "storage",
  Snowball: "storage", Snowcone: "storage", S3GlacierDeepArchive: "storage",

  RDS: "relational_db", Aurora: "relational_db",
  DynamoDB: "nosql_db", DocumentDB: "nosql_db", Neptune: "nosql_db",
  Keyspaces: "nosql_db", Timestream: "nosql_db", MemoryDB: "cache",
  QLDB: "database", ElastiCache: "cache", Redshift: "warehouse",

  CloudFront: "networking", APIGateway: "networking", ALB: "networking",
  NLB: "networking", GLB: "networking", Route53: "networking", VPC: "networking",
  NATGateway: "networking", DirectConnect: "networking", TransitGateway: "networking",
  GlobalAccelerator: "networking", PrivateLink: "networking", AppMesh: "networking",
  CloudMap: "networking", VPCEndpoints: "networking", SiteToSiteVPN: "networking",
  ClientVPN: "networking",

  SQS: "messaging", SNS: "messaging", EventBridge: "messaging",
  Kinesis: "messaging", KinesisDataFirehose: "messaging",
  KinesisDataStreams: "messaging", KinesisDataAnalytics: "messaging",
  MSK: "messaging", MQ: "messaging", AppSync: "messaging",
  StepFunctions: "messaging", ManagedAirflow: "messaging",
  EventBridgePipes: "messaging", EventBridgeScheduler: "messaging",

  WAF: "security", Shield: "security", IAM: "security", Cognito: "auth",
  SecretsManager: "security", KMS: "security", GuardDuty: "security",
  Inspector: "security", Macie: "security", SecurityHub: "security",
  CertificateManager: "security", DirectoryService: "security",
  IAMIdentityCenter: "security", NetworkFirewall: "security",
  Artifact: "security", AuditManager: "security", Detective: "security",
  CloudHSM: "security", SystemsManager: "security", ParameterStore: "security",

  CloudWatch: "observability", CloudWatchLogs: "observability",
  CloudWatchSynthetics: "observability", CloudWatchEvidently: "observability",
  CloudWatchRUM: "observability", CloudTrail: "observability", XRay: "observability",
  Config: "observability", ServiceCatalog: "observability",
  ComputeOptimizer: "observability", TrustedAdvisor: "observability",
  HealthDashboard: "observability", Organizations: "observability",
  ControlTower: "observability", LicenseManager: "observability",
  WellArchitectedTool: "observability",

  CodePipeline: "devtools", CodeBuild: "devtools", CodeDeploy: "devtools",
  CodeCommit: "devtools", CodeArtifact: "devtools", CodeCatalyst: "devtools",
  CloudFormation: "devtools", CDK: "devtools", ECR: "devtools",
  Cloud9: "devtools", FaultInjectionSimulator: "devtools",

  SageMaker: "ml", Rekognition: "ml", Comprehend: "ml", Transcribe: "ml",
  Translate: "ml", Polly: "ml", Textract: "ml", Kendra: "ml", Lex: "ml",
  Personalize: "ml", Forecast: "ml", Bedrock: "ml", Q: "ml",
  CodeWhisperer: "ml",

  OpenSearch: "search", EMR: "analytics", Athena: "analytics",
  Glue: "analytics", QuickSight: "analytics", LakeFormation: "analytics",
  DataPipeline: "analytics", CleanRooms: "analytics", MSKConnect: "analytics",

  SES: "misc", Amplify: "misc", AppFlow: "misc", DeviceFarm: "misc",
  LocationService: "misc", Pinpoint: "misc", Connect: "misc",
  WorkSpaces: "misc", AppStream: "misc",

  DMS: "migration", DataSync: "migration", TransferFamily: "migration",
  ApplicationDiscoveryService: "migration", MigrationHub: "migration",

  IoTCore: "iot", Greengrass: "iot", IoTEvents: "iot", IoTAnalytics: "iot",
};

// ---------------------------------------------------------------------------
// Component types (open-ended, no pattern limits)
// ---------------------------------------------------------------------------
export const COMPONENT_TYPES = [
  "frontend", "backend", "api", "worker", "scheduler", "database",
  "cache", "queue", "object-storage", "search", "auth",
  "websocket", "proxy", "external-service", "messaging",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Component status
// ---------------------------------------------------------------------------
export const COMPONENT_STATUS = ["detected", "inferred"] as const;
export type ComponentStatus = (typeof COMPONENT_STATUS)[number];

// ---------------------------------------------------------------------------
// Confidence tiers
// ---------------------------------------------------------------------------
export const CONFIDENCE_TIERS = ["high", "medium", "low"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

// ---------------------------------------------------------------------------
// Grounding modes
// ---------------------------------------------------------------------------
export const GROUNDING_VALUES = [
  "repo", "repoFiles", "description", "filenameOnly", "unfounded",
] as const;
export type Grounding = (typeof GROUNDING_VALUES)[number];

// ---------------------------------------------------------------------------
// Discovered Component (open schema, no slot limit)
// ---------------------------------------------------------------------------
export const DiscoveredComponentSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(COMPONENT_TYPES),
  technology: z.string().min(1).max(80),
  evidence: z.array(z.string().max(200)).max(5).default([]),
  confidence: z.enum(CONFIDENCE_TIERS),
  status: z.enum(COMPONENT_STATUS),
});
export type DiscoveredComponent = z.infer<typeof DiscoveredComponentSchema>;

// ---------------------------------------------------------------------------
// Component Relationship (open, no cap)
// ---------------------------------------------------------------------------
export const ComponentRelationshipSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  type: z.string().max(40).optional(),
  evidence: z.string().max(200).optional(),
});
export type ComponentRelationship = z.infer<typeof ComponentRelationshipSchema>;

// ---------------------------------------------------------------------------
// Deployment Model per component (inferred, not templated)
// ---------------------------------------------------------------------------
export const DeploymentModelSchema = z.object({
  componentId: z.string(),
  public: z.boolean(),
  needsVpc: z.boolean(),
  needsMultiAz: z.boolean(),
  needsAutoscaling: z.boolean(),
  /** "detected" = explicit config found (e.g. k8s replicas); "recommended" = heuristic */
  source: z.enum(["detected", "recommended"]),
  notes: z.string().max(200).optional(),
});
export type DeploymentModel = z.infer<typeof DeploymentModelSchema>;

export const MAPPING_CATEGORIES = [
  "repository-evidence",
  "deployment-requirement",
  "inference",
  "recommendation",
] as const;
export type MappingCategory = (typeof MAPPING_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Evidence Record (grounded evidence inventory item)
// ---------------------------------------------------------------------------
export const EvidenceRecordSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["manifest", "iac", "code", "sdk", "readme", "path", "description"]),
  sourcePath: z.string().min(1).max(250),
  technology: z.string().min(1).max(100).optional(),
  detail: z.string().min(1).max(500),
  confidence: z.enum(CONFIDENCE_TIERS),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ---------------------------------------------------------------------------
// AWS Service Mapping (one per component, patterns as lookup only)
// ---------------------------------------------------------------------------
export const AwsServiceMappingSchema = z.object({
  componentId: z.string(),
  serviceId: z.enum(SERVICE_IDS),
  confidence: z.enum(CONFIDENCE_TIERS),
  evidence: z.string().max(200),
  /** If true, this mapping came from a pattern lookup table (sanity-check only) */
  fromPattern: z.boolean().default(false),
  category: z.enum(MAPPING_CATEGORIES).optional(),
});
export type AwsServiceMapping = z.infer<typeof AwsServiceMappingSchema>;

// ---------------------------------------------------------------------------
// Terminal states — explicit outcome when no standard architecture applies.
// ---------------------------------------------------------------------------
export const TERMINAL_STATES = [
  "OK",
  "INSUFFICIENT_SIGNAL",
  "LIBRARY_REPO",
  "IAC_ONLY",
  "MONOREPO_OK",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// ---------------------------------------------------------------------------
// Root ServicePlan (new design)
// ---------------------------------------------------------------------------
export const ServicePlanSchema = z
  .object({
    inputKind: z.enum(["github_url", "description"]),
    /** Open array — no max length, no pattern slots */
    components: z.array(DiscoveredComponentSchema),
    relationships: z.array(ComponentRelationshipSchema),
    deploymentModel: z.array(DeploymentModelSchema),
    awsMappings: z.array(AwsServiceMappingSchema),
    /** Pattern detection for UI label only — never constrains output */
    detectedPattern: z.string().optional(),
    /** Explicit terminal outcome; non-OK states explain intentional minimal output. */
    terminalState: z.enum(TERMINAL_STATES).default("OK"),
    proposalTitle: z.string().optional(),
    tradeOffDimension: z.string().optional(),
    tradeOffDescription: z.string().optional(),
    metadata: z.object({
      grounding: z.enum(GROUNDING_VALUES),
      truncated: z.boolean(),
      parseErrors: z.array(z.string()),
      /** Resolved relational engine for RDS cost-line labelling. */
      dbEngine: z.enum(["postgres", "mysql", "none"]).optional(),
    }),
    warnings: z.array(z.string()).default([]),
    proposals: z.array(z.any()).optional(),
  })
  .refine(
    (plan) => {
      // Catalog allowlist gate (Decision 17): every serviceId must be in SERVICE_IDS
      const ids = (plan.awsMappings || []).map((m) => m.serviceId);
      return ids.every((id) => (SERVICE_IDS as readonly string[]).includes(id));
    },
    {
      message:
        "ServicePlan contains one or more serviceIds not in the catalog allowlist",
    }
  )
  .refine(
    (plan) => {
      // Soft ceiling (replaces hard 12-cap): warn if unique services > 25 without failing parse
      const uniqueServices = new Set((plan.awsMappings || []).map((m) => m.serviceId));
      if (uniqueServices.size > 25) {
        if (!plan.warnings) {
          plan.warnings = [];
        }
        const warning = `Service count (${uniqueServices.size}) exceeds soft ceiling of 25 services`;
        if (!plan.warnings.includes(warning)) {
          plan.warnings.push(warning);
        }
      }
      return true;
    },
    {
      message: "Service count exceeds soft ceiling of 25 services",
    }
  )
  .refine(
    (plan) => {
      // Component ID uniqueness guard: ensure no two components share the same id
      const compIds = (plan.components || []).map((c) => c.id);
      const uniqueCompIds = new Set(compIds);
      if (uniqueCompIds.size < compIds.length) {
        if (!plan.warnings) {
          plan.warnings = [];
        }
        const warning = `Duplicate componentId detected: ${compIds.length - uniqueCompIds.size} redundant component(s) consolidated`;
        if (!plan.warnings.includes(warning)) {
          plan.warnings.push(warning);
        }
        // Auto-dedupe components keeping first entry
        const seen = new Set<string>();
        plan.components = plan.components.filter((c) => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
      }
      return true;
    },
    {
      message: "Components must have unique componentId identifiers",
    }
  );

export type ServicePlan = z.infer<typeof ServicePlanSchema> & {
  proposals?: ServicePlan[];
};

// ---------------------------------------------------------------------------
// Pipeline observability
//
// Which code path actually produced the plan the user is looking at. Before
// this existed, an LLM outage and a confident inference were indistinguishable
// in the response — the only signal was a console.warn on the server.
//
//   "llm"           — the LLM produced an ArchitectureModel and it was used.
//   "rules"         — no LLM provider configured; the rules baseline is the
//                     intended answer, not a degradation.
//   "rules-fallback" — an LLM provider WAS configured but the LLM path failed
//                     (network, schema mismatch, no evidence-backed
//                     components) and we silently used rules instead. This is
//                     the case that must always be visible.
// ---------------------------------------------------------------------------
export const PIPELINE_ENGINES = ["llm", "rules", "rules-fallback"] as const;
export type PipelineEngine = (typeof PIPELINE_ENGINES)[number];

export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/**
 * A machine-readable record of something that went wrong, or of a decision the
 * user could not otherwise see. Unlike `warnings` (prose, user-facing), a
 * diagnostic carries a stable `code` so tests and the UI can key on it.
 *
 * `detail` may contain provider names and zod issue text. It must never carry
 * an API key, a request URL with credentials, or a raw stack trace — route.ts
 * returns diagnostics to the browser.
 */
export const DiagnosticSchema = z.object({
  /** Pipeline stage that produced this: "llm", "architecture", "inference", "analyze". */
  stage: z.string().min(1).max(40),
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  /** Stable kebab-case identifier, e.g. "llm-call-failed". Safe to assert on. */
  code: z.string().min(1).max(60),
  /** One sentence, safe to show a user. */
  message: z.string().min(1).max(400),
  /** Optional technical detail: provider name, zod issues. Never secrets. */
  detail: z.string().max(1_000).optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

/** Mutable collector threaded through the pipeline so each stage can report. */
export type DiagnosticSink = Diagnostic[];

export function pushDiagnostic(sink: DiagnosticSink | undefined, d: Diagnostic): void {
  sink?.push(d);
}