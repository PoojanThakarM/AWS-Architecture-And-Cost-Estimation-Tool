/**
 * prices.ts — Stage 5: PriceService
 *
 * Fetches and caches AWS unit prices from either:
 *   1. AWS Bulk Pricing JSON endpoint (default, public, zero-credential)
 *   2. Official AWS SDK Pricing Query API (@aws-sdk/client-pricing GetProducts)
 *
 * The active source is gated behind `PRICE_SOURCE`:
 *   - PRICE_SOURCE="sdk"  → @aws-sdk/client-pricing (GetProducts Query API)
 *   - PRICE_SOURCE="bulk" (or unset) → AWS Bulk Pricing JSON (default)
 *
 * The cache is in-memory, keyed by "mode:region:serviceId", with a 24-hour TTL.
 * This module is SERVER-SIDE ONLY (uses Node.js fetch, AWS SDK, and env vars).
 *
 * ---------------------------------------------------------------------------
 * Credential Requirements for the SDK Path (`PRICE_SOURCE=sdk`):
 * ---------------------------------------------------------------------------
 * Unlike the public AWS Bulk Pricing JSON endpoint (which is unauthenticated
 * and requires no credentials, ideal for demo/grading per Decisions 28 & 42),
 * the official `@aws-sdk/client-pricing` Query API requires valid AWS IAM credentials
 * resolved through the standard AWS SDK v3 credential provider chain:
 *   - Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 *     and optional `AWS_SESSION_TOKEN`.
 *   - Shared credentials file (`~/.aws/credentials`).
 *   - IAM Role (ECS task role, EC2 instance profile, or Web Identity token).
 *
 * Required IAM Permission:
 *   - "pricing:GetProducts"
 *   - "pricing:DescribeServices" (optional for service discovery)
 *
 * Example IAM Policy:
 * ```json
 * {
 *   "Version": "2012-10-17",
 *   "Statement": [
 *     {
 *       "Sid": "AWSArchitectPriceListRead",
 *       "Effect": "Allow",
 *       "Action": [
 *         "pricing:GetProducts",
 *         "pricing:DescribeServices"
 *       ],
 *       "Resource": "*"
 *     }
 *   ]
 * }
 * ```
 *
 * Note: The AWS Price List Query API service endpoint is only available in
 * `us-east-1` (US East, N. Virginia) and `ap-south-1` (Asia Pacific, Mumbai).
 * The `PricingClient` defaults its endpoint region to `us-east-1` (configurable
 * via `AWS_PRICING_REGION`).
 *
 * If credentials are not present or permission is denied (`AccessDeniedException`),
 * the SDK path gracefully and transparently degrades to `FALLBACK_PRICES` with
 * `source: "fallback"`, honoring Decision 32 ("cost baselines are sourced +
 * disclosed, never silent").
 * ---------------------------------------------------------------------------
 */

import type { PricingClient } from "@aws-sdk/client-pricing";

// ---------------------------------------------------------------------------
// Configuration & Modes
// ---------------------------------------------------------------------------

export type PriceSourceMode = "bulk" | "sdk";

/**
 * Returns the currently configured price source mode.
 * Defaults to "bulk" (zero credentials required).
 */
export function getPriceSourceMode(): PriceSourceMode {
  return process.env.PRICE_SOURCE?.toLowerCase() === "sdk" ? "sdk" : "bulk";
}

// ---------------------------------------------------------------------------
// Region maps — AWS Bulk Pricing path codes and SDK Pricing location names
// ---------------------------------------------------------------------------

/** Maps API region names → AWS Bulk Pricing region path segment. */
const REGION_PATH: Record<string, string> = {
  "us-east-1": "us-east-1",
  "us-east-2": "us-east-2",
  "us-west-1": "us-west-1",
  "us-west-2": "us-west-2",
  "eu-west-1": "eu-west-1",
  "eu-west-2": "eu-west-2",
  "eu-central-1": "eu-central-1",
  "ap-southeast-1": "ap-southeast-1",
  "ap-southeast-2": "ap-southeast-2",
  "ap-northeast-1": "ap-northeast-1",
  "ap-south-1": "ap-south-1",
  "sa-east-1": "sa-east-1",
  "ca-central-1": "ca-central-1",
};

/** Maps API region names → AWS Pricing API location attribute values. */
export const REGION_LOCATION: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "eu-west-1": "EU (Ireland)",
  "eu-west-2": "EU (London)",
  "eu-central-1": "EU (Frankfurt)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "sa-east-1": "South America (Sao Paulo)",
  "ca-central-1": "Canada (Central)",
};

