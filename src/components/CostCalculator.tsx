"use client";

import React, { useState, useCallback } from "react";
import type { CostResult } from "@/lib/cost";
import type { ServicePlan } from "@/lib/schema";
import { scaleCostRows } from "@/lib/cost";
import {
  DollarSign,
  Globe2,
  Users,
  AlertCircle,
  CheckCircle2,
  Info,
  ExternalLink,
  Sparkles,
  RefreshCw,
} from "lucide-react";

export interface CostCalculatorProps {
  initialCost: CostResult;
  servicePlan: ServicePlan;
}

const REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "eu-west-1", label: "EU (Ireland)" },
  { value: "eu-west-2", label: "EU (London)" },
  { value: "eu-central-1", label: "EU (Frankfurt)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "sa-east-1", label: "South America (São Paulo)" },
  { value: "ca-central-1", label: "Canada (Central)" },
];

const USER_PRESETS = [100, 1_000, 10_000, 100_000, 1_000_000];

function formatUserCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n < 0.01) return "< $0.01";
  return `$${n.toFixed(2)}`;
}

function logToLinear(logVal: number): number {
  return Math.round(100 * Math.pow(10000, logVal));
}

function linearToLog(linear: number): number {
  return Math.log10(linear / 100) / Math.log10(10000);
}

