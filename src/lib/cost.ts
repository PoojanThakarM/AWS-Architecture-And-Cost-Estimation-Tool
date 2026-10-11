/**
 * cost.ts — Stage 5: CostService
 *
 * Computes monthly cost estimates for each service in a ServicePlan.
 *
 * For every billing line (a service's primary dimension plus any extraLines,
 * e.g. Lambda GB-seconds AND Lambda requests):
 *
 *   usageQuantity    = baseQuantity × (fixed ? 1 : userCount / BASE_USER_COUNT)
 *   billableQuantity = max(usageQuantity − freeTierQuantity, 0)
 *   monthlyUsd       = unitPrice × billableQuantity
 *
 * where unitPrice is expressed in the row's own unit (live Price List values
 * are converted with livePriceMultiplier). Rounding happens only for display.
 *
 * Services the cost model cannot price are returned in `unpricedRows` with a
 * reason — never silently dropped and never shown as $0.
 *
 * Exported:
 *   computeCostRows(plan, region, userCount) → Promise<CostResult>
 *   scaleCostRows(result, newUserCount)      → CostResult (pure, client-safe)
 */

import type { ServicePlan } from "./schema.ts";
import {
  getUnitPrice,
  getPriceSourceMode,
  fallbackPriceStatus,
  FALLBACK_PRICE_REGION,
} from "./prices.ts";
import type { PriceSourceMode, FallbackPriceStatus } from "./prices.ts";
import { getServiceDefaults, BASE_USER_COUNT, FIXED_COST_SERVICES } from "./SERVICE_DEFAULTS.ts";
import type { RdsEngineLabel, ServiceDefault, ServiceLine } from "./SERVICE_DEFAULTS.ts";

/**
 * Services with no direct charge of their own. They are listed (so the user
 * sees they were considered) but contribute $0 by definition, not by a
 * missing price.
 */