/** Regional prefixes commonly found in AWS usage type codes. */
export const REGION_USAGE_PREFIX: Record<string, string> = {
  "us-east-1": "",
  "us-east-2": "USE2-",
  "us-west-1": "USW1-",
  "us-west-2": "USW2-",
  "eu-west-1": "EU-",
  "eu-west-2": "EUW2-",
  "eu-central-1": "EUC1-",
  "ap-southeast-1": "APS1-",
  "ap-southeast-2": "APS2-",
  "ap-northeast-1": "APN1-",
  "ap-south-1": "APS3-",
  "sa-east-1": "SAE1-",
  "ca-central-1": "CAN1-",
};

// ---------------------------------------------------------------------------
// Fallback static prices (USD/unit) — used when bulk file fetch fails.
// Based on us-east-1 public pricing as of 2024-12.
// ---------------------------------------------------------------------------

export const FALLBACK_PRICES: Record<string, number> = {
  EC2: 0.023,           // t3.small on-demand $/hr
  Lambda: 0.0000166667, // $/GB-second
  ECS: 0.04048,         // Fargate $/vCPU-hr
  EKS: 0.10,            // $/cluster-hr
  Fargate: 0.04048,     // $/vCPU-hr
  Lightsail: 10.0,      // flat $10/mo (already monthly)
  Batch: 0.04048,       // estimated Spot vCPU-hr
  S3: 0.023,            // $/GB-month Standard
  EBS: 0.08,            // gp3 $/GB-month
  EFS: 0.30,            // Standard $/GB-month
  Glacier: 0.004,       // Instant Retrieval $/GB-month
  RDS: 0.017,           // db.t3.micro MySQL $/hr
  DynamoDB: 0.00000025, // On-Demand $/RCU
  ElastiCache: 0.017,   // cache.t3.micro $/hr
  Aurora: 0.12,         // Serverless v2 $/ACU-hr
  Redshift: 0.25,       // dc2.large $/hr
  DocumentDB: 0.033,    // db.t3.medium $/hr
  CloudFront: 0.0085,   // $/GB egress (US)
  APIGateway: 3.50,     // $/million REST calls
  ALB: 0.0225,         // base $/ALB-hr (was LCU-only rate)
  Route53: 0.50,        // $/hosted zone/mo (already monthly)
  CloudWatchLogs: 0.50, // $/GB ingested
  VPC: 0.01,            // $/endpoint-hr
  NATGateway: 0.045,    // $/hr
  SQS: 0.40,            // $/million requests (Standard)
  SNS: 0.50,            // $/million publishes
  EventBridge: 1.00,    // $/million events
  Kinesis: 0.015,       // $/shard-hr
  Cognito: 0.0055,      // $/MAU (after 50k free tier)
  CloudWatch: 0.30,     // $/metric/month
  CodePipeline: 1.00,   // $/active pipeline/mo (already monthly)
  ECR: 0.10,            // $/GB-month
  SageMaker: 0.046,     // ml.t3.medium $/hr
  Rekognition: 0.001,   // $/image
  Comprehend: 0.0001,   // $/unit (100 chars)
  SES: 0.0001,          // $/email
  Amplify: 0.01,        // $/build-minute
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  price: number;
  source: "live" | "fallback";
  expiresAt: number; // epoch ms
}

const PRICE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(region: string, serviceId: string, mode: PriceSourceMode): string {
  return `${mode}:${region}:${serviceId}`;
}

function cacheGet(key: string): PriceLookupResult | null {
  const entry = PRICE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PRICE_CACHE.delete(key);
    return null;
  }
  return { price: entry.price, source: entry.source };
}

