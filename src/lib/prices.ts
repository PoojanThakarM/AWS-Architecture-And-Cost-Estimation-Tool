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
// Fallback static prices (USD per row unit) — used when a live lookup fails.
//
// These are us-east-1 reference values, NOT current prices for other regions.
// Every fallback row is labelled with FALLBACK_PRICE_REGION and its status
// from FALLBACK_PRICE_STATUS so the UI never presents them as live quotes.
// Keys are serviceId, or `${serviceId}:${lineId}` for secondary billing lines.
// ---------------------------------------------------------------------------

/** Region the fallback table describes. */
export const FALLBACK_PRICE_REGION = "us-east-1";

export const FALLBACK_PRICES: Record<string, number> = {
  EC2: 0.0208,          // t3.small Linux on-demand $/hr (was 0.023 = t2.small)
  Lambda: 0.0000166667, // $/GB-second (x86)
  "Lambda:requests": 0.20, // $/million requests
  ECS: 0.04048,         // Fargate $/vCPU-hr
  "ECS:memory": 0.004445, // Fargate $/GB-hr
  EKS: 0.10,            // $/cluster-hr
  Fargate: 0.04048,     // $/vCPU-hr
  "Fargate:memory": 0.004445, // $/GB-hr
  Lightsail: 10.0,      // flat $10/mo (already monthly)
  Batch: 0.04048,       // Fargate on-demand $/vCPU-hr (Batch itself is free)
  S3: 0.023,            // $/GB-month Standard (first 50 TB)
  EBS: 0.08,            // gp3 $/GB-month
  EFS: 0.30,            // Standard $/GB-month
  Glacier: 0.004,       // Instant Retrieval $/GB-month
  RDS: 0.017,           // db.t3.micro MySQL Single-AZ $/hr
  "RDS:postgres": 0.018, // db.t3.micro PostgreSQL Single-AZ $/hr
  "RDS:storage": 0.115, // gp2 $/GB-month Single-AZ
  DynamoDB: 0.000000125, // On-Demand $/read request unit ($0.125/M since 2024-11-01; was $0.25/M)
  "DynamoDB:writes": 0.000000625, // On-Demand $/write request unit ($0.625/M)
  ElastiCache: 0.017,   // cache.t3.micro $/hr
  Aurora: 0.12,         // Serverless v2 $/ACU-hr
  Redshift: 0.25,       // dc2.large $/hr
  DocumentDB: 0.033,    // db.t3.medium $/hr — UNVERIFIED, see FALLBACK_PRICE_STATUS
  CloudFront: 0.085,    // $/GB US egress, first 10 TB (was 0.0085 — 10× too low)
  APIGateway: 1.00,     // $/million HTTP API calls (matches the ApiGatewayV2 CFN export)
  ALB: 0.0225,          // $/ALB-hr (LCU charges excluded)
  Route53: 0.50,        // $/hosted zone/mo (already monthly)
  CloudWatchLogs: 0.50, // $/GB ingested
  "CloudWatch:logs": 0.50, // $/GB ingested
  NATGateway: 0.045,    // $/hr
  SQS: 0.40,            // $/million requests (Standard)
  SNS: 0.50,            // $/million publishes
  EventBridge: 1.00,    // $/million custom events
  Kinesis: 0.015,       // $/shard-hr
  Cognito: 0.0055,      // $/MAU, Lite tier, after the free tier
  CloudWatch: 0.30,     // $/metric/month
  CodePipeline: 1.00,   // $/active pipeline/mo (already monthly)
  ECR: 0.10,            // $/GB-month
  SageMaker: 0.046,     // ml.t3.medium $/hr — UNVERIFIED
  Rekognition: 0.001,   // $/image
  Comprehend: 0.0001,   // $/unit (100 chars)
  SES: 0.0001,          // $/email
  Amplify: 0.01,        // $/build-minute
  SecretsManager: 0.40, // $/secret-month
  WAF: 5.00,            // $/web ACL-month (rules and requests excluded)
};

/**
 * Provenance of each fallback value. "verified-2026-10" values were checked
 * against published AWS pricing during the October 2026 audit; "reference"
 * values are the repository's original us-east-1 figures (dated 2024-12) and
 * have not been re-verified; "unverified" values are known to be doubtful.
 * Services absent from FALLBACK_PRICES have NO fallback: when the live lookup
 * fails they are reported as unpriced instead of costing $0.
 */
export type FallbackPriceStatus = "verified-2026-10" | "reference" | "unverified";

export const FALLBACK_PRICE_STATUS: Record<string, FallbackPriceStatus> = {
  EC2: "verified-2026-10",
  ECS: "verified-2026-10",
  "ECS:memory": "verified-2026-10",
  Fargate: "verified-2026-10",
  "Fargate:memory": "verified-2026-10",
  CloudFront: "verified-2026-10",
  DynamoDB: "verified-2026-10",
  "DynamoDB:writes": "verified-2026-10",
  DocumentDB: "unverified",
  SageMaker: "unverified",
};

export function fallbackPriceStatus(key: string): FallbackPriceStatus {
  return FALLBACK_PRICE_STATUS[key] ?? "reference";
}

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
/** Bulk index files above this size are skipped rather than parsed partially. */
const BULK_MAX_BYTES = 8 * 1024 * 1024;

type BulkProduct = { sku: string; productFamily?: string; attributes: Record<string, string> };
type BulkDimension = { pricePerUnit: { USD: string }; beginRange?: string; unit?: string };
type BulkTerms = Record<string, Record<string, { priceDimensions: Record<string, BulkDimension> }>>;

