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
}

export const SERVICE_DEFAULTS: Record<string, ServiceDefault> = {
  // ── Compute ─────────────────────────────────────────────────────────────
  EC2: {
    unitLabel: "instance-hours/mo (t3.small)",
    baseQuantity: 720, // 1 × t3.small running 24/7
    serviceCode: "AmazonEC2",
    usageTypePrefix: "BoxUsage:t3.small",
    annotation: "1 t3.small instance × 720 h/mo; source: EC2 On-Demand pricing page",
  },
  Lambda: {
    unitLabel: "GB-seconds/mo",
    baseQuantity: 5_000_000, // 5M req × 200ms × 512 MB = 500k GB-s; free tier covers 400k
    serviceCode: "AWSLambda",
    usageTypePrefix: "Lambda-GB-Second",
    annotation: "5M requests × 200 ms avg × 512 MB; source: Lambda pricing page",
  },
  ECS: {
    unitLabel: "vCPU-hours/mo (Fargate pricing)",
    baseQuantity: 720, // 2 tasks × 0.5 vCPU × 720 h = 720 vCPU-hours
    serviceCode: "AmazonECS",
    usageTypePrefix: "Fargate-vCPU-Hours:perCPU",
    annotation: "2 Fargate tasks × 0.5 vCPU × 720 h; source: Fargate pricing page",
  },
  EKS: {
    unitLabel: "cluster-hours/mo",
    baseQuantity: 720, // 1 cluster × 720 h ($0.10/h)
    serviceCode: "AmazonEKS",
    usageTypePrefix: "AmazonEKS-Hours:perHour",
    annotation: "1 EKS cluster × 720 h at $0.10/h; source: EKS pricing page",
  },
  Fargate: {
    unitLabel: "vCPU-hours/mo",
    baseQuantity: 720, // 2 tasks × 0.5 vCPU × 720 h = 720 vCPU-hours
    serviceCode: "AmazonECS",
    usageTypePrefix: "Fargate-vCPU-Hours:perCPU",
    annotation: "2 Fargate tasks × 0.5 vCPU × 720 h; source: Fargate pricing page",
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
    annotation: "Spot-priced EC2 batch jobs; source: AWS Batch pricing page",
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
    annotation: "1 db.t3.micro MySQL instance × 720 h; source: RDS pricing page",
  },
  DynamoDB: {
    unitLabel: "RCU-hours/mo (On-Demand)",
    baseQuantity: 1_000_000, // 1M reads
    serviceCode: "AmazonDynamoDB",
    usageTypePrefix: "ReadRequestUnits",
    annotation: "1M read request units on-demand; source: DynamoDB pricing page",
  },
  ElastiCache: {
    unitLabel: "node-hours/mo (cache.t3.micro)",
    baseQuantity: 720,
    serviceCode: "AmazonElastiCache",
    usageTypePrefix: "NodeUsage:cache.t3.micro",
    annotation: "1 cache.t3.micro node × 720 h; source: ElastiCache pricing page",
  },
  Aurora: {
    unitLabel: "ACU-hours/mo (Aurora Serverless v2)",
    baseQuantity: 720, // 1 ACU avg
    serviceCode: "AmazonRDS",
    usageTypePrefix: "Aurora:ServerlessV2Usage",
    annotation: "1 ACU avg × 720 h Aurora Serverless v2; source: Aurora pricing page",
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
    annotation: "100 GB CDN egress; source: CloudFront pricing page",
  },
  APIGateway: {
    unitLabel: "API calls (millions)/mo",
    baseQuantity: 5, // 5M API calls
    serviceCode: "AmazonApiGateway",
    usageTypePrefix: "ApiGatewayRequest",
    annotation: "5M REST API calls; source: API Gateway pricing page",
  },
  ALB: {
    unitLabel: "ALB-hours/mo",
    baseQuantity: 720,
    serviceCode: "AWSElasticLoadBalancing",
    usageTypePrefix: "LoadBalancerUsage",
    annotation: "1 ALB × 720 h; source: ELB pricing page",
  },
  Route53: {
    unitLabel: "hosted zones/mo",
    baseQuantity: 1,
    serviceCode: "AmazonRoute53",
    usageTypePrefix: "HostedZone",
    annotation: "1 hosted zone at $0.50/mo; source: Route 53 pricing page",
  },
  VPC: {
    unitLabel: "VPC endpoints/mo",
    baseQuantity: 1,
    serviceCode: "AmazonVPC",
    usageTypePrefix: "VpcEndpoint-Hours",
    annotation: "1 VPC endpoint × 720 h; source: VPC pricing page",
  },
  NATGateway: {
    unitLabel: "NAT Gateway-hours/mo",
    baseQuantity: 720,
    serviceCode: "AmazonVPC",
    usageTypePrefix: "NatGateway-Hours",
    annotation: "1 NAT Gateway × 720 h; source: VPC pricing page",
  },

  // ── Messaging / Async ────────────────────────────────────────────────────
  SQS: {
    unitLabel: "requests (millions)/mo",
    baseQuantity: 1, // 1M messages
    serviceCode: "AWSQueueService",
    usageTypePrefix: "Request",
    annotation: "1M SQS requests; source: SQS pricing page (first 1M free)",
  },
  SNS: {
    unitLabel: "notifications (millions)/mo",
    baseQuantity: 1,
    serviceCode: "AmazonSNS",
    usageTypePrefix: "Requests-Tier1",
    annotation: "1M SNS publishes; source: SNS pricing page",
  },
  EventBridge: {
    unitLabel: "events (millions)/mo",
    baseQuantity: 1,
    serviceCode: "AmazonEventBridge",
    usageTypePrefix: "Events",
    annotation: "1M EventBridge events; source: EventBridge pricing page",
  },
  Kinesis: {
    unitLabel: "shard-hours/mo",
    baseQuantity: 720, // 1 shard
    serviceCode: "AmazonKinesis",
    usageTypePrefix: "ShardHour",
    annotation: "1 Kinesis shard × 720 h; source: Kinesis pricing page",
  },
  MSK: {
    unitLabel: "broker-hours/mo (kafka.m5.large)",
    baseQuantity: 720,
    serviceCode: "AmazonMSK",
    usageTypePrefix: "Kafka.m5.large",
    annotation: "2 kafka.m5.large brokers × 720 h; source: MSK pricing page",
  },

  // ── Auth / Identity ──────────────────────────────────────────────────────
  Cognito: {
    unitLabel: "billable MAU past free tier",
    baseQuantity: 10_000,
    serviceCode: "AmazonCognito",
    usageTypePrefix: "CognitoUserPool",
    annotation: "10k MAU; first 50k free in Cognito User Pools",
  },

  // ── DevOps / Observability ───────────────────────────────────────────────
  CloudWatch: {
    unitLabel: "metrics/mo + 5 GB logs",
    baseQuantity: 10, // 10 custom metrics
    serviceCode: "AmazonCloudWatch",
    usageTypePrefix: "MetricMonitorUsage",
    annotation: "10 custom metrics + 5 GB log ingestion; source: CloudWatch pricing page",
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
  },
  WAF: {
    unitLabel: "web ACL + rules/mo",
    baseQuantity: 1,
    serviceCode: "awswaf",
    usageTypePrefix: "WAF-WebACL",
    annotation: "1 Web ACL with standard managed rule groups; source: WAF pricing page",
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
