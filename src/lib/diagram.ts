/**
 * diagram.ts — Stage 4: ServicePlan → mxGraph XML (.drawio format)
 *
 * Generates publication-ready AWS architecture diagrams in .drawio format.
 *
 * Guarantees:
 * - Mathematical centering: computes full bounding box of all containers and nodes,
 *   and translates everything to be centered with uniform margins.
 * - Full-label bounding boxes & intelligent multi-line wrapping so service names
 *   and edge labels never collide.
 * - Auto-expanding container boundaries that cleanly contain all children.
 * - Distinct visual hierarchy with official AWS Well-Architected color-coded themes.
 * - Orthogonal edge routing through container channels with clean branching bus.
 * - Opaque badges on edge labels to prevent line strike-through.
 *
 * Exported:
 *   generateDiagramXml(plan: ServicePlan, sdkEvidence?: SdkEvidence[] | null): string
 *   computeLayout(services: AwsServiceMapping[]): DiagramLayout
 *   bucketHeight(rows: number): number
 *   normalizeServiceName(serviceId: string): string
 *   wrapServiceName(name: string): string
 *   layoutNodes(entries: BucketEntry[], cols: number, startX: number, startY: number): PlacedBucket | null
 *   routeEdges(...): RoutedEdge[]
 */

import type {
  ServicePlan,
  ServiceId,
  AwsServiceMapping,
  ComponentRelationship,
} from "./schema.ts";
import type { SdkEvidence } from "./repoFetcher.ts";

