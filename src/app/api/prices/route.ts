/**
 * /api/prices — POST
 *
 * Stage 5: Region-switch price re-fetch endpoint.
 *
 * Accepts a ServicePlan + region + userCount, re-computes cost rows
 * using the price cache (24h TTL), and returns updated CostResult.
 *
 * This is called by the client UI when the user changes the region
 * picker or user-count slider (the slider uses client-side scaling,
 * but the region picker triggers a server round-trip to update prices).
 */

import { NextRequest, NextResponse } from "next/server";
import { ServicePlanSchema } from "@/lib/schema";
import { computeCostRows } from "@/lib/cost";
import { getPriceCacheSize } from "@/lib/prices";
import type { PriceSourceMode } from "@/lib/prices";

// Allowed regions (same set as in analyze route)
const ALLOWED_REGIONS = new Set([
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-south-1", "sa-east-1", "ca-central-1",
]);

interface PricesRequestBody {
  service_plan: unknown;
  region: string;
  userCount?: number;
  price_source?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PricesRequestBody;
  try {
    body = (await req.json()) as PricesRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate region
  const region =
    typeof body.region === "string" && ALLOWED_REGIONS.has(body.region)
      ? body.region
      : null;

  if (!region) {
    return NextResponse.json(
      {
        error: `region must be one of: ${[...ALLOWED_REGIONS].join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Validate service_plan
  const planResult = ServicePlanSchema.safeParse(body.service_plan);
  if (!planResult.success) {
    return NextResponse.json(
      { error: "Invalid service_plan: " + planResult.error.message },
      { status: 400 }
    );
  }

  const userCount =
    typeof body.userCount === "number" &&
    Number.isFinite(body.userCount) &&
    body.userCount >= 1
      ? Math.round(body.userCount)
      : 10_000;

  const priceSource: PriceSourceMode | undefined =
    body.price_source === "sdk" || body.price_source === "bulk"
      ? (body.price_source as PriceSourceMode)
      : undefined;

  try {
    const costResult = await computeCostRows(
      planResult.data,
      region,
      userCount,
      priceSource
    );

    return NextResponse.json({
      cost_rows: costResult,
      cache_size: getPriceCacheSize(),
      price_source: costResult.priceSourceMode,
    });
  } catch (err) {
    console.error("[prices] Cost computation error:", err);
    return NextResponse.json(
      { error: "Cost computation failed" },
      { status: 500 }
    );
  }
}