export const NO_CHARGE_SERVICES: Record<string, string> = {
  VPC: "No charge for the VPC itself; NAT Gateways, VPC endpoints and data transfer are billed separately.",
  IAM: "IAM has no charge.",
  CloudFormation: "No charge for provisioning AWS resources with CloudFormation.",
  CDK: "CDK has no charge; deployed resources are billed individually.",
  Organizations: "AWS Organizations has no charge.",
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface CostRow {
  serviceId: string;
  componentId: string;
  /** Secondary billing dimension ("requests", "memory", …); absent for the primary line. */
  lineId?: string;
  unitLabel: string;
  /** Billable quantity (after any free tier), in `unitLabel` units. */
  quantity: number;
  /** Usage before the free tier is subtracted. Used for client-side rescaling. */
  usageQuantity?: number;
  /** Free allowance subtracted from usage (0 when none is applied). */
  freeTierQuantity?: number;
  unitPrice: number;
  /** What `unitPrice` is per, e.g. "per GB-second". */
  priceUnit?: string;
  monthlyUsd: number;
  priceSource: "live" | "fallback";
  /** Region the unit price actually describes (fallbacks are us-east-1 references). */
  priceRegion?: string;
  /** Provenance of a fallback value. */
  fallbackStatus?: FallbackPriceStatus;
  annotation: string;
  /** Costs this row deliberately leaves out. */
  excludes?: string;
  fixed?: boolean;
}

export interface UnpricedRow {
  serviceId: string;
  componentId: string;
  note: string;
}

export interface CostResult {
  rows: CostRow[];
  unpricedRows: UnpricedRow[];
  totalMonthlyUsd: number;
  region: string;
  userCount: number;
  computedAt: string;
  priceSourceMode?: PriceSourceMode;
  /** Assumptions that apply to the whole estimate. */
  assumptions?: string[];
}

export const GLOBAL_COST_ASSUMPTIONS: string[] = [
  "On-demand rates only — no Savings Plans, Reserved Instances or enterprise discounts.",
  "Data transfer between services and to the internet is excluded unless a row says otherwise.",
  "Taxes and AWS Support plans are excluded.",
  `Usage quantities are fixed baselines for ${BASE_USER_COUNT.toLocaleString("en-US")} monthly active users; request-based services scale linearly with the user count, provisioned capacity does not.`,
  `Fallback prices are ${FALLBACK_PRICE_REGION} reference values and are used for every region when a live price is unavailable.`,
  "This is an estimate for planning, not a bill. Verify with the AWS Pricing Calculator before committing.",
];

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

interface PricedLine {
  serviceId: string;
  lineId?: string;
  spec: ServiceDefault | ServiceLine;
  fixed: boolean;
}

function linesFor(serviceId: string, defaults: ServiceDefault): PricedLine[] {
  const primaryFixed = FIXED_COST_SERVICES.has(serviceId);
  const lines: PricedLine[] = [{ serviceId, spec: defaults, fixed: primaryFixed }];
  for (const extra of defaults.extraLines ?? []) {
    lines.push({ serviceId, lineId: extra.lineId, spec: extra, fixed: extra.fixed ?? primaryFixed });
  }
  return lines;
}

/**
 * Computes monthly cost estimates for every service in the ServicePlan.
 *
 * @param plan         The inferred ServicePlan
 * @param region       AWS region string (e.g. "us-east-1")
 * @param userCount    User-provided user count for scaling (default: 10_000)
 * @param priceSource  Price data source: "bulk" (default) or "sdk" (@aws-sdk/client-pricing)
 */
export async function computeCostRows(
  plan: ServicePlan,
  region: string = "us-east-1",
  userCount: number = BASE_USER_COUNT,
  priceSource?: PriceSourceMode
): Promise<CostResult> {
  const rows: CostRow[] = [];
  const unpricedRows: UnpricedRow[] = [];

  const safeUsers = Number.isFinite(userCount) ? Math.max(userCount, 1) : BASE_USER_COUNT;
  const userScaleFactor = safeUsers / BASE_USER_COUNT;
  const dbEngine = (plan.metadata?.dbEngine ?? "none") as RdsEngineLabel;

  // ECS/Fargate defence in depth: Fix 1 folds Fargate into ECS upstream, but
  // if both survive into the final plan, price only the richer ECS row.
  // A service mapped from several components is priced once (the diagram and
  // the CFN export also provision it once).
  const seenServices = new Set<string>();
  const mappings = plan.awsMappings.filter((m, _, arr) => {
    if (m.serviceId === "Fargate" && arr.some((o) => o.serviceId === "ECS")) return false;
    if (seenServices.has(m.serviceId)) return false;
    seenServices.add(m.serviceId);
    return true;
  });

  const tasks: Array<Promise<void>> = [];
  for (const mapping of mappings) {
    if (NO_CHARGE_SERVICES[mapping.serviceId]) {
      unpricedRows.push({
        serviceId: mapping.serviceId,
        componentId: mapping.componentId,
        note: NO_CHARGE_SERVICES[mapping.serviceId],
      });
      continue;
    }

    const defaults = getServiceDefaults(mapping.serviceId, dbEngine);
    if (!defaults) {
      unpricedRows.push({
        serviceId: mapping.serviceId,
        componentId: mapping.componentId,
        note: `No pricing baseline configured for "${mapping.serviceId}" — add it to SERVICE_DEFAULTS.ts to include it in the total.`,
      });
      continue;
    }

    for (const line of linesFor(mapping.serviceId, defaults)) {
      tasks.push(
        (async () => {
          const priceKey = line.lineId
            ? `${line.serviceId}:${line.lineId}`
            : line.serviceId === "RDS" && dbEngine === "postgres"
              ? "RDS:postgres"
              : line.serviceId;
          const attributeFilters =
            line.serviceId === "RDS" && !line.lineId && dbEngine !== "none"
              ? { ...(line.spec.attributeFilters ?? {}), databaseEngine: dbEngine === "postgres" ? "PostgreSQL" : "MySQL" }
              : line.spec.attributeFilters;

          const result = await getUnitPrice(
            line.lineId ? priceKey : line.serviceId,
            line.spec.serviceCode,
            line.spec.usageTypePrefix,
            region,
            priceSource,
            {
              livePriceMultiplier: line.spec.livePriceMultiplier,
              attributeFilters,
              fallbackKey: priceKey,
            }
          );

          if (!result) {
            unpricedRows.push({
              serviceId: line.serviceId,
              componentId: mapping.componentId,
              note:
                `${line.lineId ? `${line.spec.unitLabel}: ` : ""}live AWS price unavailable for ${region} ` +
                "and no verified reference price is on file — not included in the total.",
            });
            return;
          }

          const usageQuantity = line.fixed ? line.spec.baseQuantity : line.spec.baseQuantity * userScaleFactor;
          const freeTierQuantity = line.spec.freeTierQuantity ?? 0;
          const billableQuantity = Math.max(usageQuantity - freeTierQuantity, 0);

          rows.push({
            serviceId: line.serviceId,
            componentId: mapping.componentId,
            ...(line.lineId ? { lineId: line.lineId } : {}),
            unitLabel: line.spec.unitLabel,
            quantity: billableQuantity,
            usageQuantity,
            freeTierQuantity,
            unitPrice: result.price,
            priceUnit: line.spec.priceUnit,
            monthlyUsd: result.price * billableQuantity,
            priceSource: result.source,
            priceRegion: result.source === "live" ? region : FALLBACK_PRICE_REGION,
            ...(result.source === "fallback" ? { fallbackStatus: fallbackPriceStatus(priceKey) } : {}),
            annotation: line.spec.annotation,
            ...(line.spec.excludes ? { excludes: line.spec.excludes } : {}),
            fixed: line.fixed,
          });
        })()
      );
    }
  }

  await Promise.all(tasks);

  // Deterministic order: most expensive first, ties by service then line.
  rows.sort(
    (a, b) =>
      b.monthlyUsd - a.monthlyUsd ||
      a.serviceId.localeCompare(b.serviceId) ||
      (a.lineId ?? "").localeCompare(b.lineId ?? "")
  );
  unpricedRows.sort((a, b) => a.serviceId.localeCompare(b.serviceId));

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    rows,
    unpricedRows,
    totalMonthlyUsd,
    region,
    userCount: safeUsers,
    computedAt: new Date().toISOString(),
    priceSourceMode: priceSource ?? getPriceSourceMode(),
    assumptions: GLOBAL_COST_ASSUMPTIONS,
  };
}

