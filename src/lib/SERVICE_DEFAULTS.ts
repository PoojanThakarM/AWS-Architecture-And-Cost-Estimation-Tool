/**
 * SERVICE_DEFAULTS.ts — Stage 5
 *
 * Per-service baseline quantities used for cost estimation when no
 * user-specific numbers are available. These represent a "small but
 * real" production workload (~10k MAU, moderate traffic).
 *
 * Units and field meanings are documented inline.
 * Sources: AWS pricing pages + AWS Calculator defaults (2024).
 *
 * Decision: quantities scale linearly with a userCount multiplier
 * supplied by the UI slider. The base values below correspond to
 * userCount = 10_000 (10k MAU).
 */

export interface ServiceDefault {
  /** Human-readable unit description shown in the cost table */
  unitLabel: string;
  /**
   * Quantity at the 10k-MAU baseline.
   * Scaled by (userCount / 10_000) on the client.
   */
  baseQuantity: number;
  /**
   * AWS Pricing API serviceCode (used for the Bulk Pricing API).
   * null if the service is billed through a parent (e.g. Fargate via ECS).
   */
  serviceCode: string | null;
  /**
   * usageType prefix for the Bulk Pricing API query.
   * Region suffix is appended at query time: e.g. "USE1-" for us-east-1.
   */
  usageTypePrefix: string | null;
  /** Short annotation explaining the quantity choice. Shown in UI. */
  annotation: string;
  /**
   * What `unitPrice` is per, in the SAME unit as `baseQuantity`
   * (e.g. "per GB-second", "per million requests"). Shown next to the price
   * so a unit mismatch is visible instead of silently wrong.
   */
  priceUnit?: string;
  /**
   * Converts a live AWS Price List unit price into this row's unit. The Price
   * List quotes request-based services per single request, while these rows
   * count millions — without this factor a live lookup made 5M API calls cost
   * $0.0000175 instead of $5.
   */
  livePriceMultiplier?: number;
  /** Extra product attributes a live price-list SKU must match (engine, OS…). */
  attributeFilters?: Record<string, string>;
  /**
   * Monthly free allowance in this row's units, subtracted before pricing and
   * re-applied when the client rescales the user count.
   */
  freeTierQuantity?: number;
  /** Additional billable dimensions of the same service (requests, memory, storage). */
  extraLines?: ServiceLine[];
  /** Significant costs this baseline deliberately leaves out. Shown in UI. */
  excludes?: string;
}

/** A secondary billing dimension of a service (Lambda requests, Fargate memory…). */
export interface ServiceLine extends Omit<ServiceDefault, "extraLines"> {
  /** Stable id; the fallback price is looked up as `${serviceId}:${lineId}`. */
  lineId: string;
  /** Does NOT scale with user count (provisioned capacity). */
  fixed?: boolean;
}