export function CostCalculator({
  initialCost,
  servicePlan,
}: CostCalculatorProps) {
  const [costData, setCostData] = useState<CostResult>(initialCost);
  const [sliderVal, setSliderVal] = useState(linearToLog(initialCost.userCount));
  const [region, setRegion] = useState(initialCost.region);
  const [isRefetching, setIsRefetching] = useState(false);
  const [refetchError, setRefetchError] = useState<string | null>(null);

  const displayedUserCount = Math.round(logToLinear(sliderVal));

  // Client-side instant recalculation
  const scaledCost = scaleCostRows(costData, displayedUserCount);

  // Region change handler -> POST /api/prices
  const handleRegionChange = useCallback(
    async (newRegion: string) => {
      setRegion(newRegion);
      setIsRefetching(true);
      setRefetchError(null);
      try {
        const res = await fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_plan: servicePlan,
            region: newRegion,
            userCount: displayedUserCount,
          }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error: string };
          throw new Error(err.error ?? "Request failed");
        }
        const data = (await res.json()) as { cost_rows: CostResult };
        setCostData(data.cost_rows);
        setSliderVal(linearToLog(data.cost_rows.userCount));
      } catch (err) {
        setRefetchError((err as Error).message ?? "Failed to fetch prices");
      } finally {
        setIsRefetching(false);
      }
    },
    [servicePlan, displayedUserCount]
  );

  const currentRegionLabel =
    REGIONS.find((r) => r.value === region)?.label ?? region;

  const livePricesCount = scaledCost.rows.filter((r) => r.priceSource === "live").length;

  return (
    <div className="flex flex-col gap-6">
      {/* Top Highlights Summary Card */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Total Cost Card */}
        <div className="relative overflow-hidden rounded-2xl border border-accent/25 bg-gradient-to-br from-surface via-surface to-surface-2 p-5 shadow-lg backdrop-blur-md">
          <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-accent/15 blur-2xl" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">
              Estimated Monthly Total
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              {formatUsd(scaledCost.totalMonthlyUsd)}
            </span>
            <span className="text-xs text-muted">/ month</span>
          </div>
          <p className="mt-2 text-xs text-muted">
            Scaled for{" "}
            <span className="font-semibold text-accent">
              {formatUserCount(displayedUserCount)}
            </span>{" "}
            active users in {region}
          </p>
        </div>

        {/* User Scale Controller Card */}
        <div className="rounded-2xl border border-border bg-surface/80 p-5 shadow-md backdrop-blur-md sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-accent" />
              <label className="text-xs font-medium uppercase tracking-wider text-muted">
                Traffic & Scale Simulator
              </label>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-sm font-semibold text-foreground">
              <span className="rounded-md bg-surface-2 px-2.5 py-1 text-accent border border-border">
                {displayedUserCount.toLocaleString()} Monthly Active Users
              </span>
            </div>
          </div>

          <div className="mt-4">
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={sliderVal}
              onChange={(e) => setSliderVal(parseFloat(e.target.value))}
              className="w-full"
            />
            {/* Quick Preset Buttons */}
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-muted">Quick presets:</span>
              <div className="flex items-center gap-1.5">
                {USER_PRESETS.map((p) => {
                  const isActive =
                    Math.abs(linearToLog(p) - sliderVal) < 0.05;
                  return (
                    <button
                      key={p}
                      onClick={() => setSliderVal(linearToLog(p))}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-mono transition-all ${
                        isActive
                          ? "bg-accent text-on-accent font-semibold shadow-sm"
                          : "bg-surface-2 text-muted hover:text-foreground hover:bg-surface-3"
                      }`}
                    >
                      {formatUserCount(p)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Region Picker Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface-2/40 p-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <Globe2 className="h-4 w-4 text-accent" />
          <div>
            <span className="text-xs font-medium text-foreground">
              AWS Target Deployment Region
            </span>
            <p className="text-[11px] text-muted">
              Live unit rates are queried from the AWS Price List API for this region
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isRefetching && (
            <div className="flex items-center gap-1.5 text-xs text-accent">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>Fetching regional prices…</span>
            </div>
          )}
          <select
            value={region}
            onChange={(e) => handleRegionChange(e.target.value)}
            disabled={isRefetching}
            className="rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground transition-all hover:border-accent/40 focus:border-accent focus:outline-none disabled:opacity-50"
          >
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value} className="bg-surface text-foreground">
                {r.label} ({r.value})
              </option>
            ))}
          </select>
        </div>
      </div>

      {refetchError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <span>
            Could not update prices for selected region: {refetchError}. Showing
            cached rates.
          </span>
        </div>
      )}

      {/* Itemized Cost Breakdown Table */}
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Service Cost Breakdown ({scaledCost.rows.length} priced services)
          </h4>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-[10px] font-medium text-accent">
              <Sparkles className="h-3 w-3" />
              {livePricesCount} Live AWS Rates
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead>
              <tr className="bg-surface-2/50 text-left text-[11px] font-medium uppercase tracking-wider text-muted">
                <th className="px-5 py-3">AWS Service</th>
                <th className="px-4 py-3">Billing Unit</th>
                <th className="px-4 py-3 text-right">Scaled Quantity</th>
                <th className="px-4 py-3 text-right">Unit Price</th>
                <th className="px-5 py-3 text-right">Monthly Subtotal</th>
                <th className="px-4 py-3 text-center">Data Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 bg-transparent">
              {scaledCost.rows.map((row) => (
                <tr
                  key={`${row.componentId}-${row.serviceId}`}
                  className="transition-colors hover:bg-surface-2/40"
                >
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <div className="font-semibold text-foreground">
                      {row.serviceId}
                    </div>
                    <div className="text-[11px] text-muted">
                      {row.componentId} · {row.annotation}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-xs text-muted">
                    {row.unitLabel}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-right font-mono text-xs text-muted-foreground">
                    {row.quantity >= 1_000_000
                      ? `${(row.quantity / 1_000_000).toFixed(1)}M`
                      : row.quantity >= 1_000
                      ? `${(row.quantity / 1_000).toFixed(1)}k`
                      : row.quantity.toFixed(1)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-right font-mono text-xs text-muted-foreground">
                    ${row.unitPrice.toPrecision(4)}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-right font-mono text-sm font-semibold text-foreground">
                    {formatUsd(row.monthlyUsd)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-center">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                        row.priceSource === "live"
                          ? "bg-accent/15 text-accent border border-accent/25"
                          : "bg-surface-2 text-muted border border-border"
                      }`}
                      title={
                        row.priceSource === "live"
                          ? "Fetched live via AWS Price List API"
                          : "Static catalog benchmark fallback"
                      }
                    >
                      {row.priceSource === "live" ? "live aws" : "fallback"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2/70 border-t border-border">
                <td
                  colSpan={4}
                  className="px-5 py-4 text-sm font-semibold text-foreground"
                >
                  Estimated Monthly Total ({scaledCost.rows.length} services)
                </td>
                <td className="px-5 py-4 text-right text-lg font-bold text-accent font-mono">
                  {formatUsd(scaledCost.totalMonthlyUsd)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Unpriced Services Section */}
      {scaledCost.unpricedRows.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface-2/40 p-4 backdrop-blur-md">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted">
            <Info className="h-4 w-4 text-accent" />
            <span>Infrastructure components without direct monthly unit billing:</span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {scaledCost.unpricedRows.map((r) => (
              <div
                key={r.serviceId}
                className="flex items-start gap-2 rounded-xl bg-surface/60 p-2.5 text-xs text-muted border border-border/50"
              >
                <span className="font-semibold text-foreground">
                  {r.serviceId}
                </span>
                <span className="text-muted/80">— {r.note}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className="rounded-xl border border-border/60 bg-surface/30 px-4 py-3 text-center text-xs text-muted/70">
        <p>
          <strong className="text-foreground/80">Estimation Advisory:</strong> This estimate is modeled from baseline architectural usage and standard On-Demand pricing. It does not include free tier allowances, Savings Plans, Reserved Instances, or data egress fees. For formal production quotes, refer to the{" "}
          <a
            href="https://calculator.aws"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-accent-light"
          >
            AWS Pricing Calculator <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
      </div>
    </div>
  );
}
