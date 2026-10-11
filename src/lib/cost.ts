/**
 * cost.ts — Stage 5: CostService
 *
 * Computes monthly cost estimates for each service in a ServicePlan.
 *
 * Algorithm:
 *   monthlyEstimate = unitPrice × (quantity × userScaleFactor)
 *
 * Where:
 *   unitPrice       = fetched from PriceService (live or fallback)
 *   quantity        = SERVICE_DEFAULTS[serviceId].baseQuantity
 *   userScaleFactor = userCount / BASE_USER_COUNT (= userCount / 10_000)
 *
 * Services without a SERVICE_DEFAULTS entry are listed as "unpriced" with
 * a note, never silently dropped.
 *
 * Exported:
 *   computeCostRows(plan, region, userCount) → Promise<CostResult>
 */

import type { ServicePlan, AwsServiceMapping } from "./schema.ts";
import { getUnitPrice, getPriceSourceMode } from "./prices.ts";
import type { PriceSourceMode } from "./prices.ts";
import { getServiceDefaults, BASE_USER_COUNT, FIXED_COST_SERVICES } from "./SERVICE_DEFAULTS.ts";
import type { RdsEngineLabel } from "./SERVICE_DEFAULTS.ts";

/** Cognito User Pools free tier: first 50k MAU free. */
const COGNITO_FREE_TIER_MAU = 50_000;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface CostRow {
  serviceId: string;
  componentId: string;
  unitLabel: string;
  quantity: number;
  unitPrice: number;
  monthlyUsd: number;
  priceSource: "live" | "fallback";
  annotation: string;
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
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

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

  const userScaleFactor = Math.max(userCount, 1) / BASE_USER_COUNT;
  const dbEngine = (plan.metadata?.dbEngine ?? "none") as RdsEngineLabel;

  // ECS/Fargate defence in depth: Fix 1 folds Fargate into ECS upstream, but
  // if both survive into the final plan, price only the richer ECS row.
  const mappings = plan.awsMappings.filter(
    (m, _, arr) =>
      m.serviceId !== "Fargate" || !arr.some((o) => o.serviceId === "ECS")
  );

  // Fetch prices for all services in parallel
  const pricePromises = mappings.map(async (mapping) => {
    const defaults = getServiceDefaults(mapping.serviceId, dbEngine);

    if (!defaults) {
      unpricedRows.push({
        serviceId: mapping.serviceId,
        componentId: mapping.componentId,
        note: `No pricing baseline configured for "${mapping.serviceId}".`,
      });
      return null;
    }

    const { price, source } = await getUnitPrice(
      mapping.serviceId,
      defaults.serviceCode,
      defaults.usageTypePrefix,
      region,
      priceSource
    );

    const isFixed = FIXED_COST_SERVICES.has(mapping.serviceId);
    const scaledQuantity = isFixed ? defaults.baseQuantity : defaults.baseQuantity * userScaleFactor;
    // Cognito bills only MAU past the 50k free tier.
    const billableQuantity =
      mapping.serviceId === "Cognito"
        ? Math.max(scaledQuantity - COGNITO_FREE_TIER_MAU, 0)
        : scaledQuantity;
    const monthlyUsd = price * billableQuantity;

    const row: CostRow = {
      serviceId: mapping.serviceId,
      componentId: mapping.componentId,
      unitLabel: defaults.unitLabel,
      quantity: billableQuantity,
      unitPrice: price,
      monthlyUsd,
      priceSource: source,
      annotation: defaults.annotation,
      fixed: isFixed,
    };

    return row;
  });

  const results = await Promise.all(pricePromises);

  for (const result of results) {
    if (result !== null) {
      rows.push(result);
    }
  }

  // Sort rows by monthly cost descending (most expensive first)
  rows.sort((a, b) => b.monthlyUsd - a.monthlyUsd);

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    rows,
    unpricedRows,
    totalMonthlyUsd,
    region,
    userCount,
    computedAt: new Date().toISOString(),
    priceSourceMode: priceSource ?? getPriceSourceMode(),
  };
}

// ---------------------------------------------------------------------------
// Client-side scaling (pure math — no fetch)
// ---------------------------------------------------------------------------

/**
 * Re-scales an existing CostResult to a new userCount without re-fetching prices.
 * Safe to call on the client since it only does arithmetic.
 *
 * @param original  The CostResult returned by computeCostRows()
 * @param newCount  The new user count to scale to
 */
export function scaleCostRows(original: CostResult, newCount: number): CostResult {
  const ratio = Math.max(newCount, 1) / Math.max(original.userCount, 1);

  const rows: CostRow[] = original.rows.map((r) => {
    if (r.fixed) return r;
    return {
      ...r,
      quantity: r.quantity * ratio,
      monthlyUsd: r.monthlyUsd * ratio,
    };
  });

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    ...original,
    rows,
    totalMonthlyUsd,
    userCount: newCount,
    computedAt: new Date().toISOString(),
    priceSourceMode: original.priceSourceMode,
  };
}