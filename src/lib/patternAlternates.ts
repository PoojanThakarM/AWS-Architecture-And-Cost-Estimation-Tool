/**
 * patternAlternates.ts — Curated Architectural Alternate Pairs & Trade-offs
 *
 * Defines explicit, hardcoded alternate architecture proposals for specific,
 * well-known trade-offs (e.g. cost-optimized DynamoDB-serverless path vs.
 * analytics-heavy Athena path).
 *
 * Trade-offs are NEVER inferred from score proximity or heuristics.
 * Exactly 2-3 well-known architectural trade-offs are curated as the MVP.
 */

import type { PatternId } from "./architecture.ts";
import type { ServiceId, ServicePlan } from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import { buildServicePlan } from "./ruleEngine.ts";

export interface AlternateProposalConfig {
  /** The alternate pattern ID */
  alternatePattern: PatternId;
  /** Human-readable label for the primary architecture */
  primaryTitle: string;
  /** Human-readable label for the alternate architecture */
  alternateTitle: string;
  /** Primary architectural dimension (e.g. "Cost vs. Flexibility", "Latency vs. Scale-to-Zero") */
  tradeOffDimension: string;
  /** Rationale explaining why this trade-off exists */
  description: string;
  /** Services swapped or introduced in the alternate */
  serviceModifications: {
    remove?: ServiceId[];
    add: Array<{ serviceId: ServiceId; reason: string }>;
  };
}

/**
 * Curated list of concrete alternate pairs.
 * Exactly 2 core trade-offs defined for the MVP:
 * 1. serverless-api (OLTP / DynamoDB) vs. data-pipeline (Analytics / S3 + Redshift/Athena)
 * 2. containerised-app (ECS/Fargate) vs. serverless-api (Lambda scale-to-zero)
 *
 * All other patterns (static-site, event-driven, ml-pipeline, full-stack-web, data-pipeline, generic)
 * have NO defined alternate and produce exactly 1 proposal.
 */
export const CURATED_ALTERNATE_PAIRS: Partial<Record<PatternId, AlternateProposalConfig>> = {
  // Trade-off 1: Cost-Optimized Serverless (DynamoDB OLTP) vs. Analytics-Heavy Data Pipeline (S3 + Redshift/Athena)
  // Rationale: DynamoDB offers sub-10ms transactional writes and scales to $0 at idle, but
  // lacks ad-hoc SQL query flexibility and analytical joins. The analytics alternate stores
  // raw event streams in S3 and queries via Redshift/Athena, trading millisecond transactional
  // latency for rich analytical aggregations.
  "serverless-api": {
    alternatePattern: "data-pipeline",
    primaryTitle: "Cost-Optimized Serverless (OLTP)",
    alternateTitle: "Analytics-Heavy Data Pipeline (OLAP)",
    tradeOffDimension: "Cost & Low-Latency Transactions vs. Ad-hoc Query Flexibility",
    description:
      "DynamoDB provides single-digit millisecond latency and scales to zero when idle for key-value transactions, but cannot execute ad-hoc SQL joins across historical records. The data-pipeline alternate streams events to S3 and Redshift, enabling deep analytical SQL queries across entire datasets at the cost of transactional write latency.",
    serviceModifications: {
      remove: ["DynamoDB"],
      add: [
        { serviceId: "S3", reason: "Scalable data lake storage for raw event stream" },
        { serviceId: "Redshift", reason: "Data warehouse for analytical aggregations and BI" },
        { serviceId: "Kinesis", reason: "Real-time streaming ingestion pipeline" },
      ],
    },
  },

  // Trade-off 2: Containerised Long-Running App (ECS) vs. Scale-to-Zero Serverless (Lambda)
  // Rationale: Containers on ECS/Fargate maintain persistent DB connection pools and zero cold starts
  // for high steady-state throughput, but carry fixed baseline monthly compute costs ($50–$150/mo minimum).
  // The serverless alternate scales to $0 during quiet periods, eliminating idle costs for bursty traffic
  // at the cost of cold-start latency jitter.
  "containerised-app": {
    alternatePattern: "serverless-api",
    primaryTitle: "Containerised High-Throughput (ECS/Fargate)",
    alternateTitle: "Scale-to-Zero Serverless (Lambda)",
    tradeOffDimension: "Predictable Latency & High Concurrency vs. Scale-to-Zero Idle Cost",
    description:
      "Containers on ECS/Fargate eliminate cold starts and maintain persistent connection pools for predictable high-throughput APIs, but incur fixed baseline monthly spend. The serverless alternate scales compute strictly to $0 when idle, ideal for variable or bursty workloads at the cost of cold-start latency.",
    serviceModifications: {
      remove: ["ECS", "Fargate", "EKS", "ALB"],
      add: [
        { serviceId: "Lambda", reason: "Event-driven compute that scales to zero when idle" },
        { serviceId: "APIGateway", reason: "Serverless HTTP API ingress routing" },
        { serviceId: "DynamoDB", reason: "Serverless on-demand NoSQL database" },
      ],
    },
  },
};

/**
 * Returns the alternate proposal configuration for a given pattern, or null if none exists.
 */
export function getAlternateConfig(pattern?: string | null): AlternateProposalConfig | null {
  if (!pattern) return null;
  return CURATED_ALTERNATE_PAIRS[pattern as PatternId] ?? null;
}

/**
 * Derives an alternate ServicePlan proposal if an explicit trade-off pair exists for the primary pattern.
 * Returns null if the pattern has no defined alternate.
 */
export function buildAlternateProposal(
  primaryPlan: ServicePlan,
  input: RuleInput
): ServicePlan | null {
  const pattern = primaryPlan.detectedPattern as PatternId | undefined;
  if (!pattern) return null;

  const config = CURATED_ALTERNATE_PAIRS[pattern];
  if (!config) return null;

  // Clone and mutate services
  const removeSet = new Set<string>(config.serviceModifications.remove ?? []);
  const remainingServices = primaryPlan.awsMappings
    .filter((m) => !removeSet.has(m.serviceId))
    .map((m) => ({
      serviceId: m.serviceId,
      confidence: m.confidence,
      evidence: m.evidence,
    }));

  for (const toAdd of config.serviceModifications.add) {
    if (!remainingServices.some((s) => s.serviceId === toAdd.serviceId)) {
      remainingServices.push({
        serviceId: toAdd.serviceId,
        confidence: "medium" as const,
        evidence: `Alternate trade-off (${config.tradeOffDimension}): ${toAdd.reason}`,
      });
    }
  }

  // Build the alternate plan using standard buildServicePlan
  const alternatePlan = buildServicePlan(input, remainingServices);
  alternatePlan.detectedPattern = config.alternatePattern;
  alternatePlan.proposalTitle = config.alternateTitle;
  alternatePlan.tradeOffDimension = config.tradeOffDimension;
  alternatePlan.tradeOffDescription = config.description;

  // Stamp primary plan metadata if not already stamped
  if (!primaryPlan.proposalTitle) {
    primaryPlan.proposalTitle = config.primaryTitle;
  }
  if (!primaryPlan.tradeOffDimension) {
    primaryPlan.tradeOffDimension = config.tradeOffDimension;
  }
  if (!primaryPlan.tradeOffDescription) {
    primaryPlan.tradeOffDescription = config.description;
  }

  return alternatePlan;
}