/**
 * Picks the on-demand price for the first SKU whose usagetype contains
 * `usageTypePrefix` and whose attributes match `attributeFilters`. For tiered
 * prices the FIRST paid tier (lowest beginRange with a non-zero price) is
 * used, rather than whichever dimension the object happens to list first.
 * Exported for tests.
 */
export function selectBulkPrice(
  data: { products?: Record<string, BulkProduct>; terms?: { OnDemand?: BulkTerms } },
  usageTypePrefix: string,
  attributeFilters?: Record<string, string>
): number | null {
  for (const [sku, product] of Object.entries(data.products ?? {})) {
    const attrs = product.attributes ?? {};
    const usageType = attrs.usagetype ?? "";
    if (!usageType.includes(usageTypePrefix)) continue;
    if (attributeFilters) {
      const ok = Object.entries(attributeFilters).every(([k, v]) =>
        k === "productFamily" ? product.productFamily === v || attrs[k] === v : attrs[k] === v
      );
      if (!ok) continue;
    }
    const onDemandTerms = data.terms?.OnDemand?.[sku];
    if (!onDemandTerms) continue;
    let best: { begin: number; usd: number } | null = null;
    for (const term of Object.values(onDemandTerms)) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        const usd = parseFloat(dim.pricePerUnit?.USD ?? "0");
        if (!(usd > 0)) continue;
        const begin = parseFloat(dim.beginRange ?? "0") || 0;
        if (!best || begin < best.begin) best = { begin, usd };
      }
    }
    if (best) return best.usd;
  }
  return null;
}

export async function fetchBulkPrice(
  serviceCode: string,
  usageTypePrefix: string,
  region: string,
  attributeFilters?: Record<string, string>
): Promise<number | null> {
  const regionPath = REGION_PATH[region] ?? "us-east-1";
  const url = `${PRICING_BASE}/${serviceCode}/current/${regionPath}/index.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    // Large regional index files (EC2 is hundreds of MB) cannot be parsed
    // from a prefix: the previous code read the first 2 MB and called
    // JSON.parse on the truncated text, which always threw — so "live"
    // pricing silently never worked for those services. Skip them cleanly.
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > BULK_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = res.body?.getReader();
    if (!reader) return null;

    const decoder = new TextDecoder("utf-8");
    let raw = "";
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > BULK_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();

    return selectBulkPrice(JSON.parse(raw), usageTypePrefix, attributeFilters);
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

      type Dim = { pricePerUnit?: { USD?: string } };
      type Term = { priceDimensions?: Record<string, Dim> };
      const firstPaid = (dims: Record<string, Dim> | undefined): number | null => {
        for (const dim of Object.values(dims ?? {})) {
          const usd = parseFloat(dim?.pricePerUnit?.USD ?? "0");
          if (usd > 0) return usd;
        }
        return null;
      };
      const onDemandTerms = item?.terms?.OnDemand as Record<string, Term | Record<string, Term>> | undefined;
      if (onDemandTerms) {
        for (const termOrSku of Object.values(onDemandTerms)) {
          // Format 1: Direct offer term with priceDimensions
          const direct = firstPaid((termOrSku as Term)?.priceDimensions);
          if (direct !== null) return direct;
          // Format 2: Keyed by SKU containing offer terms
          if (typeof termOrSku === "object" && termOrSku !== null) {
            for (const inner of Object.values(termOrSku as Record<string, Term>)) {
              const nested = firstPaid(inner?.priceDimensions);
              if (nested !== null) return nested;
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

export interface PriceLookupOptions {
  /** Converts the Price List unit (e.g. per request) into the row unit (per million). */
  livePriceMultiplier?: number;
  /** SKU attributes that must match (databaseEngine, operatingSystem, …). */
  attributeFilters?: Record<string, string>;
  /** Fallback-table key when it differs from serviceId (e.g. "RDS:postgres"). */
  fallbackKey?: string;
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

/** Fallback results are cached briefly so a transient outage is retried soon. */
const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Returns the unit price in the ROW's unit, or `null` when neither a live
 * price nor a fallback reference price exists. Callers must treat null as
 * "unpriced" — previously a missing fallback returned 0, so MSK, OpenSearch,
 * Secrets Manager and WAF were shown as costing $0.00.
 */
export async function getUnitPrice(
  serviceId: string,
  serviceCode: string | null,
  usageTypePrefix: string | null,
  region: string,
  sourceMode?: PriceSourceMode,
  options: PriceLookupOptions = {}
): Promise<PriceLookupResult | null> {
  const mode = sourceMode ?? getPriceSourceMode();
  const fallbackKey = options.fallbackKey ?? serviceId;
  const key = cacheKey(region, fallbackKey, mode);

  // Check cache
  const cached = cacheGet(key);
  if (cached !== null) {
    return cached;
  }

  // Try live fetch
  if (serviceCode && usageTypePrefix) {
    const rawLive =
      mode === "sdk"
        ? await fetchSdkPrice(serviceCode, usageTypePrefix, region)
        : await fetchBulkPrice(serviceCode, usageTypePrefix, region, options.attributeFilters);
    const livePrice = rawLive !== null ? rawLive * (options.livePriceMultiplier ?? 1) : null;

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

  // Fallback (us-east-1 reference value) — or nothing at all.
  const fallback = FALLBACK_PRICES[fallbackKey] ?? FALLBACK_PRICES[serviceId];
  if (fallback === undefined || !(fallback > 0)) {
    return null;
  }
  PRICE_CACHE.set(key, { price: fallback, source: "fallback", expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
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