export const SERVICE_DEFAULTS: Record<string, ServiceDefault> = {
  // ── Compute ─────────────────────────────────────────────────────────────
  EC2: {
    unitLabel: "instance-hours/mo (t3.small)",
    baseQuantity: 720, // 1 × t3.small running 24/7
    serviceCode: "AmazonEC2",
    usageTypePrefix: "BoxUsage:t3.small",
    annotation: "1 t3.small Linux instance × 720 h/mo; source: EC2 On-Demand pricing page",
    priceUnit: "per instance-hour",
    attributeFilters: { operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" },
    excludes: "EBS root volume, data transfer",
  },
  Lambda: {
    unitLabel: "GB-seconds/mo",
    // 5,000,000 requests × 0.2 s × 0.5 GB = 500,000 GB-seconds.
    // (Was 5,000,000 — the request count — which overstated compute 10×.)
    baseQuantity: 500_000,
    serviceCode: "AWSLambda",
    usageTypePrefix: "Lambda-GB-Second",
    annotation: "5M requests × 200 ms avg × 512 MB = 500k GB-s; source: Lambda pricing page",
    priceUnit: "per GB-second",
    excludes: "free tier (400k GB-s + 1M requests/mo) not applied",
    extraLines: [
      {
        lineId: "requests",
        unitLabel: "requests (millions)/mo",
        baseQuantity: 5,
        serviceCode: "AWSLambda",
        usageTypePrefix: "Request",
        annotation: "5M invocations; source: Lambda pricing page",
        priceUnit: "per million requests",
        livePriceMultiplier: 1_000_000,
      },
    ],
  },
  ECS: {
    unitLabel: "vCPU-hours/mo (Fargate pricing)",
    baseQuantity: 720, // 2 tasks × 0.5 vCPU × 720 h = 720 vCPU-hours
    serviceCode: "AmazonECS",
    usageTypePrefix: "Fargate-vCPU-Hours:perCPU",
    annotation: "2 Fargate tasks × 0.5 vCPU × 720 h; source: Fargate pricing page",
    priceUnit: "per vCPU-hour",
    extraLines: [
      {
        lineId: "memory",
        unitLabel: "GB-hours/mo (Fargate memory)",
        baseQuantity: 1_440, // 2 tasks × 1 GB × 720 h
        serviceCode: "AmazonECS",
        usageTypePrefix: "Fargate-GB-Hours",
        annotation: "2 Fargate tasks × 1 GB × 720 h; source: Fargate pricing page",
        priceUnit: "per GB-hour",
        fixed: true,
      },
    ],
  },
  EKS: {
    unitLabel: "cluster-hours/mo (control plane)",
    baseQuantity: 720, // 1 cluster × 720 h
    serviceCode: "AmazonEKS",
    usageTypePrefix: "AmazonEKS-Hours:perHour",
    annotation: "1 EKS control plane × 720 h; source: EKS pricing page",
    priceUnit: "per cluster-hour",
    excludes: "worker nodes (EC2 or Fargate) are billed separately and NOT included",
  },
  Fargate: {
    unitLabel: "vCPU-hours/mo",
    baseQuantity: 720, // 2 tasks × 0.5 vCPU × 720 h = 720 vCPU-hours
    serviceCode: "AmazonECS",
    usageTypePrefix: "Fargate-vCPU-Hours:perCPU",
    annotation: "2 Fargate tasks × 0.5 vCPU × 720 h; source: Fargate pricing page",
    priceUnit: "per vCPU-hour",
    extraLines: [
      {
        lineId: "memory",
        unitLabel: "GB-hours/mo (Fargate memory)",
        baseQuantity: 1_440,
        serviceCode: "AmazonECS",
        usageTypePrefix: "Fargate-GB-Hours",
        annotation: "2 Fargate tasks × 1 GB × 720 h; source: Fargate pricing page",
        priceUnit: "per GB-hour",
        fixed: true,
      },
    ],
  },
  Lightsail: {
    unitLabel: "instance-months",
    baseQuantity: 1,
    serviceCode: null,
    usageTypePrefix: null,
    annotation: "1 Lightsail $10/mo plan (flat-rate, not in Bulk API)",
  },
  Batch: {
    unitLabel: "vCPU-hours/mo",
    baseQuantity: 100,
    serviceCode: "AWSBatch",
    usageTypePrefix: "Batch-vCPU-Hours",
    annotation: "100 vCPU-hours of job compute priced at the Fargate on-demand rate (AWS Batch itself has no charge)",
    priceUnit: "per vCPU-hour",
  },

  // ── Storage ─────────────────────────────────────────────────────────────
  S3: {
    unitLabel: "GB-months stored",
    baseQuantity: 50, // 50 GB of objects
    serviceCode: "AmazonS3",
    usageTypePrefix: "TimedStorage-ByteHrs",
    annotation: "50 GB at S3 Standard; source: S3 pricing page",
  },
  EBS: {
    unitLabel: "GB-months (gp3)",
    baseQuantity: 100,
    serviceCode: "AmazonEC2",
    usageTypePrefix: "EBS:VolumeUsage.gp3",
    annotation: "100 GB gp3 volume; source: EBS pricing page",
  },
  EFS: {
    unitLabel: "GB-months (Standard)",
    baseQuantity: 50,
    serviceCode: "AmazonEFS",
    usageTypePrefix: "TimedStorage-EFS-ByteHrs",
    annotation: "50 GB EFS Standard; source: EFS pricing page",
  },
  Glacier: {
    unitLabel: "GB-months (Instant Retrieval)",
    baseQuantity: 100,
    serviceCode: "AmazonS3GlacierInstantRetrieval",
    usageTypePrefix: "TimedStorage-GIR-ByteHrs",
    annotation: "100 GB Glacier Instant Retrieval; source: S3 Glacier pricing page",
  },

  // ── Database ─────────────────────────────────────────────────────────────
  RDS: {
    unitLabel: "instance-hours/mo (db.t3.micro, MySQL)",
    baseQuantity: 720,
    serviceCode: "AmazonRDS",
    usageTypePrefix: "InstanceUsage:db.t3.micro",
    annotation: "1 db.t3.micro MySQL instance × 720 h, Single-AZ; source: RDS pricing page",
    priceUnit: "per instance-hour",
    attributeFilters: { deploymentOption: "Single-AZ" },
    excludes: "Multi-AZ standby, backups beyond the free allowance, data transfer",
    extraLines: [
      {
        lineId: "storage",
        unitLabel: "GB-months (gp2 storage)",
        baseQuantity: 20,
        serviceCode: "AmazonRDS",
        usageTypePrefix: "RDS:GP2-Storage",
        annotation: "20 GB General Purpose (gp2) storage; source: RDS pricing page",
        priceUnit: "per GB-month",
        attributeFilters: { deploymentOption: "Single-AZ" },
        fixed: true,
      },
    ],
  },
  DynamoDB: {
    unitLabel: "read request units/mo (on-demand)",
    baseQuantity: 1_000_000, // 1M reads
    serviceCode: "AmazonDynamoDB",
    usageTypePrefix: "ReadRequestUnits",
    annotation: "1M on-demand read request units; source: DynamoDB pricing page",
    priceUnit: "per read request unit",
    excludes: "table storage (first 25 GB free), backups",
    extraLines: [
      {
        lineId: "writes",
        unitLabel: "write request units/mo (on-demand)",
        baseQuantity: 250_000,
        serviceCode: "AmazonDynamoDB",
        usageTypePrefix: "WriteRequestUnits",
        annotation: "250k on-demand write request units; source: DynamoDB pricing page",
        priceUnit: "per write request unit",
      },
    ],
  },
  ElastiCache: {
    unitLabel: "node-hours/mo (cache.t3.micro)",
    baseQuantity: 720,
    serviceCode: "AmazonElastiCache",
    usageTypePrefix: "NodeUsage:cache.t3.micro",
    annotation: "1 cache.t3.micro node × 720 h; source: ElastiCache pricing page",
    priceUnit: "per node-hour",
  },
  Aurora: {
    unitLabel: "ACU-hours/mo (Aurora Serverless v2)",
    baseQuantity: 720, // 1 ACU avg
    serviceCode: "AmazonRDS",
    usageTypePrefix: "Aurora:ServerlessV2Usage",
    annotation: "1 ACU avg × 720 h Aurora Serverless v2; source: Aurora pricing page",
    priceUnit: "per ACU-hour",
    excludes: "cluster storage and I/O",
  },
  Redshift: {
    unitLabel: "node-hours/mo (dc2.large)",
    baseQuantity: 720,
    serviceCode: "AmazonRedshift",
    usageTypePrefix: "Node:dc2.large",
    annotation: "1 dc2.large node × 720 h; source: Redshift pricing page",
  },
  DocumentDB: {
    unitLabel: "instance-hours/mo (db.t3.medium)",
    baseQuantity: 720,
    serviceCode: "AmazonDocDB",
    usageTypePrefix: "InstanceUsage:db.t3.medium",
    annotation: "1 db.t3.medium DocumentDB × 720 h; source: DocumentDB pricing page",
  },

  // ── Networking ───────────────────────────────────────────────────────────
  CloudFront: {
    unitLabel: "GB transferred/mo",
    baseQuantity: 100, // 100 GB egress via CF
    serviceCode: "AmazonCloudFront",
    usageTypePrefix: "US-DataTransfer-Out-Bytes",
    annotation: "100 GB CDN egress at the United States rate; source: CloudFront pricing page",
    priceUnit: "per GB",
    excludes: "HTTP request charges; always-free 1 TB/mo allowance not applied",
  },
  APIGateway: {
    // Priced as an HTTP API because cftExport.ts provisions AWS::ApiGatewayV2
    // (HTTP API). It was priced as a REST API ($3.50/M) while the template
    // created an HTTP API — the estimate and the export disagreed.
    unitLabel: "HTTP API calls (millions)/mo",
    baseQuantity: 5, // 5M API calls
    serviceCode: "AmazonApiGateway",
    usageTypePrefix: "ApiGatewayHttpRequest",
    annotation: "5M HTTP API calls; source: API Gateway pricing page",
    priceUnit: "per million requests",
    livePriceMultiplier: 1_000_000,
  },
  ALB: {
    unitLabel: "ALB-hours/mo",
    baseQuantity: 720,
    serviceCode: "AWSElasticLoadBalancing",
    usageTypePrefix: "LoadBalancerUsage",
    annotation: "1 ALB × 720 h; source: ELB pricing page",
    priceUnit: "per ALB-hour",
    attributeFilters: { productFamily: "Load Balancer-Application" },
    excludes: "LCU (traffic) charges",
  },
  Route53: {
    unitLabel: "hosted zones/mo",
    baseQuantity: 1,
    serviceCode: "AmazonRoute53",
    usageTypePrefix: "HostedZone",
    annotation: "1 hosted zone at $0.50/mo; source: Route 53 pricing page",
  },
  // VPC intentionally has no entry: a VPC itself is free. The old entry priced
  // "1 VPC endpoint" at a per-HOUR rate × quantity 1 ($0.01/mo) — neither a
  // VPC nor a real endpoint cost. It is now listed as a no-charge service.
  NATGateway: {
    unitLabel: "NAT Gateway-hours/mo",
    baseQuantity: 720,
    serviceCode: "AmazonVPC",
    usageTypePrefix: "NatGateway-Hours",
    annotation: "1 NAT Gateway × 720 h; source: VPC pricing page",
    priceUnit: "per NAT Gateway-hour",
    excludes: "per-GB data processing",
  },

  // ── Messaging / Async ────────────────────────────────────────────────────
  SQS: {
    unitLabel: "requests (millions)/mo",
    baseQuantity: 1, // 1M messages
    serviceCode: "AWSQueueService",
    usageTypePrefix: "Requests-Tier1",
    annotation: "1M standard-queue requests; source: SQS pricing page",
    priceUnit: "per million requests",
    livePriceMultiplier: 1_000_000,
    excludes: "always-free first 1M requests/mo not applied",
  },
  SNS: {
    unitLabel: "publishes (millions)/mo",
    baseQuantity: 1,
    serviceCode: "AmazonSNS",
    usageTypePrefix: "Requests-Tier1",
    annotation: "1M SNS publishes; source: SNS pricing page",
    priceUnit: "per million requests",
    livePriceMultiplier: 1_000_000,
    excludes: "delivery charges (SMS, email, HTTP)",
  },
  EventBridge: {
    unitLabel: "custom events (millions)/mo",
    baseQuantity: 1,
    serviceCode: "AWSEvents",
    usageTypePrefix: "Event",
    annotation: "1M custom events published; source: EventBridge pricing page",
    priceUnit: "per million events",
    livePriceMultiplier: 1_000_000,
  },
  Kinesis: {
    unitLabel: "shard-hours/mo",
    baseQuantity: 720, // 1 shard
    serviceCode: "AmazonKinesis",
    usageTypePrefix: "ShardHour",
    annotation: "1 Kinesis shard × 720 h; source: Kinesis pricing page",
    priceUnit: "per shard-hour",
    excludes: "PUT payload units",
  },
  MSK: {
    unitLabel: "broker-hours/mo (kafka.m5.large)",
    // MSK needs at least 2 brokers (one per AZ). The annotation said 2 while
    // the quantity priced 1.
    baseQuantity: 1_440,
    serviceCode: "AmazonMSK",
    usageTypePrefix: "Kafka.m5.large",
    annotation: "2 kafka.m5.large brokers × 720 h; source: MSK pricing page",
    priceUnit: "per broker-hour",
    excludes: "broker storage",
  },

  // ── Auth / Identity ──────────────────────────────────────────────────────
  Cognito: {
    unitLabel: "monthly active users (billable past free tier)",
    baseQuantity: 10_000,
    serviceCode: "AmazonCognito",
    usageTypePrefix: "CognitoUserPool",
    // New user pools (since 2024-11-22) get 10,000 free MAU on the Lite and
    // Essentials tiers; pools created earlier keep the legacy 50,000.
    freeTierQuantity: 10_000,
    annotation: "MAU = user count; first 10k MAU free (new user pools, Lite/Essentials tiers); priced at the Lite rate",
    priceUnit: "per MAU",
    excludes: "Essentials/Plus tier premiums, SAML/OIDC federation MAU",
  },

  // ── DevOps / Observability ───────────────────────────────────────────────
  CloudWatch: {
    unitLabel: "custom metrics/mo",
    baseQuantity: 10, // 10 custom metrics
    serviceCode: "AmazonCloudWatch",
    usageTypePrefix: "MetricMonitorUsage",
    annotation: "10 custom metrics; source: CloudWatch pricing page",
    priceUnit: "per metric-month",
    extraLines: [
      {
        lineId: "logs",
        unitLabel: "GB log ingestion/mo",
        baseQuantity: 5,
        serviceCode: "AmazonCloudWatch",
        usageTypePrefix: "DataProcessing-Bytes",
        annotation: "5 GB log ingestion at 10k users (scales with traffic); source: CloudWatch Logs pricing page",
        priceUnit: "per GB ingested",
        fixed: false,
      },
    ],
  },
  CloudWatchLogs: {
    unitLabel: "GB ingested/mo",
    baseQuantity: 5, // 5 GB log ingestion
    serviceCode: "AmazonCloudWatch",
    usageTypePrefix: "DataProcessing-Bytes",
    annotation: "5 GB log ingestion; source: CloudWatch Logs pricing page",
  },
  CodePipeline: {
    unitLabel: "active pipelines/mo",
    baseQuantity: 1,
    serviceCode: "AWSCodePipeline",
    usageTypePrefix: "pipelineUsage",
    annotation: "1 active pipeline at $1/mo; source: CodePipeline pricing page",
  },
  ECR: {
    unitLabel: "GB-months stored",
    baseQuantity: 10,
    serviceCode: "AmazonECR",
    usageTypePrefix: "TimedStorage-ByteHrs",
    annotation: "10 GB container image storage; source: ECR pricing page",
  },

  // ── AI / ML ─────────────────────────────────────────────────────────────
  SageMaker: {
    unitLabel: "instance-hours/mo (ml.t3.medium)",
    baseQuantity: 100,
    serviceCode: "AmazonSageMaker",
    usageTypePrefix: "ml.t3.medium",
    annotation: "100 h ml.t3.medium training; source: SageMaker pricing page",
  },
  Rekognition: {
    unitLabel: "images analyzed/mo",
    baseQuantity: 10_000,
    serviceCode: "AmazonRekognition",
    usageTypePrefix: "Images",
    annotation: "10k images; source: Rekognition pricing page",
  },
  Comprehend: {
    unitLabel: "units (100 chars each)/mo",
    baseQuantity: 100_000,
    serviceCode: "AmazonComprehend",
    usageTypePrefix: "LanguageDetection",
    annotation: "100k 100-char units; source: Comprehend pricing page",
  },
  OpenSearch: {
    unitLabel: "instance-hours/mo (t3.small.search)",
    baseQuantity: 720,
    serviceCode: "AmazonES",
    usageTypePrefix: "ESInstance:t3.small.search",
    annotation: "1 t3.small.search node × 720 h; source: OpenSearch Service pricing page",
  },

  // ── Security & Secrets ───────────────────────────────────────────────────
  SecretsManager: {
    unitLabel: "secret-months",
    baseQuantity: 3,
    serviceCode: "AWSSecretsManager",
    usageTypePrefix: "Secrets",
    annotation: "3 active secrets (JWT keys, DB credentials, API tokens); source: Secrets Manager pricing",
    priceUnit: "per secret-month",
    excludes: "API call charges",
  },
  WAF: {
    unitLabel: "web ACLs/mo",
    baseQuantity: 1,
    serviceCode: "awswaf",
    usageTypePrefix: "WAF-WebACL",
    annotation: "1 Web ACL; source: WAF pricing page",
    priceUnit: "per web ACL-month",
    excludes: "per-rule ($/rule-month) and per-request charges",
  },
  CloudFormation: {
    unitLabel: "handler operations/mo",
    baseQuantity: 100,
    serviceCode: null,
    usageTypePrefix: null,
    annotation: "Free tier covers core IaC stacks; source: CloudFormation pricing page",
  },

  // ── Misc ─────────────────────────────────────────────────────────────────
  SES: {
    unitLabel: "emails sent/mo",
    baseQuantity: 10_000,
    serviceCode: "AmazonSES",
    usageTypePrefix: "Message",
    annotation: "10k emails; first 62k/mo free when sent from EC2; source: SES pricing page",
  },
  Amplify: {
    unitLabel: "build-minutes/mo",
    baseQuantity: 100,
    serviceCode: "AWSAmplify",
    usageTypePrefix: "AmplifyBuild",
    annotation: "100 build-minutes; source: Amplify pricing page",
  },
};

/** Base user count for the above quantities (used for scaling on the client). */
export const BASE_USER_COUNT = 10_000;

/**
 * Always-on (hourly/fixed-capacity) services whose cost does NOT scale with user count.
 * These represent provisioned capacity that runs 24/7 regardless of traffic.
 */
export const FIXED_COST_SERVICES: ReadonlySet<string> = new Set([
  "EC2", "ECS", "Fargate", "EKS", "Lightsail",
  "RDS", "Aurora", "ElastiCache", "Redshift", "DocumentDB", "OpenSearch",
  "ALB", "NATGateway", "VPC", "Route53", "Kinesis", "MSK",
  // Custom-metric count depends on the application, not on its user count.
  "CloudWatch",
  "WAF", "SecretsManager", "CodePipeline", "CloudFormation",
]);

export type RdsEngineLabel = "postgres" | "mysql" | "none";

/**
 * Returns the pricing baseline for a service, labelling the RDS line with
 * the detected engine instead of hardcoding MySQL.
 */
export function getServiceDefaults(
  serviceId: string,
  dbEngine: RdsEngineLabel = "none"
): ServiceDefault | undefined {
  const base = SERVICE_DEFAULTS[serviceId];
  if (!base) return undefined;
  if (serviceId === "RDS") {
    if (dbEngine === "postgres") {
      return {
        ...base,
        unitLabel: "instance-hours/mo (db.t3.micro, PostgreSQL)",
        annotation: "1 db.t3.micro PostgreSQL instance × 720 h; source: RDS pricing page",
      };
    }
    if (dbEngine === "mysql") {
      return {
        ...base,
        unitLabel: "instance-hours/mo (db.t3.micro, MySQL)",
        annotation: "1 db.t3.micro MySQL instance × 720 h; source: RDS pricing page",
      };
    }
    // dbEngine === "none": neutral label without assuming MySQL
    return {
      ...base,
      unitLabel: "instance-hours/mo (db.t3.micro)",
      annotation: "1 db.t3.micro instance × 720 h; source: RDS pricing page",
    };
  }
  return base;
}