// ---------------------------------------------------------------------------
// Client-side scaling (pure math — no fetch)
// ---------------------------------------------------------------------------

/**
 * Re-scales an existing CostResult to a new userCount without re-fetching prices.
 * Safe to call on the client since it only does arithmetic.
 *
 * The free tier is re-applied to the rescaled USAGE. Scaling the already
 * free-tier-reduced quantity (the previous behaviour) made Cognito at 200k
 * users cost $550 on the client but $825 on the server.
 *
 * @param original  The CostResult returned by computeCostRows()
 * @param newCount  The new user count to scale to
 */
export function scaleCostRows(original: CostResult, newCount: number): CostResult {
  const safeNew = Number.isFinite(newCount) ? Math.max(newCount, 1) : original.userCount;
  const ratio = safeNew / Math.max(original.userCount, 1);

  const rows: CostRow[] = original.rows.map((r) => {
    if (r.fixed) return r;
    const free = r.freeTierQuantity ?? 0;
    // Rows produced before usageQuantity existed carry only `quantity`.
    const usage = (r.usageQuantity ?? r.quantity + free) * ratio;
    const billable = Math.max(usage - free, 0);
    return {
      ...r,
      usageQuantity: usage,
      quantity: billable,
      monthlyUsd: r.unitPrice * billable,
    };
  });

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    ...original,
    rows,
    totalMonthlyUsd,
    userCount: safeNew,
    computedAt: new Date().toISOString(),
    priceSourceMode: original.priceSourceMode,
  };
}
