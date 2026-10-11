/**
 * prices.test.ts
 *
 * Tests for Stage 5 PriceService & CostService:
 *  - Config gating (PRICE_SOURCE=bulk vs PRICE_SOURCE=sdk)
 *  - Preservation of FALLBACK_PRICES exact values
 *  - Decision 32 disclosure guarantee: every price has source: "live" | "fallback"
 *  - Bulk pricing path fallback & parsing
 *  - SDK pricing path (@aws-sdk/client-pricing) live extraction & fallback
 *  - Integration with computeCostRows and scaleCostRows
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/prices.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getUnitPrice,
  getPriceSourceMode,
  clearPriceCache,
  getPriceCacheSize,
  setPricingClient,
  extractPriceFromPriceList,
  FALLBACK_PRICES,
  REGION_LOCATION,
  REGION_USAGE_PREFIX,
} from "../prices.ts";
import { computeCostRows, scaleCostRows } from "../cost.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Test Plan Fixture
// ---------------------------------------------------------------------------

function makeTestPlan(): ServicePlan {
  return {
    inputKind: "description",
    components: [
      { id: "c-web", type: "frontend", technology: "S3", evidence: ["static"], confidence: "high", status: "detected" },
      { id: "c-api", type: "backend", technology: "Lambda", evidence: ["api"], confidence: "high", status: "detected" },
      { id: "c-db", type: "database", technology: "DynamoDB", evidence: ["db"], confidence: "high", status: "detected" },
    ],
    awsMappings: [
      { componentId: "c-web", serviceId: "S3", confidence: "high", evidence: "static", fromPattern: false },
      { componentId: "c-api", serviceId: "Lambda", confidence: "high", evidence: "api", fromPattern: false },
      { componentId: "c-db", serviceId: "DynamoDB", confidence: "high", evidence: "db", fromPattern: false },
    ],
    relationships: [],
    deploymentModel: [],
    detectedPattern: "serverless-api",
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
  };
}

describe("PriceService — Configuration & Fallback Constants", () => {
  const originalEnv = process.env.PRICE_SOURCE;

  afterEach(() => {
    process.env.PRICE_SOURCE = originalEnv;
    clearPriceCache();
    setPricingClient(null);
  });

  it("defaults to 'bulk' when PRICE_SOURCE is unset", () => {
    delete process.env.PRICE_SOURCE;
    assert.equal(getPriceSourceMode(), "bulk");
  });

  it("defaults to 'bulk' when PRICE_SOURCE is 'bulk' or invalid", () => {
    process.env.PRICE_SOURCE = "bulk";
    assert.equal(getPriceSourceMode(), "bulk");

    process.env.PRICE_SOURCE = "other_source";
    assert.equal(getPriceSourceMode(), "bulk");
  });

  it("enables 'sdk' when PRICE_SOURCE is 'sdk' (case-insensitive)", () => {
    process.env.PRICE_SOURCE = "sdk";
    assert.equal(getPriceSourceMode(), "sdk");

    process.env.PRICE_SOURCE = "SDK";
    assert.equal(getPriceSourceMode(), "sdk");
  });

  it("preserves exact FALLBACK_PRICES values and coverage", () => {
    assert.equal(FALLBACK_PRICES.EC2, 0.023);
    assert.equal(FALLBACK_PRICES.Lambda, 0.0000166667);
    assert.equal(FALLBACK_PRICES.S3, 0.023);
    assert.equal(FALLBACK_PRICES.RDS, 0.017);
    assert.equal(FALLBACK_PRICES.DynamoDB, 0.00000025);
    assert.equal(FALLBACK_PRICES.ECS, 0.04048);
    assert.equal(FALLBACK_PRICES.CloudFront, 0.0085);
    assert.equal(FALLBACK_PRICES.APIGateway, 3.50);
    assert.equal(FALLBACK_PRICES.SQS, 0.40);
    assert.equal(FALLBACK_PRICES.SNS, 0.50);

    // Ensure all entries are valid positive numbers
    for (const [service, price] of Object.entries(FALLBACK_PRICES)) {
      assert.ok(typeof price === "number" && price > 0, `Invalid price for ${service}: ${price}`);
    }
  });

  it("defines complete region mappings for location and prefixes", () => {
    assert.equal(REGION_LOCATION["us-east-1"], "US East (N. Virginia)");
    assert.equal(REGION_LOCATION["eu-west-1"], "EU (Ireland)");
    assert.equal(REGION_LOCATION["ap-south-1"], "Asia Pacific (Mumbai)");

    assert.equal(REGION_USAGE_PREFIX["us-east-1"], "");
    assert.equal(REGION_USAGE_PREFIX["us-east-2"], "USE2-");
    assert.equal(REGION_USAGE_PREFIX["eu-west-1"], "EU-");
  });
});

describe("PriceService — Bulk Path & Cache Behavior", () => {
  beforeEach(() => {
    clearPriceCache();
    delete process.env.PRICE_SOURCE;
  });

  afterEach(() => {
    clearPriceCache();
  });

  it("falls back to FALLBACK_PRICES with source='fallback' for unconfigured serviceCode", async () => {
    const res = await getUnitPrice("Lightsail", null, null, "us-east-1");
    assert.equal(res.price, FALLBACK_PRICES.Lightsail);
    assert.equal(res.source, "fallback");
  });

  it("falls back to FALLBACK_PRICES with source='fallback' when bulk fetch fails", async () => {
    const res = await getUnitPrice("EC2", "NonExistentService", "InvalidPrefix", "us-east-1");
    assert.equal(res.price, FALLBACK_PRICES.EC2);
    assert.equal(res.source, "fallback");
  });

  it("caches lookup results with source retention", async () => {
    assert.equal(getPriceCacheSize(), 0);

    const first = await getUnitPrice("EC2", "AmazonEC2", "NonExistentPrefix", "us-east-1");
    assert.equal(first.source, "fallback");
    assert.equal(getPriceCacheSize(), 1);

    const second = await getUnitPrice("EC2", "AmazonEC2", "NonExistentPrefix", "us-east-1");
    assert.equal(second.price, first.price);
    assert.equal(second.source, "fallback");
  });
});

describe("PriceService — SDK Path (@aws-sdk/client-pricing)", () => {
  beforeEach(() => {
    clearPriceCache();
    process.env.PRICE_SOURCE = "sdk";
  });

  afterEach(() => {
    clearPriceCache();
    setPricingClient(null);
    delete process.env.PRICE_SOURCE;
  });

  it("falls back cleanly to FALLBACK_PRICES on missing credentials / client failure", async () => {
    // Inject a client that rejects (simulating AccessDenied or missing creds)
    const failingClient = {
      send: async () => {
        const err = new Error("The security token included in the request is invalid");
        err.name = "UnrecognizedClientException";
        throw err;
      },
    } as any;

    setPricingClient(failingClient);

    const res = await getUnitPrice("EC2", "AmazonEC2", "BoxUsage:t3.small", "us-east-1");
    assert.equal(res.price, FALLBACK_PRICES.EC2);
    assert.equal(res.source, "fallback");
  });

  it("extracts unit price from SDK GetProducts PriceList response (Format 1)", () => {
    const mockPriceList = [
      JSON.stringify({
        product: {
          attributes: {
            servicecode: "AmazonEC2",
            usagetype: "BoxUsage:t3.small",
            location: "US East (N. Virginia)",
          },
        },
        terms: {
          OnDemand: {
            "TESTSKU.TERM1": {
              priceDimensions: {
                "TESTSKU.TERM1.DIM1": {
                  pricePerUnit: { USD: "0.0208" },
                },
              },
            },
          },
        },
      }),
    ];

    const price = extractPriceFromPriceList(mockPriceList, "BoxUsage:t3.small");
    assert.equal(price, 0.0208);
  });

  it("extracts unit price from SDK GetProducts PriceList response (Format 2: sku-nested terms)", () => {
    const mockPriceList = [
      JSON.stringify({
        product: {
          attributes: {
            servicecode: "AmazonEC2",
            usagetype: "USE2-BoxUsage:t3.small",
            location: "US East (Ohio)",
          },
        },
        terms: {
          OnDemand: {
            TESTSKU: {
              TERM1: {
                priceDimensions: {
                  DIM1: {
                    pricePerUnit: { USD: "0.0215" },
                  },
                },
              },
            },
          },
        },
      }),
    ];

    const price = extractPriceFromPriceList(mockPriceList, "BoxUsage:t3.small");
    assert.equal(price, 0.0215);
  });

  it("returns live price with source='live' when SDK client succeeds", async () => {
    const mockClient = {
      send: async (cmd: any) => {
        return {
          PriceList: [
            JSON.stringify({
              product: {
                attributes: {
                  servicecode: "AmazonEC2",
                  usagetype: "BoxUsage:t3.small",
                  location: "US East (N. Virginia)",
                },
              },
              terms: {
                OnDemand: {
                  "SKU123.JRTCKXETXF": {
                    priceDimensions: {
                      "SKU123.JRTCKXETXF.6YS6EN2CT7": {
                        pricePerUnit: { USD: "0.0208000000" },
                      },
                    },
                  },
                },
              },
            }),
          ],
        };
      },
    } as any;

    setPricingClient(mockClient);

    const res = await getUnitPrice("EC2", "AmazonEC2", "BoxUsage:t3.small", "us-east-1");
    assert.equal(res.price, 0.0208);
    assert.equal(res.source, "live");

    // Cache hit should also return live
    const cached = await getUnitPrice("EC2", "AmazonEC2", "BoxUsage:t3.small", "us-east-1");
    assert.equal(cached.price, 0.0208);
    assert.equal(cached.source, "live");
  });

  it("falls back to FALLBACK_PRICES when SDK returns empty PriceList", async () => {
    const mockClient = {
      send: async () => ({ PriceList: [] }),
    } as any;

    setPricingClient(mockClient);

    const res = await getUnitPrice("EC2", "AmazonEC2", "BoxUsage:t3.small", "us-east-1");
    assert.equal(res.price, FALLBACK_PRICES.EC2);
    assert.equal(res.source, "fallback");
  });
});

describe("CostService — Integration & Shape Stability", () => {
  beforeEach(() => {
    clearPriceCache();
  });

  afterEach(() => {
    clearPriceCache();
    setPricingClient(null);
    delete process.env.PRICE_SOURCE;
  });

  it("computes cost rows under default bulk path with disclosure intact", async () => {
    const plan = makeTestPlan();
    const result = await computeCostRows(plan, "us-east-1", 10_000);

    assert.equal(result.region, "us-east-1");
    assert.equal(result.userCount, 10_000);
    assert.equal(result.rows.length, 3);
    assert.equal(result.priceSourceMode, "bulk");

    for (const row of result.rows) {
      assert.ok(["live", "fallback"].includes(row.priceSource), `Invalid priceSource: ${row.priceSource}`);
      assert.ok(row.unitPrice > 0);
      assert.ok(row.monthlyUsd >= 0);
      assert.ok(row.quantity > 0);
      assert.ok(typeof row.unitLabel === "string" && row.unitLabel.length > 0);
      assert.ok(typeof row.annotation === "string" && row.annotation.length > 0);
    }
  });

  it("computes cost rows under SDK path with identical public shape", async () => {
    process.env.PRICE_SOURCE = "sdk";

    const mockClient = {
      send: async (cmd: any) => {
        const filters = cmd.input.Filters || [];
        const isS3 = cmd.input.ServiceCode === "AmazonS3";
        const price = isS3 ? "0.025" : "0.00002";
        return {
          PriceList: [
            JSON.stringify({
              product: { attributes: { usagetype: isS3 ? "TimedStorage-ByteHrs" : "Lambda-GB-Second" } },
              terms: {
                OnDemand: {
                  TERM: { priceDimensions: { DIM: { pricePerUnit: { USD: price } } } },
                },
              },
            }),
          ],
        };
      },
    } as any;

    setPricingClient(mockClient);

    const plan = makeTestPlan();
    const result = await computeCostRows(plan, "us-east-1", 10_000, "sdk");

    assert.equal(result.priceSourceMode, "sdk");
    assert.equal(result.rows.length, 3);

    const s3Row = result.rows.find((r) => r.serviceId === "S3");
    assert.ok(s3Row);
    assert.equal(s3Row.unitPrice, 0.025);
    assert.equal(s3Row.priceSource, "live");
  });

  it("scales cost rows purely client-side without mutating source disclosures", async () => {
    const plan = makeTestPlan();
    const original = await computeCostRows(plan, "us-east-1", 10_000);
    const scaled = scaleCostRows(original, 50_000);

    assert.equal(scaled.userCount, 50_000);
    assert.equal(scaled.rows.length, original.rows.length);

    // Quantities and totals scaled 5x
    for (let i = 0; i < scaled.rows.length; i++) {
      assert.equal(scaled.rows[i].priceSource, original.rows[i].priceSource);
      assert.equal(scaled.rows[i].unitPrice, original.rows[i].unitPrice);
      assert.ok(Math.abs(scaled.rows[i].quantity - original.rows[i].quantity * 5) < 0.001);
    }
  });

  it("captures unpriced services in unpricedRows instead of dropping them", async () => {
    const plan: ServicePlan = {
      ...makeTestPlan(),
      components: [
        { id: "c-custom", type: "backend", technology: "CustomService", evidence: ["custom"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "c-custom", serviceId: "CustomService" as any, confidence: "high", evidence: "custom", fromPattern: false },
      ],
    };

    const result = await computeCostRows(plan, "us-east-1", 10_000);
    assert.equal(result.rows.length, 0);
    assert.equal(result.unpricedRows.length, 1);
    assert.equal(result.unpricedRows[0].serviceId, "CustomService");
  });
});