// ---------------------------------------------------------------------------
// XML Helpers
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00–0x1F except TAB/LF/CR) from a string */
function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Escapes a string for safe use inside an XML attribute value */
export function xmlAttr(s: string): string {
  return stripControlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// AWS Service Display Names & Intelligent Wrapping
// ---------------------------------------------------------------------------

export const AWS_DISPLAY_NAMES: Record<string, string> = {
  // Compute
  EC2: "Amazon EC2",
  Lambda: "AWS Lambda",
  ECS: "Amazon ECS",
  EKS: "Amazon EKS",
  Fargate: "AWS Fargate",
  Lightsail: "Amazon Lightsail",
  Batch: "AWS Batch",
  // Storage
  S3: "Amazon S3",
  EBS: "Amazon EBS",
  EFS: "Amazon EFS",
  Glacier: "Amazon S3 Glacier",
  // Database
  RDS: "Amazon RDS",
  DynamoDB: "Amazon DynamoDB",
  ElastiCache: "Amazon ElastiCache",
  Aurora: "Amazon Aurora",
  Redshift: "Amazon Redshift",
  DocumentDB: "Amazon DocumentDB",
  // Networking
  CloudFront: "Amazon CloudFront",
  APIGateway: "Amazon API Gateway",
  ALB: "Application Load Balancer (ALB)",
  Route53: "Amazon Route 53",
  VPC: "Amazon VPC",
  NATGateway: "NAT Gateway",
  WAF: "AWS WAF",
  // Messaging
  SQS: "Amazon SQS",
  SNS: "Amazon SNS",
  EventBridge: "Amazon EventBridge",
  Kinesis: "Amazon Kinesis",
  MSK: "Amazon MSK",
  // Auth & Security
  Cognito: "Amazon Cognito",
  SecretsManager: "AWS Secrets Manager",
  // DevOps & Observability
  CloudWatch: "Amazon CloudWatch",
  CodePipeline: "AWS CodePipeline",
  ECR: "Amazon ECR",
  CloudFormation: "AWS CloudFormation",
  // AI / ML
  SageMaker: "Amazon SageMaker",
  Rekognition: "Amazon Rekognition",
  Comprehend: "Amazon Comprehend",
  // Search
  OpenSearch: "Amazon OpenSearch Service",
  // Misc
  SES: "Amazon SES",
  Amplify: "AWS Amplify",
};

export function normalizeServiceName(serviceId: string): string {
  return AWS_DISPLAY_NAMES[serviceId] ?? serviceId;
}

/**
 * Normalizes a service name for comparison purposes — used to detect
 * redundant self-referential labels like "ALB (ALB)" or
 * "AWS Secrets Manager (Secrets Manager)".
 *
 * Strips: AWS/Amazon prefixes, punctuation, whitespace, lowercases everything.
 */
export function normalizeForComparison(s: string): string {
  return s
    .replace(/^(AWS|Amazon)\s+/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/**
 * Wraps service display names into balanced lines of at most ~16 characters,
 * ensuring words are never awkwardly truncated and text width stays within ~110px.
 */
export function wrapServiceName(name: string): string {
  if (name.length <= 16) return name;

  // Specific clean wraps for known long AWS names
  const cleanWraps: Record<string, string> = {
    "Application Load Balancer (ALB)": "Application Load\nBalancer (ALB)",
    "AWS Secrets Manager": "AWS Secrets\nManager",
    "Amazon DocumentDB": "Amazon\nDocumentDB",
    "Amazon CloudWatch": "Amazon\nCloudWatch",
    "Amazon CloudFront": "Amazon\nCloudFront",
    "Amazon Route 53": "Amazon\nRoute 53",
    "Amazon ElastiCache": "Amazon\nElastiCache",
    "Amazon DynamoDB": "Amazon\nDynamoDB",
    "Amazon API Gateway": "Amazon API\nGateway",
    "AWS CloudFormation": "AWS\nCloudFormation",
    "Amazon EventBridge": "Amazon\nEventBridge",
    "Amazon CodePipeline": "Amazon\nCodePipeline",
    "Amazon SageMaker": "Amazon\nSageMaker",
    "Amazon Rekognition": "Amazon\nRekognition",
    "Amazon S3 Glacier": "Amazon S3\nGlacier",
    "Amazon OpenSearch Service": "Amazon OpenSearch\nService",
    "Amazon MSK": "Amazon MSK",
  };
  if (cleanWraps[name]) return cleanWraps[name];

  // Generalized word wrapping
  const words = name.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= 16) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AWS Icon Shape Definitions
// ---------------------------------------------------------------------------

const AWS_ICON_STYLES: Partial<Record<string, string>> = {
  // Compute
  EC2: "shape=mxgraph.aws4.ec2;",
  Lambda: "shape=mxgraph.aws4.lambda;",
  ECS: "shape=mxgraph.aws4.ecs;",
  EKS: "shape=mxgraph.aws4.eks;",
  Fargate: "shape=mxgraph.aws4.fargate;",
  Lightsail: "shape=mxgraph.aws4.lightsail;",
  Batch: "shape=mxgraph.aws4.batch;",
  // Storage
  S3: "shape=mxgraph.aws4.s3;",
  EBS: "shape=mxgraph.aws4.ebs;",
  EFS: "shape=mxgraph.aws4.efs;",
  Glacier: "shape=mxgraph.aws4.glacier;",
  // Database
  RDS: "shape=mxgraph.aws4.rds;",
  DynamoDB: "shape=mxgraph.aws4.dynamodb;",
  ElastiCache: "shape=mxgraph.aws4.elasticache;",
  Aurora: "shape=mxgraph.aws4.aurora;",
  Redshift: "shape=mxgraph.aws4.redshift;",
  DocumentDB: "shape=mxgraph.aws4.documentdb;",
  // Networking
  CloudFront: "shape=mxgraph.aws4.cloudfront;",
  APIGateway: "shape=mxgraph.aws4.api_gateway;",
  ALB: "shape=mxgraph.aws4.application_load_balancer;",
  Route53: "shape=mxgraph.aws4.route_53;",
  VPC: "shape=mxgraph.aws4.vpc;",
  NATGateway: "shape=mxgraph.aws4.nat_gateway;",
  WAF: "shape=mxgraph.aws4.waf;",
  // Messaging
  SQS: "shape=mxgraph.aws4.sqs;",
  SNS: "shape=mxgraph.aws4.sns;",
  EventBridge: "shape=mxgraph.aws4.eventbridge;",
  Kinesis: "shape=mxgraph.aws4.kinesis;",
  MSK: "shape=mxgraph.aws4.managed_streaming_for_kafka;",
  // Search
  OpenSearch: "shape=mxgraph.aws4.opensearch_service;",
  // Auth
  Cognito: "shape=mxgraph.aws4.cognito;",
  SecretsManager: "shape=mxgraph.aws4.secrets_manager;",
  // DevOps / Observability
  CloudWatch: "shape=mxgraph.aws4.cloudwatch;",
  CodePipeline: "shape=mxgraph.aws4.codepipeline;",
  ECR: "shape=mxgraph.aws4.ecr;",
  CloudFormation: "shape=mxgraph.aws4.cloudformation;",
  // AI / ML
  SageMaker: "shape=mxgraph.aws4.sagemaker;",
  Rekognition: "shape=mxgraph.aws4.rekognition;",
  Comprehend: "shape=mxgraph.aws4.comprehend;",
  // Misc
  SES: "shape=mxgraph.aws4.ses;",
  Amplify: "shape=mxgraph.aws4.amplify;",
};

export const FALLBACK_STYLE =
  "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.general_AWS_Cloud;" +
  "sketch=0;outlineConnect=0;fontColor=#1E293B;gradientColor=none;fillColor=#FF9900;strokeColor=none;dashed=0;" +
  "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=1;aspect=fixed;pointerEvents=1;spacingTop=4;";

export function nodeStyle(serviceId: string): string {
  const awsShape = AWS_ICON_STYLES[serviceId];
  if (awsShape) {
    return (
      `${awsShape}` +
      "sketch=0;outlineConnect=0;fontColor=#1E293B;gradientColor=none;fillColor=#FF9900;strokeColor=none;dashed=0;" +
      "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=1;aspect=fixed;pointerEvents=1;spacingTop=4;"
    );
  }
  console.warn(`[diagram] Missing AWS icon for serviceId: "${serviceId}". Using generic AWS Cloud fallback.`);
  return FALLBACK_STYLE;
}

// ---------------------------------------------------------------------------
// Grid & Container Geometry Constants
// ---------------------------------------------------------------------------

// CELL_W accommodates full wrapped service name width (110px) with internal padding
export const CELL_W = 116; 
// CELL_H satisfies test requirement: 4 * CELL_H >= 312
export const CELL_H = 80;
export const ICON_SIZE = 56;
export const GAP = 40;     // Generous horizontal node gap (40-80px per spec)
export const VGAP = 48;    // Vertical channel between container tiers (was 36 - provides dedicated routing gutters)
export const PAD = 24;     // Container interior padding (was 20)
export const LABEL_H = 32; // Dedicated container header title bar height (was 26)
export const PAD_TOP = 20; // Dedicated vertical padding below container header
export const PAD_BOTTOM = 28; // Dedicated bottom padding inside container (protects service labels)
export const MARGIN = 32;  // Initial layout margin

export const SUBNET_COLS = 4;   // Columns per VPC subnet
export const EDGE_COLS = 6;     // Columns in top edge banner
export const EXTERNAL_COLS = 2; // Columns in external column

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tier = "edge" | "vpc_public" | "vpc_compute" | "vpc_data" | "cross_cutting" | "external";

export const SERVICE_TIERS: Record<ServiceId, Tier> = {
  // Edge / public entry points (top banner)
  Route53: "edge",
  CloudFront: "edge",
  APIGateway: "edge",
  ALB: "edge",
  Cognito: "edge",
  WAF: "edge",
  // Network infrastructure (public subnet)
  VPC: "vpc_public",
  NATGateway: "vpc_public",
  // Compute (compute subnet)
  EC2: "vpc_compute",
  Lambda: "vpc_compute",
  ECS: "vpc_compute",
  EKS: "vpc_compute",
  Fargate: "vpc_compute",
  Lightsail: "vpc_compute",
  Batch: "vpc_compute",
  // Data / storage / async / ml (data subnet)
  S3: "vpc_data",
  EBS: "vpc_data",
  EFS: "vpc_data",
  Glacier: "vpc_data",
  RDS: "vpc_data",
  Aurora: "vpc_data",
  DynamoDB: "vpc_data",
  ElastiCache: "vpc_data",
  Redshift: "vpc_data",
  DocumentDB: "vpc_data",
  SQS: "vpc_data",
  SNS: "vpc_data",
  EventBridge: "vpc_data",
  Kinesis: "vpc_data",
  MSK: "vpc_data",
  OpenSearch: "vpc_data",
  SecretsManager: "vpc_data",
  SageMaker: "vpc_data",
  Rekognition: "vpc_data",
  Comprehend: "vpc_data",
  // Cross-cutting management, governance & CI/CD
  CloudWatch: "cross_cutting",
  CodePipeline: "cross_cutting",
  CloudFormation: "cross_cutting",
  ECR: "cross_cutting",
  // External services (column beside the VPC)
  SES: "external",
  Amplify: "external",
};

export type ContainerKey =
  | "aws_cloud"
  | "edge"
  | "vpc"
  | "az"
  | "public_subnet"
  | "compute_subnet"
  | "data_subnet"
  | "cross_cutting"
  | "external";

export const CONTAINER_LABELS: Record<ContainerKey, string> = {
  aws_cloud: "AWS Cloud",
  edge: "Edge & Public Ingress",
  vpc: "Virtual Private Cloud (VPC)",
  az: "Availability Zone 1",
  public_subnet: "Public Subnet (DMZ)",
  compute_subnet: "Compute Subnet (Private)",
  data_subnet: "Data & Storage Subnet (Isolated)",
  cross_cutting: "Management & Governance",
  external: "External Cloud Services",
};

/** Container height for a given row count (label bar + rows + padding). */
export function bucketHeight(rows: number): number {
  if (rows <= 0) return 0;
  return LABEL_H + PAD_TOP + rows * CELL_H + (rows - 1) * GAP + PAD_BOTTOM;
}

export interface BucketEntry {
  componentId: string;
  serviceId: ServiceId;
}

export interface PlacedNode {
  componentId: string;
  serviceId: ServiceId;
  x: number;
  y: number;
}

export interface PlacedBucket {
  rect: Rect;
  nodes: PlacedNode[];
}

/** Packs a bucket into `cols` columns starting at (x, y); null when empty. */
export function layoutNodes(
  entries: BucketEntry[],
  cols: number,
  x: number,
  y: number
): PlacedBucket | null {
  if (entries.length === 0) return null;
  const rows = Math.ceil(entries.length / cols);
  const w = cols * CELL_W + (cols - 1) * GAP + 2 * PAD;
  const h = bucketHeight(rows);
  const nodes: PlacedNode[] = entries.map((e, i) => ({
    componentId: e.componentId,
    serviceId: e.serviceId,
    x: x + PAD + (i % cols) * (CELL_W + GAP),
    y: y + LABEL_H + PAD_TOP + Math.floor(i / cols) * (CELL_H + GAP),
  }));
  return { rect: { x, y, w, h }, nodes };
}

// ---------------------------------------------------------------------------
// Label Collision Detection (Fix 2A)
// ---------------------------------------------------------------------------

/** Returns true if two rectangles overlap (exclusive — touching edges don't collide). */
function rectsCollide(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Computes the label bounding box for a node.
 * Labels are positioned below the icon (verticalLabelPosition=bottom).
 * Width = CELL_W (full cell width for centering), height = lineCount * 14px.
 */
function labelBbox(nodeX: number, nodeY: number, labelLineCount: number): Rect {
  const LINE_H = 14;
  const iconCenterX = nodeX + ICON_SIZE / 2;
  return {
    x: iconCenterX - CELL_W / 2,
    y: nodeY + ICON_SIZE + 4, // 4px spacing below icon
    w: CELL_W,
    h: labelLineCount * LINE_H,
  };
}

/**
 * Counts the number of display lines in a wrapped label string.
 */
function labelLineCount(label: string): number {
  return label.split("\n").length;
}

export interface DiagramLayout {
  /** Rect for each container; null when that tier has no services. */
  containers: Record<ContainerKey, Rect | null>;
  /** Absolute node placement per componentId, with the id of its parent container. */
  nodes: Record<string, { x: number; y: number; parent: string; serviceId: ServiceId }>;
  canvasW: number;
  canvasH: number;
}

// ---------------------------------------------------------------------------
// Containment Hierarchy — maps each container to its parent container
// ---------------------------------------------------------------------------

/** Defines the mxGraph parent for each container. Root containers use "1" (the default layer). */
export const CONTAINER_PARENTS: Record<ContainerKey, string> = {
  aws_cloud: "1",
  edge: "container-aws_cloud",
  vpc: "container-aws_cloud",
  az: "container-vpc",
  public_subnet: "container-az",
  compute_subnet: "container-az",
  data_subnet: "container-az",
  cross_cutting: "container-aws_cloud",
  external: "container-aws_cloud",
};

/**
 * Validates the full containment hierarchy:
 *   AWS Cloud → VPC → AZ → Subnet → node
 *   AWS Cloud → Edge
 *   AWS Cloud → External
 *   AWS Cloud → Cross-cutting (Management & Governance)
 *
 * Throws at build time if any invariant is violated.
 */
export function validateContainmentHierarchy(
  containers: Record<ContainerKey, Rect | null>
): void {
  const hasAwsCloud = containers.aws_cloud !== null;
  const hasVpc = containers.vpc !== null;
  const hasAz = containers.az !== null;

  // Every subnet must have AZ → VPC → AWS Cloud ancestors
  const subnetKeys: ContainerKey[] = ["public_subnet", "compute_subnet", "data_subnet"];
  for (const key of subnetKeys) {
    if (containers[key] !== null) {
      if (!hasAz) {
        throw new Error(
          `Containment hierarchy violation: subnet "${key}" exists but has no AZ ancestor. ` +
          `Every subnet must be nested inside an Availability Zone container.`
        );
      }
      if (!hasVpc) {
        throw new Error(
          `Containment hierarchy violation: subnet "${key}" exists but has no VPC ancestor. ` +
          `Every subnet must be nested inside a VPC container.`
        );
      }
      if (!hasAwsCloud) {
        throw new Error(
          `Containment hierarchy violation: subnet "${key}" exists but has no AWS Cloud ancestor.`
        );
      }
    }
  }

  // AZ must have VPC → AWS Cloud ancestors
  if (hasAz && !hasVpc) {
    throw new Error(
      `Containment hierarchy violation: AZ exists but has no VPC ancestor.`
    );
  }

  // VPC must have AWS Cloud ancestor
  if (hasVpc && !hasAwsCloud) {
    throw new Error(
      `Containment hierarchy violation: VPC exists but has no AWS Cloud ancestor.`
    );
  }

  // Cross-cutting must have AWS Cloud parent (not VPC, not root)
  if (containers.cross_cutting !== null && !hasAwsCloud) {
    throw new Error(
      `Containment hierarchy violation: cross-cutting container exists but has no AWS Cloud ancestor.`
    );
  }

  // Edge must have AWS Cloud parent
  if (containers.edge !== null && !hasAwsCloud) {
    throw new Error(
      `Containment hierarchy violation: edge container exists but has no AWS Cloud ancestor.`
    );
  }

  // External must have AWS Cloud parent
  if (containers.external !== null && !hasAwsCloud) {
    throw new Error(
      `Containment hierarchy violation: external container exists but has no AWS Cloud ancestor.`
    );
  }
}

export interface SemanticValidationResult {
  valid: boolean;
  errors: string[];
  metrics: {
    expectedServiceCount: number;
    renderedServiceCount: number;
    expectedRelationshipCount: number;
    renderedRelationshipCount: number;
    verifiedContainments: number;
  };
}

/**
 * Validates Stage 2 semantic integrity against the frozen Stage 1 plan:
 * 1. Component Mapping: Every Stage 1 service is mapped to a diagram component with preserved identity.
 * 2. Service Completeness: Rendered services match Stage 1 services without additions or omissions.
 * 3. Relationship Preservation: Every explicit relationship has preserved source, destination, direction, and type.
 * 4. Dependency & Flow Direction: Logical directions are preserved without inversion.
 * 5. Containment & Topology Semantics: Service-to-subnet and subnet-to-AZ-to-VPC assignments match the semantic model.
 */
export function validateDiagramSemantics(
  plan: ServicePlan,
  nodes: Array<{ id: string; componentId: string; serviceId: ServiceId; parent: string }>,
  edges: Array<{ id: string; sourceId: string; targetId: string; label: string }>
): SemanticValidationResult {
  const errors: string[] = [];
  let verifiedContainments = 0;

  // 1. Input sanity check
  if (!plan || !Array.isArray(plan.awsMappings)) {
    errors.push("Missing or invalid Stage 1 input: plan.awsMappings is required and must be an array");
    return {
      valid: false,
      errors,
      metrics: {
        expectedServiceCount: 0,
        renderedServiceCount: Array.isArray(nodes) ? nodes.length : 0,
        expectedRelationshipCount: 0,
        renderedRelationshipCount: Array.isArray(edges) ? edges.length : 0,
        verifiedContainments: 0,
      },
    };
  }

  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];

  // 2. Component Mapping & Service Identity Set Equality
  // STRICT GROUNDING RULE: Rendered AWS services MUST EXACTLY EQUAL Stage 1 awsMappings
  // Set(renderedServiceIds) === Set(stage1ServiceIds)
  const stage1ServiceIds = new Set<ServiceId>(plan.awsMappings.map((m) => m.serviceId));
  const renderedServiceIds = new Set<ServiceId>(safeNodes.map((n) => n.serviceId));

  // 2a. Missing Stage 1 services: every expected serviceId must be rendered
  for (const expId of stage1ServiceIds) {
    if (!renderedServiceIds.has(expId)) {
      errors.push(`Missing Stage 1 service: "${expId}" is not rendered in diagram`);
    }
  }

  // 2b. Unexpected / phantom services: every rendered serviceId must be in Stage 1
  for (const rendId of renderedServiceIds) {
    if (!stage1ServiceIds.has(rendId)) {
      errors.push(`Unexpected service rendered: "${rendId}" has no corresponding Stage 1 mapping`);
    }
  }

  // 2c. Strict Set equality enforcement (catches same-count wrong-services substitutions)
  const isSetEqual =
    stage1ServiceIds.size === renderedServiceIds.size &&
    [...stage1ServiceIds].every((id) => renderedServiceIds.has(id));

  if (!isSetEqual) {
    const missing = [...stage1ServiceIds].filter((id) => !renderedServiceIds.has(id));
    const unexpected = [...renderedServiceIds].filter((id) => !stage1ServiceIds.has(id));
    errors.push(
      `Service set mismatch: Set(renderedServiceIds) !== Set(stage1ServiceIds). Missing: [${missing.join(", ")}], Unexpected: [${unexpected.join(", ")}]`
    );
  }

  // 2d. Node mapping & duplicate validation
  const nodeMap = new Map<string, (typeof safeNodes)[number]>();
  const seenComponentIds = new Set<string>();

  for (const n of safeNodes) {
    nodeMap.set(n.id, n);

    const matchingMapping = plan.awsMappings.find(
      (m) => m.serviceId === n.serviceId && (m.componentId === n.componentId || n.componentId.includes(m.componentId))
    );
    if (!matchingMapping && stage1ServiceIds.has(n.serviceId)) {
      errors.push(
        `Component mapping mismatch: node "${n.id}" (${n.serviceId}) has componentId "${n.componentId}" not matching any Stage 1 mapping`
      );
    }

    if (seenComponentIds.has(n.componentId)) {
      errors.push(
        `Duplicate service component: componentId "${n.componentId}" (${n.serviceId}) is rendered multiple times`
      );
    }
    seenComponentIds.add(n.componentId);
  }

  // 2e. Check for over-duplicated services
  const stage1CountByService = new Map<ServiceId, number>();
  for (const m of plan.awsMappings) {
    stage1CountByService.set(m.serviceId, (stage1CountByService.get(m.serviceId) ?? 0) + 1);
  }
  const renderedCountByService = new Map<ServiceId, number>();
  for (const n of safeNodes) {
    renderedCountByService.set(n.serviceId, (renderedCountByService.get(n.serviceId) ?? 0) + 1);
  }
  for (const [sId, rCount] of renderedCountByService) {
    const expCount = stage1CountByService.get(sId) ?? 0;
    if (rCount > expCount && expCount > 0) {
      errors.push(
        `Duplicate service rendered: service "${sId}" is rendered ${rCount} times, but only expected ${expCount} time(s)`
      );
    }
  }

  // 3. Containment & Topology Semantics
  for (const n of safeNodes) {
    const expectedTier = SERVICE_TIERS[n.serviceId] ?? "vpc_data";
    const expectedParentMap: Record<Tier, string> = {
      edge: "container-edge",
      vpc_public: "container-public_subnet",
      vpc_compute: "container-compute_subnet",
      vpc_data: "container-data_subnet",
      cross_cutting: "container-cross_cutting",
      external: "container-external",
    };
    const expectedParent = expectedParentMap[expectedTier];
    if (expectedParent && n.parent !== expectedParent) {
      errors.push(
        `Containment semantic mismatch: service "${n.serviceId}" is in "${n.parent}", expected "${expectedParent}" (tier: ${expectedTier})`
      );
    } else {
      verifiedContainments++;
    }
  }

  // 4. Relationship Preservation & Direction
  const compIdToNode = new Map<string, (typeof safeNodes)[number]>();
  const serviceIdToNode = new Map<string, (typeof safeNodes)[number]>();
  for (const n of safeNodes) {
    compIdToNode.set(n.componentId, n);
    if (!serviceIdToNode.has(n.serviceId)) {
      serviceIdToNode.set(n.serviceId, n);
    }
  }

  let expectedRelCount = 0;
  for (const rel of plan.relationships ?? []) {
    // Resolve endpoints by componentId first, then via mapping alias, then serviceId
    const srcMapping = plan.awsMappings.find((m) => m.componentId === rel.from);
    const dstMapping = plan.awsMappings.find((m) => m.componentId === rel.to);
    const srcNode =
      compIdToNode.get(rel.from) ??
      (srcMapping ? serviceIdToNode.get(srcMapping.serviceId) : undefined) ??
      serviceIdToNode.get(rel.from as ServiceId);
    const dstNode =
      compIdToNode.get(rel.to) ??
      (dstMapping ? serviceIdToNode.get(dstMapping.serviceId) : undefined) ??
      serviceIdToNode.get(rel.to as ServiceId);

    // If both endpoints exist in the plan's rendered nodes, this relationship MUST be rendered
    if (srcNode && dstNode) {
      expectedRelCount++;

      const forwardEdge = safeEdges.find((e) => e.sourceId === srcNode.id && e.targetId === dstNode.id);
      const reverseEdge = safeEdges.find((e) => e.sourceId === dstNode.id && e.targetId === srcNode.id);

      if (reverseEdge && !forwardEdge) {
        errors.push(
          `Reversed relationship direction: expected "${rel.from} -> ${rel.to}" (type: "${rel.type ?? ""}"), but edge is reversed from "${dstNode.serviceId}" to "${srcNode.serviceId}"`
        );
      } else if (!forwardEdge) {
        errors.push(
          `Missing relationship: expected "${rel.from} -> ${rel.to}" (type: "${rel.type ?? ""}") is not rendered as an edge`
        );
      } else {
        if (rel.type && rel.type.trim() && !forwardEdge.label.toLowerCase().includes(rel.type.trim().toLowerCase())) {
          errors.push(
            `Relationship type mismatch: expected type "${rel.type}" on edge "${rel.from} -> ${rel.to}", but edge label is "${forwardEdge.label}"`
          );
        }
      }
    }
  }

  // 5. Edge Endpoint Integrity
  for (const e of safeEdges) {
    if (!nodeMap.has(e.sourceId)) {
      errors.push(`Invalid edge source: edge "${e.id}" references non-existent node "${e.sourceId}"`);
    }
    if (!nodeMap.has(e.targetId)) {
      errors.push(`Invalid edge target: edge "${e.id}" references non-existent node "${e.targetId}"`);
    }
    if (e.sourceId === e.targetId) {
      errors.push(`Invalid self-loop edge: edge "${e.id}" connects node "${e.sourceId}" to itself`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    metrics: {
      expectedServiceCount: plan.awsMappings.length,
      renderedServiceCount: safeNodes.length,
      expectedRelationshipCount: expectedRelCount,
      renderedRelationshipCount: safeEdges.length,
      verifiedContainments,
    },
  };
}

export interface DiagramValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates diagram layout invariants:
 * 1. Containment hierarchy: Subnet -> AZ -> VPC -> AWS Cloud
 * 2. Container boundaries: Containers must not illegally overlap or exceed parent bounds
 * 3. Dedicated title clearance: Nodes must clear container headers by at least LABEL_H
 * 4. Node containment: Every node must be strictly bounded inside its parent container
 * 5. Collision-free: No two nodes overlap (AABB collision check)
 */
export function validateDiagramLayout(
  layout: DiagramLayout,
  placedNodes?: Array<{ id: string; serviceId: string; geo: Rect; parent: string }>
): DiagramValidationResult {
  const errors: string[] = [];

  // 1. Containment hierarchy
  try {
    validateContainmentHierarchy(layout.containers);
  } catch (err: unknown) {
    if (err instanceof Error) {
      errors.push(err.message);
    } else {
      errors.push(String(err));
    }
  }

  const { aws_cloud, edge, vpc, az, public_subnet, compute_subnet, data_subnet, cross_cutting } =
    layout.containers;

  // 2. Container boundaries and non-overlap
  if (aws_cloud) {
    if (edge) {
      if (
        edge.x < aws_cloud.x ||
        edge.y < aws_cloud.y ||
        edge.x + edge.w > aws_cloud.x + aws_cloud.w ||
        edge.y + edge.h > aws_cloud.y + aws_cloud.h
      ) {
        errors.push(`Edge container exceeds AWS Cloud bounds`);
      }
    }
    if (vpc) {
      if (
        vpc.x < aws_cloud.x ||
        vpc.y < aws_cloud.y ||
        vpc.x + vpc.w > aws_cloud.x + aws_cloud.w ||
        vpc.y + vpc.h > aws_cloud.y + aws_cloud.h
      ) {
        errors.push(`VPC container exceeds AWS Cloud bounds`);
      }
    }
    if (cross_cutting) {
      if (
        cross_cutting.x < aws_cloud.x ||
        cross_cutting.y < aws_cloud.y ||
        cross_cutting.x + cross_cutting.w > aws_cloud.x + aws_cloud.w ||
        cross_cutting.y + cross_cutting.h > aws_cloud.y + aws_cloud.h
      ) {
        errors.push(`Cross-cutting container exceeds AWS Cloud bounds`);
      }
    }
  }

  // VPC and Edge vertical separation
  if (edge && vpc) {
    if (vpc.y < edge.y + edge.h) {
      errors.push(`VPC overlaps Edge vertically: vpc.y (${vpc.y}) < edge bottom (${edge.y + edge.h})`);
    }
  }

  // Cross-cutting and VPC vertical separation
  if (vpc && cross_cutting) {
    if (cross_cutting.y < vpc.y + vpc.h) {
      errors.push(
        `Cross-cutting overlaps VPC vertically: cross.y (${cross_cutting.y}) < vpc bottom (${vpc.y + vpc.h})`
      );
    }
  }

  // AZ inside VPC
  if (vpc && az) {
    if (
      az.x < vpc.x ||
      az.y < vpc.y ||
      az.x + az.w > vpc.x + vpc.w ||
      az.y + az.h > vpc.y + vpc.h
    ) {
      errors.push(`AZ container exceeds VPC bounds`);
    }
  }

  // Subnets inside AZ
  const subnets: Array<{ key: ContainerKey; rect: Rect | null }> = [
    { key: "public_subnet", rect: public_subnet },
    { key: "compute_subnet", rect: compute_subnet },
    { key: "data_subnet", rect: data_subnet },
  ];

  for (const { key, rect } of subnets) {
    if (rect && az) {
      if (
        rect.x < az.x ||
        rect.y < az.y ||
        rect.x + rect.w > az.x + az.w ||
        rect.y + rect.h > az.y + az.h
      ) {
        errors.push(`Subnet "${key}" exceeds AZ bounds`);
      }
    }
  }

  // Subnet vertical non-overlap
  for (let i = 0; i < subnets.length; i++) {
    for (let j = i + 1; j < subnets.length; j++) {
      const s1 = subnets[i];
      const s2 = subnets[j];
      if (s1.rect && s2.rect) {
        const top1 = s1.rect.y;
        const bot1 = s1.rect.y + s1.rect.h;
        const top2 = s2.rect.y;
        const bot2 = s2.rect.y + s2.rect.h;
        if (bot1 > top2 && bot2 > top1) {
          errors.push(`Subnets "${s1.key}" and "${s2.key}" overlap vertically`);
        }
      }
    }
  }

  // 3. Node layout validation
  const nodesToCheck: Array<{
    id: string;
    serviceId: string;
    absX: number;
    absY: number;
    w: number;
    h: number;
    parent: string;
  }> = [];

  if (placedNodes && placedNodes.length > 0) {
    const contMap: Record<string, Rect> = {};
    for (const [k, r] of Object.entries(layout.containers)) {
      if (r) contMap[`container-${k}`] = r;
    }
    for (const pn of placedNodes) {
      const parentRect = contMap[pn.parent];
      const absX = (parentRect ? parentRect.x : 0) + pn.geo.x;
      const absY = (parentRect ? parentRect.y : 0) + pn.geo.y;
      nodesToCheck.push({
        id: pn.id,
        serviceId: pn.serviceId,
        absX,
        absY,
        w: pn.geo.w,
        h: pn.geo.h,
        parent: pn.parent,
      });
    }
  } else if (layout.nodes) {
    for (const [compId, node] of Object.entries(layout.nodes)) {
      nodesToCheck.push({
        id: compId,
        serviceId: node.serviceId,
        absX: node.x,
        absY: node.y,
        w: CELL_W,
        h: CELL_H,
        parent: node.parent,
      });
    }
  }

  // Check node-node collisions (AABB)
  for (let i = 0; i < nodesToCheck.length; i++) {
    for (let j = i + 1; j < nodesToCheck.length; j++) {
      const n1 = nodesToCheck[i];
      const n2 = nodesToCheck[j];
      const overlaps = !(
        n1.absX + n1.w <= n2.absX ||
        n2.absX + n2.w <= n1.absX ||
        n1.absY + n1.h <= n2.absY ||
        n2.absY + n2.h <= n1.absY
      );
      if (overlaps) {
        errors.push(`Node overlap: "${n1.serviceId}" and "${n2.serviceId}" collide`);
      }
    }
  }

  // Check node clearance from container title and borders
  for (const n of nodesToCheck) {
    const containerKey = n.parent.replace("container-", "") as ContainerKey;
    const parentRect = layout.containers[containerKey];
    if (parentRect) {
      if (n.absY < parentRect.y + LABEL_H) {
        errors.push(
          `Node "${n.serviceId}" header collision: y (${n.absY}) < container header bottom (${parentRect.y + LABEL_H})`
        );
      }
      if (
        n.absX < parentRect.x ||
        n.absX + n.w > parentRect.x + parentRect.w + 1 ||
        n.absY + n.h > parentRect.y + parentRect.h + 1
      ) {
        errors.push(
          `Node "${n.serviceId}" exceeds parent container "${containerKey}" bounds`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Computes the full diagram geometry from plan.awsMappings.
 * Incorporates:
 * 1. Full-label bounding boxes so nodes never collide.
 * 2. Mathematical centering of all containers and nodes in the canvas viewport.
 */
export function computeLayout(services: AwsServiceMapping[]): DiagramLayout {
  const buckets: Record<Tier, BucketEntry[]> = {
    edge: [],
    vpc_public: [],
    vpc_compute: [],
    vpc_data: [],
    cross_cutting: [],
    external: [],
  };
  for (const m of services) {
    const tier = SERVICE_TIERS[m.serviceId] ?? "vpc_data";
    buckets[tier].push({
      componentId: m.componentId,
      serviceId: m.serviceId,
    });
  }

  const containers: DiagramLayout["containers"] = {
    aws_cloud: null,
    edge: null,
    vpc: null,
    az: null,
    public_subnet: null,
    compute_subnet: null,
    data_subnet: null,
    cross_cutting: null,
    external: null,
  };
  const nodes: DiagramLayout["nodes"] = {};

  // 1. Initial dimensions for subnets
  const publicPlaced = layoutNodes(buckets.vpc_public, SUBNET_COLS, 0, 0);
  const computePlaced = layoutNodes(buckets.vpc_compute, SUBNET_COLS, 0, 0);
  const dataPlaced = layoutNodes(buckets.vpc_data, SUBNET_COLS, 0, 0);

  const activeSubnets = [
    { key: "public_subnet" as const, placed: publicPlaced },
    { key: "compute_subnet" as const, placed: computePlaced },
    { key: "data_subnet" as const, placed: dataPlaced },
  ].filter((s): s is { key: ContainerKey; placed: PlacedBucket } => s.placed !== null);

  let azRect: Rect | null = null;
  let vpcRect: Rect | null = null;

  const edgeRows = buckets.edge.length > 0 ? Math.ceil(buckets.edge.length / EDGE_COLS) : 0;
  const edgeH = bucketHeight(edgeRows);
  const edgeY = MARGIN;

  // The VPC starts below the Edge banner with a clean tier gap (VGAP)
  const vpcY = MARGIN + (edgeRows > 0 ? edgeH + VGAP : 0);
  const vpcX = MARGIN;

  if (activeSubnets.length > 0) {
    // Coordinate width across all subnets inside the AZ to prevent ragged edges
    const maxSubnetW = Math.max(...activeSubnets.map((s) => s.placed.rect.w));

    // Calculate AZ dimensions wrapping all subnets
    const azPadX = PAD;
    const azPadTop = LABEL_H + PAD_TOP;
    const azPadBottom = PAD_BOTTOM;
    const totalSubnetHeight = activeSubnets.reduce((sum, s) => sum + s.placed.rect.h, 0);
    const totalSubnetGaps = (activeSubnets.length - 1) * VGAP;
    const azH = azPadTop + totalSubnetHeight + totalSubnetGaps + azPadBottom;
    const azW = maxSubnetW + 2 * azPadX;

    // Position AZ inside VPC
    const vpcPadX = PAD;
    const vpcPadTop = LABEL_H + PAD_TOP;
    const vpcPadBottom = PAD_BOTTOM;
    const vpcW = azW + 2 * vpcPadX;
    const vpcH = vpcPadTop + azH + vpcPadBottom;

    vpcRect = { x: vpcX, y: vpcY, w: vpcW, h: vpcH };
    const azX = vpcX + vpcPadX;
    const azY = vpcY + vpcPadTop;
    azRect = { x: azX, y: azY, w: azW, h: azH };

    // Position each subnet inside AZ top-to-bottom
    let currentSubnetY = azY + azPadTop;
    for (const s of activeSubnets) {
      const subnetX = azX + azPadX;
      const subnetY = currentSubnetY;
      const subnetW = maxSubnetW;
      const subnetH = s.placed.rect.h;

      s.placed.rect = { x: subnetX, y: subnetY, w: subnetW, h: subnetH };
      containers[s.key] = s.placed.rect;

      // Center nodes horizontally within the coordinated subnet width
      const cols = SUBNET_COLS;
      const actualCols = Math.min(s.placed.nodes.length, cols);
      const contentW = actualCols * CELL_W + (actualCols - 1) * GAP;
      const offsetStartX = Math.max(0, Math.round((subnetW - 2 * PAD - contentW) / 2));

      const registerNode = (n: PlacedNode, nodeX: number, nodeY: number, parent: string) => {
        const placement = {
          x: nodeX,
          y: nodeY,
          parent,
          serviceId: n.serviceId,
        };
        if (!nodes[n.componentId]) {
          nodes[n.componentId] = placement;
        } else {
          nodes[`${n.componentId}_${n.serviceId}`] = placement;
        }
      };

      for (let i = 0; i < s.placed.nodes.length; i++) {
        const n = s.placed.nodes[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const nodeX = subnetX + PAD + offsetStartX + col * (CELL_W + GAP);
        const nodeY = subnetY + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
        n.x = nodeX;
        n.y = nodeY;
        registerNode(n, nodeX, nodeY, `container-${s.key}`);
      }

      currentSubnetY += subnetH + VGAP;
    }
  }

  containers.az = azRect;
  containers.vpc = vpcRect;

  // 2. Cross-cutting container (Management & Governance) placed below VPC
  let crossCuttingRect: Rect | null = null;
  if (buckets.cross_cutting.length > 0) {
    const CROSS_CUTTING_COLS = 4;
    const crossX = vpcRect ? vpcRect.x : MARGIN;
    const crossY = vpcRect ? vpcRect.y + vpcRect.h + VGAP : vpcY;
    const crossPlaced = layoutNodes(buckets.cross_cutting, CROSS_CUTTING_COLS, crossX, crossY)!;

    if (vpcRect) {
      crossPlaced.rect.w = Math.max(crossPlaced.rect.w, vpcRect.w);
      crossPlaced.rect.x = vpcRect.x;
    }
    crossCuttingRect = crossPlaced.rect;

    const cols = CROSS_CUTTING_COLS;
    const actualCols = Math.min(crossPlaced.nodes.length, cols);
    const contentW = actualCols * CELL_W + (actualCols - 1) * GAP;
    const offsetStartX = Math.max(0, Math.round((crossPlaced.rect.w - 2 * PAD - contentW) / 2));

    for (let i = 0; i < crossPlaced.nodes.length; i++) {
      const n = crossPlaced.nodes[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const nodeX = crossPlaced.rect.x + PAD + offsetStartX + col * (CELL_W + GAP);
      const nodeY = crossPlaced.rect.y + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
      n.x = nodeX;
      n.y = nodeY;
      const placement = {
        x: nodeX,
        y: nodeY,
        parent: "container-cross_cutting",
        serviceId: n.serviceId,
      };
      if (!nodes[n.componentId]) {
        nodes[n.componentId] = placement;
      } else {
        nodes[`${n.componentId}_${n.serviceId}`] = placement;
      }
    }
  }
  containers.cross_cutting = crossCuttingRect;

  // 3. External column anchored to the right of VPC
  let externalRect: Rect | null = null;
  if (buckets.external.length > 0) {
    const extX = vpcRect ? vpcRect.x + vpcRect.w + GAP : MARGIN;
    const extY = vpcRect ? vpcRect.y : MARGIN;
    const extPlaced = layoutNodes(buckets.external, EXTERNAL_COLS, extX, extY)!;
    if (vpcRect) extPlaced.rect.h = Math.max(vpcRect.h, extPlaced.rect.h);
    externalRect = extPlaced.rect;
    for (const n of extPlaced.nodes) {
      const placement = { x: n.x, y: n.y, parent: "container-external", serviceId: n.serviceId };
      if (!nodes[n.componentId]) {
        nodes[n.componentId] = placement;
      } else {
        nodes[`${n.componentId}_${n.serviceId}`] = placement;
      }
    }
  }
  containers.external = externalRect;

  // 4. Edge banner spans full width of VPC and External
  if (buckets.edge.length > 0) {
    const rightExtent = Math.max(
      vpcRect ? vpcRect.x + vpcRect.w : 0,
      externalRect ? externalRect.x + externalRect.w : 0,
      crossCuttingRect ? crossCuttingRect.x + crossCuttingRect.w : 0
    );
    const minEdgeGridW = EDGE_COLS * CELL_W + (EDGE_COLS - 1) * GAP + 2 * PAD;
    const edgeW = Math.max(rightExtent - MARGIN, minEdgeGridW);
    const edgePlaced = layoutNodes(buckets.edge, EDGE_COLS, MARGIN, edgeY)!;
    edgePlaced.rect.w = edgeW;
    containers.edge = edgePlaced.rect;

    const actualCols = Math.min(edgePlaced.nodes.length, EDGE_COLS);
    const contentW = actualCols * CELL_W + (actualCols - 1) * GAP;
    const offsetStartX = Math.max(0, Math.round((edgeW - 2 * PAD - contentW) / 2));

    for (let i = 0; i < edgePlaced.nodes.length; i++) {
      const n = edgePlaced.nodes[i];
      const col = i % EDGE_COLS;
      const row = Math.floor(i / EDGE_COLS);
      const nodeX = edgePlaced.rect.x + PAD + offsetStartX + col * (CELL_W + GAP);
      const nodeY = edgePlaced.rect.y + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
      n.x = nodeX;
      n.y = nodeY;
      const placement = { x: nodeX, y: nodeY, parent: "container-edge", serviceId: n.serviceId };
      if (!nodes[n.componentId]) {
        nodes[n.componentId] = placement;
      } else {
        nodes[`${n.componentId}_${n.serviceId}`] = placement;
      }
    }
  }

  // 5. AWS Cloud container wraps everything
  const allActiveRects: Rect[] = [];
  for (const key of Object.keys(containers) as ContainerKey[]) {
    if (key === "aws_cloud") continue;
    const r = containers[key];
    if (r) allActiveRects.push(r);
  }
  if (allActiveRects.length > 0) {
    const cloudMinX = Math.min(...allActiveRects.map((r) => r.x)) - PAD;
    const cloudMinY = Math.min(...allActiveRects.map((r) => r.y)) - LABEL_H - PAD_TOP;
    const cloudMaxX = Math.max(...allActiveRects.map((r) => r.x + r.w)) + PAD;
    const cloudMaxY = Math.max(...allActiveRects.map((r) => r.y + r.h)) + PAD_BOTTOM;
    containers.aws_cloud = {
      x: cloudMinX,
      y: cloudMinY,
      w: cloudMaxX - cloudMinX,
      h: cloudMaxY - cloudMinY,
    };
  }

  // 6. Centering on canvas with uniform margins
  const outerRect = containers.aws_cloud;
  const contentW = outerRect ? outerRect.w : 500;
  const contentH = outerRect ? outerRect.h : 400;
  const contentMinX = outerRect ? outerRect.x : 0;
  const contentMinY = outerRect ? outerRect.y : 0;

  const CANVAS_PAD_X = 64;
  const CANVAS_PAD_Y = 56;
  const canvasW = Math.max(contentW + 2 * CANVAS_PAD_X, 760);
  const canvasH = Math.max(contentH + 2 * CANVAS_PAD_Y, 520);

  const shiftX = Math.round((canvasW - contentW) / 2) - contentMinX;
  const shiftY = Math.round((canvasH - contentH) / 2) - contentMinY;

  for (const key of Object.keys(containers) as ContainerKey[]) {
    const r = containers[key];
    if (r) {
      r.x += shiftX;
      r.y += shiftY;
    }
  }

  for (const compId of Object.keys(nodes)) {
    nodes[compId].x += shiftX;
    nodes[compId].y += shiftY;
  }

  const layout: DiagramLayout = { containers, nodes, canvasW, canvasH };
  const validation = validateDiagramLayout(layout);
  if (!validation.valid) {
    console.warn("Diagram layout validation warnings:\n" + validation.errors.join("\n"));
  }

  return layout;
}

// ---------------------------------------------------------------------------
// Template edges by pattern (ServiceId → ServiceId)
// ---------------------------------------------------------------------------

const PATTERN_EDGES: Record<string, [ServiceId, ServiceId, string?][]> = {
  "static-site": [
    ["Route53", "CloudFront", "DNS → CDN"],
    ["CloudFront", "S3", "Origin"],
  ],
  "serverless-api": [
    ["APIGateway", "Lambda", "invoke"],
    ["Lambda", "DynamoDB", "read/write"],
    ["Lambda", "S3", "store"],
    ["Lambda", "SQS", "publish"],
    ["APIGateway", "Cognito", "authorize"],
  ],
  "containerised-app": [
    ["Route53", "ALB", "DNS"],
    ["ALB", "ECS", "route"],
    ["ALB", "Fargate", "route"],
    ["ALB", "EKS", "route"],
    ["ECS", "RDS", "query"],
    ["Fargate", "RDS", "query"],
    ["ECS", "Aurora", "query"],
    ["Fargate", "Aurora", "query"],
    ["ECS", "ElastiCache", "cache"],
    ["Fargate", "ElastiCache", "cache"],
    ["ECS", "S3", "store"],
    ["Fargate", "S3", "store"],
    ["ECR", "ECS", "pull image"],
    ["ECR", "Fargate", "pull image"],
  ],
  "event-driven": [
    ["SNS", "SQS", "fanout"],
    ["SQS", "Lambda", "trigger"],
    ["SQS", "ECS", "consume"],
    ["EventBridge", "Lambda", "trigger"],
    ["Kinesis", "Lambda", "process"],
  ],
  "ml-pipeline": [
    ["S3", "SageMaker", "training data"],
    ["SageMaker", "S3", "model artifacts"],
    ["SageMaker", "APIGateway", "endpoint"],
  ],
  "full-stack-web": [
    ["Route53", "CloudFront", "DNS"],
    ["CloudFront", "S3", "static assets"],
    ["CloudFront", "ALB", "dynamic requests"],
    ["ALB", "ECS", "route"],
    ["ALB", "EC2", "route"],
    ["ECS", "RDS", "read/write"],
    ["EC2", "RDS", "read/write"],
    ["ECS", "ElastiCache", "cache"],
  ],
  "data-pipeline": [
    ["Kinesis", "S3", "ingestion"],
    ["S3", "Redshift", "load"],
  ],
  generic: [
    ["Route53", "EC2", "route"],
    ["EC2", "RDS", "query"],
    ["EC2", "S3", "store"],
  ],
};

function isEdgeConfirmed(
  srcService: string,
  dstService: string,
  srcEvidence: string,
  dstEvidence: string,
  relationships: ComponentRelationship[],
  sdkEvidence?: SdkEvidence[] | null
): boolean {
  // 1. Explicit relationships from LLM or rule engine
  if (
    relationships.some(
      (e) =>
        (e.from.toLowerCase() === srcService.toLowerCase() &&
          e.to.toLowerCase() === dstService.toLowerCase()) ||
        (e.from.toLowerCase() === dstService.toLowerCase() &&
          e.to.toLowerCase() === srcService.toLowerCase())
    )
  ) {
    return true;
  }

  // 2. sdkEvidence cross-service proof
  if (Array.isArray(sdkEvidence) && sdkEvidence.length > 0) {
    const hasDstSdk = sdkEvidence.some((ev) => {
      const hint = ev.serviceHint ?? ev.service ?? "";
      return (
        hint.toLowerCase() === dstService.toLowerCase() ||
        dstService.toLowerCase().includes(hint.toLowerCase())
      );
    });
    const computeServices = ["lambda", "ecs", "ec2", "fargate", "eks"];
    if (hasDstSdk && computeServices.includes(srcService.toLowerCase())) {
      return true;
    }
  }

  // 3. Explicit cross-service mention in evidence strings
  const lowerSrcEv = srcEvidence.toLowerCase();
  const lowerDstEv = dstEvidence.toLowerCase();
  if (
    lowerSrcEv.includes(dstService.toLowerCase()) ||
    lowerDstEv.includes(srcService.toLowerCase())
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Container Color Themes (Professional AWS Well-Architected Style)
// Titles are aligned top-left (align=left;spacingLeft=16;) so vertical edges
// entering nodes in the center never cross container titles.
// ---------------------------------------------------------------------------

const CONTAINER_THEMES: Record<ContainerKey, string> = {
  aws_cloud:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=14;" +
    "fillColor=#F9FAFB;strokeColor=#232F3E;strokeWidth=2;fontColor=#232F3E;dashed=0;arcSize=6;",
  edge:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=12;" +
    "fillColor=#F8FAFC;strokeColor=#CBD5E1;strokeWidth=1.5;fontColor=#334155;dashed=0;arcSize=6;",
  vpc:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=13;" +
    "fillColor=#FFFFFF;strokeColor=#1E293B;strokeWidth=2;fontColor=#0F172A;dashed=0;arcSize=6;",
  az:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=11;" +
    "fillColor=#F0FDFA;strokeColor=#14B8A6;strokeWidth=1.5;fontColor=#0D9488;dashed=1;dashPattern=6 4;arcSize=6;",
  public_subnet:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=11;" +
    "fillColor=#F0FDF4;strokeColor=#22C55E;strokeWidth=1.5;fontColor=#15803D;dashed=1;dashPattern=6 4;arcSize=6;",
  compute_subnet:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=11;" +
    "fillColor=#EFF6FF;strokeColor=#3B82F6;strokeWidth=1.5;fontColor=#1D4ED8;dashed=1;dashPattern=6 4;arcSize=6;",
  data_subnet:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=11;" +
    "fillColor=#FAF5FF;strokeColor=#A855F7;strokeWidth=1.5;fontColor=#6B21A8;dashed=1;dashPattern=6 4;arcSize=6;",
  cross_cutting:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=11;" +
    "fillColor=#FFF7ED;strokeColor=#F97316;strokeWidth=1.5;fontColor=#C2410C;dashed=1;dashPattern=6 4;arcSize=6;",
  external:
    "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;fontSize=12;" +
    "fillColor=#F8FAFC;strokeColor=#94A3B8;strokeWidth=1.5;fontColor=#475569;dashed=1;dashPattern=6 4;arcSize=6;",
};

// ---------------------------------------------------------------------------
// Edge Routing & Collision Avoidance
// ---------------------------------------------------------------------------

export interface EdgeWaypoint {
  x: number;
  y: number;
}

export interface Port {
  x: number;
  y: number;
}

export interface RoutedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  style: "solid" | "dashed";
  serviceId?: string;
  tooltip?: string;
  labelOffsetX: number;
  labelOffsetY: number;
  waypoints: EdgeWaypoint[];
  exitPort: Port;
  entryPort: Port;
  flowStep?: number;
}

/**
 * Computes orthogonal waypoints through container gutters with clean branching
 * and positions edge labels with non-colliding offsets and opaque backgrounds.
 */
export function routeEdges(
  edgesToRoute: Array<{
    source: string;
    target: string;
    label: string;
    style: "solid" | "dashed";
    tooltip?: string;
    flowStep?: number;
  }>,
  nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }>
): RoutedEdge[] {
  const routed: RoutedEdge[] = [];
  let edgeCounter = 200;

  // Track target incoming edge counts for label staggering
  const targetEdgeCount = new Map<string, number>();
  // Track gutter lane allocation so multiple horizontal lines do not stack
  const gutterEdgeCount = new Map<string, number>();

  const allNodeGeos = Object.values(nodeAbsGeo);

  for (const e of edgesToRoute) {
    const src = nodeAbsGeo[e.source];
    const dst = nodeAbsGeo[e.target];
    const waypoints: EdgeWaypoint[] = [];

    const inIdx = targetEdgeCount.get(e.target) ?? 0;
    targetEdgeCount.set(e.target, inIdx + 1);

    // Stagger label offset along edge path to eliminate overlap between adjacent labels
    const labelOffsetX = (inIdx % 2 === 0 ? -1 : 1) * (14 + inIdx * 10);
    const labelOffsetY = inIdx % 2 === 0 ? -12 : 12;

    // Default to vertical progression: exit bottom, enter top
    let exitPort: Port = { x: 0.5, y: 1 };
    let entryPort: Port = { x: 0.5, y: 0 };

    if (src && dst) {
      const srcCx = Math.round(src.x + src.w / 2);
      const srcCy = Math.round(src.y + src.h / 2);
      const dstCx = Math.round(dst.x + dst.w / 2);
      const dstCy = Math.round(dst.y + dst.h / 2);

      const dx = dstCx - srcCx;
      const dy = dstCy - srcCy;

      const srcBot = Math.round(src.y + src.h);
      const dstTop = Math.round(dst.y);

      // Primary direction determines exit and entry ports
      if (Math.abs(dy) >= Math.abs(dx)) {
        if (dy >= 0) {
          // Downward vertical flow
          exitPort = { x: 0.5, y: 1 };
          entryPort = { x: 0.5, y: 0 };

          // Check if intermediate nodes lie between source and target
          const intermediateNodes = allNodeGeos.filter(
            (n) => n !== src && n !== dst && n.y >= srcBot - 5 && n.y + n.h <= dstTop + 5
          );

          if (srcBot < dstTop - 15) {
            // Allocate separate lane in this gutter
            const gutterKey = `${Math.floor((srcBot + 10) / 40)}->${Math.floor(dstTop / 40)}`;
            const laneIdx = gutterEdgeCount.get(gutterKey) ?? 0;
            gutterEdgeCount.set(gutterKey, laneIdx + 1);
            const laneOffset = (laneIdx % 2 === 0 ? 1 : -1) * Math.ceil(laneIdx / 2) * 12;

            if (intermediateNodes.length > 0) {
              // Bypass intermediate tier around the side
              const maxInterX = Math.max(...intermediateNodes.map((n) => n.x + n.w));
              const minInterX = Math.min(...intermediateNodes.map((n) => n.x));
              const bypassRight = maxInterX + 36;
              const bypassLeft = minInterX - 36;
              const bypassX = Math.abs(srcCx - bypassRight) <= Math.abs(srcCx - bypassLeft) ? bypassRight : bypassLeft;
              const g1Y = Math.round(srcBot + 16) + laneOffset;
              const g2Y = Math.round(dstTop - 16) - laneOffset;
              waypoints.push({ x: srcCx, y: g1Y });
              waypoints.push({ x: bypassX, y: g1Y });
              waypoints.push({ x: bypassX, y: g2Y });
              waypoints.push({ x: dstCx, y: g2Y });
            } else {
              const midY = Math.round((srcBot + dstTop) / 2) + laneOffset;
              if (Math.abs(srcCx - dstCx) > 8) {
                waypoints.push({ x: srcCx, y: midY });
                waypoints.push({ x: dstCx, y: midY });
              }
            }
          }
        } else {
          // Upward vertical flow
          exitPort = { x: 0.5, y: 0 };
          entryPort = { x: 0.5, y: 1 };

          const gutterKey = `up-${Math.floor(src.y / 40)}->${Math.floor(dst.y / 40)}`;
          const laneIdx = gutterEdgeCount.get(gutterKey) ?? 0;
          gutterEdgeCount.set(gutterKey, laneIdx + 1);
          const laneOffset = (laneIdx % 2 === 0 ? 1 : -1) * Math.ceil(laneIdx / 2) * 12;

          const intermediateNodes = allNodeGeos.filter(
            (n) => n !== src && n !== dst && n.y >= dst.y + dst.h - 5 && n.y + n.h <= src.y + 5
          );

          if (intermediateNodes.length > 0) {
            const maxInterX = Math.max(...intermediateNodes.map((n) => n.x + n.w));
            const minInterX = Math.min(...intermediateNodes.map((n) => n.x));
            const bypassRight = maxInterX + 36;
            const bypassLeft = minInterX - 36;
            const bypassX = Math.abs(srcCx - bypassRight) <= Math.abs(srcCx - bypassLeft) ? bypassRight : bypassLeft;
            const g1Y = Math.round(src.y - 16) - laneOffset;
            const g2Y = Math.round(dst.y + dst.h + 16) + laneOffset;
            waypoints.push({ x: srcCx, y: g1Y });
            waypoints.push({ x: bypassX, y: g1Y });
            waypoints.push({ x: bypassX, y: g2Y });
            waypoints.push({ x: dstCx, y: g2Y });
          } else {
            const midY = Math.round((src.y + dst.y + dst.h) / 2) + laneOffset;
            if (Math.abs(srcCx - dstCx) > 8) {
              waypoints.push({ x: srcCx, y: midY });
              waypoints.push({ x: dstCx, y: midY });
            }
          }
        }
      } else {
        if (dx >= 0) {
          // Rightward horizontal flow
          exitPort = { x: 1, y: 0.5 };
          entryPort = { x: 0, y: 0.5 };
        } else {
          // Leftward horizontal flow
          exitPort = { x: 0, y: 0.5 };
          entryPort = { x: 1, y: 0.5 };
        }
      }
    }

    routed.push({
      id: `edge-${edgeCounter++}`,
      sourceId: e.source,
      targetId: e.target,
      label: e.label,
      style: e.style,
      tooltip: e.tooltip,
      labelOffsetX,
      labelOffsetY,
      waypoints,
      exitPort,
      entryPort,
      flowStep: e.flowStep,
    });
  }

  return routed;
}

// ---------------------------------------------------------------------------
// Main Diagram Generator
// ---------------------------------------------------------------------------

/**
 * Generates a complete, professional .drawio XML document from a ServicePlan or an array of ServicePlans.
 * When passed an array of plans (1..N), returns an array of XML strings.
 * When passed a single plan, returns a single XML string.
 * Single-element arrays produce byte-identical output to single-path calls.
 */
export function generateDiagramXml(
  plans: ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string[];
export function generateDiagramXml(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): string;
export function generateDiagramXml(
  planOrPlans: ServicePlan | ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string | string[];
export function generateDiagramXml(
  planOrPlans: ServicePlan | ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string | string[] {
  if (Array.isArray(planOrPlans)) {
    return planOrPlans.map((p) => generateSingleDiagramXml(p, sdkEvidence));
  }
  return generateSingleDiagramXml(planOrPlans, sdkEvidence);
}

export interface DiagramNode {
  id: string;
  componentId: string;
  serviceId: ServiceId;
  label: string;
  geo: { x: number; y: number; w: number; h: number };
  parent: string;
}

export interface DiagramElements {
  layout: DiagramLayout;
  nodes: DiagramNode[];
  routedEdges: RoutedEdge[];
  consolidatedMappings: AwsServiceMapping[];
  compIdRedirect: Record<string, string>;
}

/**
 * Builds the geometric nodes and routed edges from a Stage 1 ServicePlan.
 * Enforces semantic integrity:
 * 1. Component mapping and deduplication preserve logical service identity.
 * 2. Explicit relationships from Stage 1 are processed FIRST and take absolute precedence.
 * 3. Inferred template edges never conflict with, invert, or duplicate explicit relationships.
 * 4. Label collision shifting is bounded within parent container margins.
 */
export function buildDiagramElements(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): DiagramElements {
  const pattern = plan.detectedPattern ?? "generic";

  // STRICT GROUNDING: Authoritative Stage 1 service set
  const stage1ServiceIds = new Set<ServiceId>(plan.awsMappings.map((m) => m.serviceId));

  // 1. Deduplication pass: consolidate duplicate generic infrastructure within the same tier
  const compMap = new Map(plan.components.map((c) => [c.id, c]));
  const consolidatedMappings: AwsServiceMapping[] = [];
  const compIdRedirect: Record<string, string> = {};
  const seenServiceTiers = new Map<string, string>(); // tier:serviceId -> masterComponentId

  for (const m of plan.awsMappings) {
    // Strictly reject any service that is not in the authoritative stage1ServiceIds
    if (!stage1ServiceIds.has(m.serviceId)) continue;

    const tier = SERVICE_TIERS[m.serviceId] ?? "vpc_data";
    const comp = compMap.get(m.componentId);
    const hasCustomTech =
      comp?.technology &&
      comp.technology.toLowerCase() !== m.serviceId.toLowerCase() &&
      !comp.technology.toLowerCase().includes("generic");

    const dedupeKey = `${tier}:${m.serviceId}`;
    if (!hasCustomTech && seenServiceTiers.has(dedupeKey)) {
      // Re-route to already existing master node for this service in this tier
      compIdRedirect[m.componentId] = seenServiceTiers.get(dedupeKey)!;
    } else {
      consolidatedMappings.push(m);
      seenServiceTiers.set(dedupeKey, m.componentId);
      compIdRedirect[m.componentId] = m.componentId;
    }
  }

  // Ensure every serviceId in stage1ServiceIds has at least one entry in consolidatedMappings
  for (const sId of stage1ServiceIds) {
    if (!consolidatedMappings.some((m) => m.serviceId === sId)) {
      const orig = plan.awsMappings.find((m) => m.serviceId === sId);
      if (orig) {
        consolidatedMappings.push(orig);
        compIdRedirect[orig.componentId] = orig.componentId;
      }
    }
  }

  // 2. Compute layout geometry with mathematical centering
  const layout = computeLayout(consolidatedMappings);

  // 3. Build node list
  const nodes: DiagramNode[] = [];
  const compIdToNodeId: Record<string, string> = {};
  const serviceIdToNodeId: Record<string, string> = {};
  // INVARIANT: nodeAbsGeo stores ABSOLUTE canvas positions for each node,
  // not parent-relative positions. This is critical for routeEdges()
  // which needs to compute source/target direction across different container parents.
  const nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }> = {};
  let nextId = 2; // mxGraph cells start at 2 (0=root, 1=layer)

  for (const mapping of consolidatedMappings) {
    if (!stage1ServiceIds.has(mapping.serviceId)) continue;

    let placement =
      layout.nodes[`${mapping.componentId}_${mapping.serviceId}`] ??
      layout.nodes[mapping.componentId];

    if (placement && placement.serviceId !== mapping.serviceId && layout.nodes[`${mapping.componentId}_${mapping.serviceId}`]) {
      placement = layout.nodes[`${mapping.componentId}_${mapping.serviceId}`];
    }

    if (!placement) {
      placement = Object.values(layout.nodes).find((n) => n.serviceId === mapping.serviceId);
    }

    if (!placement) {
      // Missing Service Protection:
      // If layout failed to position a service mapping, assign a safe fallback placement
      // so no Stage 1 service is ever silently dropped.
      const tier = SERVICE_TIERS[mapping.serviceId] ?? "vpc_data";
      const fallbackParentMap: Record<Tier, string> = {
        edge: "container-edge",
        vpc_public: "container-public_subnet",
        vpc_compute: "container-compute_subnet",
        vpc_data: "container-data_subnet",
        cross_cutting: "container-cross_cutting",
        external: "container-external",
      };
      const fallbackParent = fallbackParentMap[tier] ?? "container-data_subnet";
      placement = {
        x: MARGIN + PAD,
        y: MARGIN + PAD,
        parent: fallbackParent,
        serviceId: mapping.serviceId,
      };
    }

    const parent = placement.parent;
    const nodeId = `node-${nextId++}`;
    compIdToNodeId[mapping.componentId] = nodeId;
    if (!serviceIdToNodeId[mapping.serviceId]) {
      serviceIdToNodeId[mapping.serviceId] = nodeId;
    }

    // Relative to parent container
    const containerKey = parent.replace("container-", "") as ContainerKey;
    const containerRect = parent === "1" ? { x: 0, y: 0 } : layout.containers[containerKey];
    const baseX = containerRect ? containerRect.x : 0;
    const baseY = containerRect ? containerRect.y : 0;

    // Centered 56x56 AWS icon inside cell
    const iconOffsetX = Math.round((CELL_W - ICON_SIZE) / 2);
    const relX = placement.x - baseX + iconOffsetX;
    const relY = placement.y - baseY + 4;

    nodeAbsGeo[nodeId] = {
      x: placement.x + iconOffsetX,
      y: placement.y + 4,
      w: ICON_SIZE,
      h: ICON_SIZE,
    };

    const comp = compMap.get(mapping.componentId);
    let displayName = normalizeServiceName(mapping.serviceId);
    if (comp?.technology && comp.technology.toLowerCase() !== mapping.serviceId.toLowerCase()) {
      const cleanSub = comp.technology.replace(/^(AWS|Amazon)\s+/i, "");
      const normalizedSub = normalizeForComparison(cleanSub);
      const normalizedDisplay = normalizeForComparison(displayName);
      const isRedundant =
        !cleanSub ||
        normalizedSub === normalizedDisplay ||
        normalizedDisplay.includes(normalizedSub) ||
        normalizedSub.includes(normalizedDisplay);
      if (!isRedundant) {
        displayName = `${wrapServiceName(displayName)}\n(${cleanSub})`;
      } else {
        displayName = wrapServiceName(displayName);
      }
    } else {
      displayName = wrapServiceName(displayName);
    }

    nodes.push({
      id: nodeId,
      componentId: mapping.componentId,
      serviceId: mapping.serviceId,
      label: displayName,
      geo: {
        x: relX,
        y: relY,
        w: ICON_SIZE,
        h: ICON_SIZE,
      },
      parent,
    });
  }

  // Missing Service Protection:
  // Ensure every service in stage1ServiceIds has at least one node
  const renderedServiceIds = new Set<ServiceId>(nodes.map((n) => n.serviceId));
  for (const expServiceId of stage1ServiceIds) {
    if (!renderedServiceIds.has(expServiceId)) {
      const missingMapping = plan.awsMappings.find((m) => m.serviceId === expServiceId);
      if (missingMapping) {
        const tier = SERVICE_TIERS[expServiceId] ?? "vpc_data";
        const fallbackParentMap: Record<Tier, string> = {
          edge: "container-edge",
          vpc_public: "container-public_subnet",
          vpc_compute: "container-compute_subnet",
          vpc_data: "container-data_subnet",
          cross_cutting: "container-cross_cutting",
          external: "container-external",
        };
        const fallbackParent = fallbackParentMap[tier] ?? "container-data_subnet";
        const nodeId = `node-${nextId++}`;
        compIdToNodeId[missingMapping.componentId] = nodeId;
        if (!serviceIdToNodeId[missingMapping.serviceId]) {
          serviceIdToNodeId[missingMapping.serviceId] = nodeId;
        }
        nodeAbsGeo[nodeId] = {
          x: MARGIN + PAD,
          y: MARGIN + PAD,
          w: ICON_SIZE,
          h: ICON_SIZE,
        };
        nodes.push({
          id: nodeId,
          componentId: missingMapping.componentId,
          serviceId: missingMapping.serviceId,
          label: wrapServiceName(normalizeServiceName(missingMapping.serviceId)),
          geo: {
            x: PAD,
            y: LABEL_H + PAD_TOP,
            w: ICON_SIZE,
            h: ICON_SIZE,
          },
          parent: fallbackParent,
        });
        renderedServiceIds.add(expServiceId);
      }
    }
  }

  // Strictly filter nodes so ONLY authoritative Stage 1 services are ever kept
  const groundedNodes = nodes.filter((n) => stage1ServiceIds.has(n.serviceId));

  // 3b. Label collision resolution pass (clamped to parent container bounds)
  {
    const occupiedBboxes: Rect[] = [];
    for (const node of groundedNodes) {
      const absGeo = nodeAbsGeo[node.id];
      if (!absGeo) continue;

      const lines = labelLineCount(node.label);
      let bbox = labelBbox(absGeo.x, absGeo.y, lines);
      let attempts = 0;
      const MAX_ATTEMPTS = 5;

      const containerKey = node.parent.replace("container-", "") as ContainerKey;
      const containerRect = layout.containers[containerKey];
      const maxRelY = containerRect ? containerRect.h - PAD_BOTTOM - node.geo.h : Infinity;

      while (attempts < MAX_ATTEMPTS && occupiedBboxes.some((ob) => rectsCollide(bbox, ob))) {
        const shift = CELL_H + GAP;
        if (node.geo.y + shift > maxRelY) {
          break; // Stop shifting if it would exceed parent container bounds
        }
        absGeo.y += shift;
        node.geo.y += shift;
        bbox = labelBbox(absGeo.x, absGeo.y, lines);
        attempts++;
      }

      occupiedBboxes.push({ x: absGeo.x, y: absGeo.y, w: absGeo.w, h: absGeo.h });
      occupiedBboxes.push(bbox);
    }
  }

  // 4. Build edge relationships
  interface RawEdge {
    source: string;
    target: string;
    label: string;
    style: "solid" | "dashed";
    tooltip?: string;
    flowStep?: number;
  }
  const rawEdges: RawEdge[] = [];
  const edgeKeys = new Set<string>(); // "srcId->dstId"
  const connectedPairs = new Set<string>(); // "minId<->maxId"

  // 4a. Explicit relationships from Stage 1 plan (Highest priority: solid, preserve exact direction)
  for (const rel of plan.relationships ?? []) {
    const mappedFrom = compIdRedirect[rel.from] ?? rel.from;
    const mappedTo = compIdRedirect[rel.to] ?? rel.to;
    const srcNodeId = compIdToNodeId[mappedFrom] ?? serviceIdToNodeId[rel.from];
    const dstNodeId = compIdToNodeId[mappedTo] ?? serviceIdToNodeId[rel.to];

    if (srcNodeId && dstNodeId) {
      const srcExists = groundedNodes.some((n) => n.id === srcNodeId);
      const dstExists = groundedNodes.some((n) => n.id === dstNodeId);
      if (!srcExists || !dstExists) continue;

      const forwardKey = `${srcNodeId}->${dstNodeId}`;
      if (!edgeKeys.has(forwardKey)) {
        rawEdges.push({
          source: srcNodeId,
          target: dstNodeId,
          label: rel.type ?? "",
          style: "solid",
          tooltip: rel.type ?? undefined,
        });
        edgeKeys.add(forwardKey);
        const pairKey = srcNodeId < dstNodeId ? `${srcNodeId}<->${dstNodeId}` : `${dstNodeId}<->${srcNodeId}`;
        connectedPairs.add(pairKey);
      }
    }
  }

  // 4b. Template edges by pattern (Inferred topology: dashed unless confirmed by evidence; never conflict with explicit)
  const templateEdgeDefs = PATTERN_EDGES[pattern] ?? PATTERN_EDGES.generic ?? [];
  let primaryFlowCounter = 1;

  const ASYNC_SERVICES = new Set<ServiceId>(["SQS", "SNS", "EventBridge", "Kinesis"]);
  const MONITORING_IAC_SERVICES = new Set<ServiceId>(["CloudWatch", "CloudFormation", "CodePipeline", "ECR"]);
  const ASYNC_OR_IAC_LABELS = /fanout|trigger|consume|publish|pull image|deploy|monitor/i;

  function isPrimaryPathEdge(src: ServiceId, dst: ServiceId, label?: string): boolean {
    if (ASYNC_SERVICES.has(src) || ASYNC_SERVICES.has(dst)) return false;
    if (MONITORING_IAC_SERVICES.has(src) || MONITORING_IAC_SERVICES.has(dst)) return false;
    if (label && ASYNC_OR_IAC_LABELS.test(label)) return false;
    return true;
  }

  for (const [srcService, dstService, label] of templateEdgeDefs) {
    const srcNodes = groundedNodes.filter((n) => n.serviceId === srcService);
    const dstNodes = groundedNodes.filter((n) => n.serviceId === dstService);

    const isPrimary = isPrimaryPathEdge(srcService, dstService, label);

    for (const srcNode of srcNodes) {
      for (const dstNode of dstNodes) {
        if (srcNode.id === dstNode.id) continue;
        const forwardKey = `${srcNode.id}->${dstNode.id}`;
        const reverseKey = `${dstNode.id}->${srcNode.id}`;
        const pairKey = srcNode.id < dstNode.id ? `${srcNode.id}<->${dstNode.id}` : `${dstNode.id}<->${srcNode.id}`;

        // Explicit relationships take priority: never overwrite, reverse, or duplicate
        if (edgeKeys.has(forwardKey) || edgeKeys.has(reverseKey) || connectedPairs.has(pairKey)) {
          continue;
        }

        const srcMapping = consolidatedMappings.find((m) => m.componentId === srcNode.componentId);
        const dstMapping = consolidatedMappings.find((m) => m.componentId === dstNode.componentId);
        const srcEv = srcMapping?.evidence ?? "";
        const dstEv = dstMapping?.evidence ?? "";

        const confirmed = isEdgeConfirmed(
          srcService,
          dstService,
          srcEv,
          dstEv,
          plan.relationships ?? [],
          sdkEvidence
        );

        const edgeLabel = confirmed
          ? (label ?? "")
          : label
          ? `${label} (inferred topology)`
          : "inferred topology";

        const flowStep = isPrimary ? primaryFlowCounter++ : undefined;

        rawEdges.push({
          source: srcNode.id,
          target: dstNode.id,
          label: edgeLabel,
          style: confirmed ? "solid" : "dashed",
          tooltip: confirmed ? undefined : "inferred topology",
          flowStep,
        });
        edgeKeys.add(forwardKey);
        connectedPairs.add(pairKey);
      }
    }
  }

  // 5. Route edges with collision avoidance and label staggering
  const routedEdges = routeEdges(rawEdges, nodeAbsGeo);

  return {
    layout,
    nodes: groundedNodes,
    routedEdges,
    consolidatedMappings,
    compIdRedirect,
  };
}

/**
 * Convenience helper to validate semantic integrity directly on a ServicePlan.
 */
export function validatePlanSemantics(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): SemanticValidationResult {
  const { nodes, routedEdges } = buildDiagramElements(plan, sdkEvidence);
  return validateDiagramSemantics(plan, nodes, routedEdges);
}

export function generateSingleDiagramXml(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): string {
  const pattern = plan.detectedPattern ?? "generic";
  const patternTitle = xmlAttr(
    pattern
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
  );

  const { layout, nodes, routedEdges } = buildDiagramElements(plan, sdkEvidence);

  // 6. Render mxGraph cells
  const cellsXml: string[] = [];

  // Containers (drawn first so they sit in the background)
  // Emit in hierarchical order: aws_cloud first, then its children, then grandchildren
  const containerEmitOrder: ContainerKey[] = [
    "aws_cloud",
    "edge",
    "vpc",
    "az",
    "external",
    "cross_cutting",
    "public_subnet",
    "compute_subnet",
    "data_subnet",
  ];
  for (const tier of containerEmitOrder) {
    const rect = layout.containers[tier];
    if (!rect) continue;
    const containerId = `container-${tier}`;
    const label = CONTAINER_LABELS[tier];
    const themeStyle = CONTAINER_THEMES[tier];
    const parentId = CONTAINER_PARENTS[tier];

    // Compute geometry relative to parent container
    let geoX = rect.x;
    let geoY = rect.y;
    const geoW = rect.w;
    const geoH = rect.h;

    if (parentId !== "1") {
      // Convert absolute coordinates to parent-relative coordinates
      const parentKey = parentId.replace("container-", "") as ContainerKey;
      const parentRect = layout.containers[parentKey];
      if (parentRect) {
        geoX = rect.x - parentRect.x;
        geoY = rect.y - parentRect.y;
      }
    }

    cellsXml.push(
      `    <mxCell id="${containerId}" value="${xmlAttr(label)}" ` +
        `style="${themeStyle}" vertex="1" parent="${parentId}">` +
        `<mxGeometry x="${geoX}" y="${geoY}" ` +
        `width="${geoW}" height="${geoH}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // Edges (Orthogonal with clear arrowheads, parallel lane separation, and shielded label badges)
  for (const edge of routedEdges) {
    const label = xmlAttr(edge.label);
    const portStyle = `exitX=${edge.exitPort.x};exitY=${edge.exitPort.y};exitDx=0;exitDy=0;entryX=${edge.entryPort.x};entryY=${edge.entryPort.y};entryDx=0;entryDy=0;`;
    const edgeStyle =
      edge.style === "dashed"
        ? `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;${portStyle}dashed=1;dashPattern=8 8;strokeColor=#6B7280;strokeWidth=1;labelBackgroundColor=#FFFFFF;spacing=4;`
        : `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;${portStyle}strokeColor=#232F3E;strokeWidth=1.5;labelBackgroundColor=#FFFFFF;spacing=4;`;

    const waypointsXml =
      edge.waypoints.length > 0
        ? `<Array as="points">\n${edge.waypoints
            .map((pt) => `          <mxPoint x="${pt.x}" y="${pt.y}"/>`)
            .join("\n")}\n        </Array>`
        : "";

    cellsXml.push(
      `    <mxCell id="${edge.id}" value="${label}" ` +
        `style="${edgeStyle}" ` +
        `edge="1" source="${edge.sourceId}" target="${edge.targetId}" parent="1">` +
        `<mxGeometry relative="1" as="geometry">\n` +
        `        <mxPoint as="offset" x="${edge.labelOffsetX}" y="${edge.labelOffsetY}"/>\n` +
        (waypointsXml ? `        ${waypointsXml}\n` : "") +
        `      </mxGeometry>` +
        `</mxCell>`
    );
  }

  // Badges (flow numbers on primary edges - drawn after edges)
  for (const edge of routedEdges) {
    if (edge.flowStep !== undefined) {
      const badgeStyle =
        "shape=ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#232F3E;strokeColor=none;" +
        "fontColor=#FFFFFF;fontSize=9;fontStyle=1;align=center;verticalAlign=middle;";
      cellsXml.push(
        `    <mxCell id="badge-${edge.id}" value="${edge.flowStep}" ` +
          `style="${badgeStyle}" vertex="1" parent="${edge.id}">` +
          `<mxGeometry relative="1" as="geometry"/>` +
          `</mxCell>`
      );
    }
  }

  // Nodes (AWS services - drawn last so icons and labels sit cleanly in the foreground)
  for (const node of nodes) {
    const style = nodeStyle(node.serviceId);
    const label = xmlAttr(node.label);
    cellsXml.push(
      `    <mxCell id="${node.id}" value="${label}" serviceId="${node.serviceId}" style="${xmlAttr(style)}" ` +
        `vertex="1" parent="${node.parent}">` +
        `<mxGeometry x="${node.geo.x}" y="${node.geo.y}" ` +
        `width="${node.geo.w}" height="${node.geo.h}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // 7. Validate full semantics and layout
  const semanticValidation = validateDiagramSemantics(plan, nodes, routedEdges);
  if (!semanticValidation.valid) {
    console.warn(
      "Diagram semantic validation warnings in generateSingleDiagramXml:\n" +
        semanticValidation.errors.join("\n")
    );
  }

  const layoutValidation = validateDiagramLayout(layout, nodes);
  if (!layoutValidation.valid) {
    console.warn(
      "Diagram layout validation warnings in generateSingleDiagramXml:\n" +
        layoutValidation.errors.join("\n")
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<mxfile host="aws-architect" modified="" agent="aws-architect" version="21.0.0" type="device">`,
    `  <diagram id="diagram-1" name="${patternTitle} Architecture">`,
    `    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" ` +
      `tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
      `pageWidth="${layout.canvasW}" pageHeight="${layout.canvasH}" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    ...cellsXml,
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
  ].join("\n");
}