function cacheSet(key: string, price: number, source: "live" | "fallback"): void {
  PRICE_CACHE.set(key, { price, source, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// 1. AWS Bulk Pricing fetch
// ---------------------------------------------------------------------------

const PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

/**
 * Attempts to fetch the unit price for a given service from the AWS Bulk
 * Pricing files. Returns null on any error (network, parse, missing product).
 *
 * The bulk files are large (MB+); we cap the response to 2 MB to avoid
 * excessive memory usage and use a 5-second timeout.
 */
export async function fetchBulkPrice(
  serviceCode: string,
  usageTypePrefix: string,
  region: string
): Promise<number | null> {
  const regionPath = REGION_PATH[region] ?? "us-east-1";
  const url = `${PRICING_BASE}/${serviceCode}/current/${regionPath}/index.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    // Read body as text, capped at 2 MB
    const reader = res.body?.getReader();
    if (!reader) return null;

    let raw = "";
    let bytesRead = 0;
    const MAX_BYTES = 2 * 1024 * 1024;

    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      bytesRead += value.byteLength;
    }
    reader.cancel();

    // Parse JSON and extract first matching on-demand price
    // Bulk pricing JSON structure:
    //   { products: { sku: { attributes: { usagetype, ... } } },
    //     terms: { OnDemand: { sku: { offerTermCode: { priceDimensions: { ... } } } } } }
    const data = JSON.parse(raw) as {
      products: Record<string, { sku: string; attributes: Record<string, string> }>;
      terms: {
        OnDemand: Record<
          string,
          Record<string, { priceDimensions: Record<string, { pricePerUnit: { USD: string } }> }>
        >;
      };
    };

    // Find first product whose usagetype contains the prefix
    for (const [sku, product] of Object.entries(data.products)) {
      const usageType = product.attributes?.usagetype ?? "";
      if (usageType.includes(usageTypePrefix)) {
        // Get on-demand price
        const onDemandTerms = data.terms?.OnDemand?.[sku];
        if (onDemandTerms) {
          for (const term of Object.values(onDemandTerms)) {
            for (const dim of Object.values(term.priceDimensions)) {
              const usd = parseFloat(dim.pricePerUnit?.USD ?? "0");
              if (usd > 0) return usd;
            }
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// 2. AWS SDK Client Pricing fetch (@aws-sdk/client-pricing GetProducts)
// ---------------------------------------------------------------------------

let activePricingClient: PricingClient | null = null;

/**
 * Lazily returns a PricingClient configured for the AWS Price List API.
 * The Pricing endpoint is located in us-east-1 or ap-south-1 (default us-east-1).
 * Dynamic import keeps SDK out of client bundle (prices.ts reached via cost.ts
 * from CostCalculator client component).
 */
export async function getPricingClient(): Promise<PricingClient> {
  if (!activePricingClient) {
    const { PricingClient: PricingClientCtor } = await import("@aws-sdk/client-pricing");
    activePricingClient = new PricingClientCtor({
      region: process.env.AWS_PRICING_REGION || "us-east-1",
    });
  }
  return activePricingClient;
}

/**
 * Injects or resets a custom PricingClient instance (useful for unit tests/mocking).
 */
export function setPricingClient(client: PricingClient | null): void {
  activePricingClient = client;
}

/**
 * Helper to extract the USD on-demand unit price from a GetProducts PriceList response.
 */
export function extractPriceFromPriceList(
  priceList: (string | object)[] | undefined,
  usageTypePrefix: string
): number | null {
  if (!priceList || priceList.length === 0) return null;

  for (const rawItem of priceList) {
    try {
      const item = typeof rawItem === "string" ? JSON.parse(rawItem) : rawItem;
      const usageType =
        item?.product?.attributes?.usagetype ??
        item?.attributes?.usagetype ??
        "";

      // Verify that the product matches the required usage type prefix
      if (usageType && !usageType.includes(usageTypePrefix)) {
        continue;
      }

      const onDemandTerms = item?.terms?.OnDemand;
      if (onDemandTerms) {
        for (const termOrSku of Object.values(onDemandTerms) as any[]) {
          // Format 1: Direct offer term with priceDimensions
          if (termOrSku?.priceDimensions) {
            for (const dim of Object.values(termOrSku.priceDimensions) as any[]) {
              const usd = parseFloat(dim?.pricePerUnit?.USD ?? "0");
              if (usd > 0) return usd;
            }
          }
          // Format 2: Keyed by SKU containing offer terms
          if (typeof termOrSku === "object" && termOrSku !== null) {
            for (const inner of Object.values(termOrSku) as any[]) {
              if (inner?.priceDimensions) {
                for (const dim of Object.values(inner.priceDimensions) as any[]) {
                  const usd = parseFloat(dim?.pricePerUnit?.USD ?? "0");
                  if (usd > 0) return usd;
                }
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Attempts to fetch unit price using the official @aws-sdk/client-pricing GetProducts API.
 * Returns null on any failure (IAM AccessDenied, missing credentials, timeout, missing product),
 * gracefully falling back to FALLBACK_PRICES.
 */
export async function fetchSdkPrice(
  serviceCode: string,
  usageTypePrefix: string,
  region: string,
  customClient?: PricingClient
): Promise<number | null> {
  const { GetProductsCommand } = await import("@aws-sdk/client-pricing");
  const client = customClient ?? (await getPricingClient());
  const location = REGION_LOCATION[region];
  const regionPrefix = REGION_USAGE_PREFIX[region] ?? "";
  const candidateUsageType = `${regionPrefix}${usageTypePrefix}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    // Strategy 1: Targeted query with candidate usagetype TERM_MATCH
    const targetedFilters: Array<{ Type: "TERM_MATCH"; Field: string; Value: string }> = [];
    if (location) {
      targetedFilters.push({ Type: "TERM_MATCH", Field: "location", Value: location });
    }
    targetedFilters.push({ Type: "TERM_MATCH", Field: "usagetype", Value: candidateUsageType });

    const targetedCmd = new GetProductsCommand({
      ServiceCode: serviceCode,
      Filters: targetedFilters,
      FormatVersion: "aws_v1",
      MaxResults: 20,
    });

    const targetedRes = await client.send(targetedCmd, { abortSignal: controller.signal });
    const targetedPrice = extractPriceFromPriceList(targetedRes.PriceList, usageTypePrefix);
    if (targetedPrice !== null && targetedPrice > 0) {
      return targetedPrice;
    }

    // Strategy 2: If regional candidate had prefix and differed from bare prefix, try bare prefix
    if (candidateUsageType !== usageTypePrefix) {
      const bareFilters: Array<{ Type: "TERM_MATCH"; Field: string; Value: string }> = [];
      if (location) {
        bareFilters.push({ Type: "TERM_MATCH", Field: "location", Value: location });
      }
      bareFilters.push({ Type: "TERM_MATCH", Field: "usagetype", Value: usageTypePrefix });

      const bareCmd = new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: bareFilters,
        FormatVersion: "aws_v1",
        MaxResults: 20,
      });

      const bareRes = await client.send(bareCmd, { abortSignal: controller.signal });
      const barePrice = extractPriceFromPriceList(bareRes.PriceList, usageTypePrefix);
      if (barePrice !== null && barePrice > 0) {
        return barePrice;
      }
    }

    // Strategy 3: Location-only query if targeted usagetype filter yielded no result
    if (location) {
      const broadCmd = new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: [{ Type: "TERM_MATCH", Field: "location", Value: location }],
        FormatVersion: "aws_v1",
        MaxResults: 100,
      });

      const broadRes = await client.send(broadCmd, { abortSignal: controller.signal });
      const broadPrice = extractPriceFromPriceList(broadRes.PriceList, usageTypePrefix);
      if (broadPrice !== null && broadPrice > 0) {
        return broadPrice;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PriceLookupResult {
  price: number;
  source: "live" | "fallback";
}

/**
 * Gets the unit price for a service in a given region.
 *
 * Source selection:
 *   - If `sourceMode` is specified, it takes precedence.
 *   - Otherwise, `getPriceSourceMode()` reads `process.env.PRICE_SOURCE` ("sdk" vs default "bulk").
 *
 * When live fetch succeeds, returns `{ price: livePrice, source: "live" }`.
 * When live fetch fails or is unconfigured, returns `{ price: fallbackPrice, source: "fallback" }`.
 *
 * Results are cached in-memory for 24 hours keyed by mode, region, and serviceId.
 */
/**
 * Per-service upper bounds for live unit prices. A live value above the cap
 * is a mismatched product, not a real price — fall through to fallback.
 */
export const LIVE_PRICE_CAPS: Record<string, number> = {
  S3: 1.0,
  Cognito: 0.05,
  ALB: 0.1,
  RDS: 1.0,
  ECS: 1.0,
  Fargate: 1.0,
  EC2: 1.0,
  Lambda: 0.001,
  CloudWatch: 5.0,
  CloudWatchLogs: 5.0,
  ECR: 1.0,
  DynamoDB: 0.01,
};

export async function getUnitPrice(
  serviceId: string,
  serviceCode: string | null,
  usageTypePrefix: string | null,
  region: string,
  sourceMode?: PriceSourceMode
): Promise<PriceLookupResult> {
  const mode = sourceMode ?? getPriceSourceMode();
  const key = cacheKey(region, serviceId, mode);

  // Check cache
  const cached = cacheGet(key);
  if (cached !== null) {
    return cached;
  }

  // Try live fetch
  if (serviceCode && usageTypePrefix) {
    const livePrice =
      mode === "sdk"
        ? await fetchSdkPrice(serviceCode, usageTypePrefix, region)
        : await fetchBulkPrice(serviceCode, usageTypePrefix, region);

    if (livePrice !== null && livePrice > 0) {
      const cap = LIVE_PRICE_CAPS[serviceId];
      if (cap !== undefined && livePrice > cap) {
        console.warn(
          `[prices] live price $${livePrice} for ${serviceId} exceeds sanity cap $${cap} — using fallback`
        );
      } else {
        cacheSet(key, livePrice, "live");
        return { price: livePrice, source: "live" };
      }
    }
  }

  // Fallback
  const fallback = FALLBACK_PRICES[serviceId] ?? 0;
  cacheSet(key, fallback, "fallback");
  return { price: fallback, source: "fallback" };
}

/** Clears the entire price cache (used in tests). */
export function clearPriceCache(): void {
  PRICE_CACHE.clear();
}

/** Returns the number of entries currently in the cache. */
export function getPriceCacheSize(): number {
  return PRICE_CACHE.size;
}
