"use client";

import React, { useState } from "react";
import type { Diagnostic, Grounding, PipelineEngine, ServicePlan } from "@/lib/schema";
import {
  AlertTriangle,
  Info,
  ChevronDown,
  ShieldAlert,
  ArrowRight,
  Sparkles,
  FileCheck2,
  FileCode,
  Cpu,
} from "lucide-react";

/**
 * Shows which inference path produced the result. Before this existed the
 * API returned `engine` but the UI never displayed it, so an LLM outage
 * looked identical to a successful AI analysis.
 */
export function EngineBanner({
  engine,
  diagnostics,
}: {
  engine?: PipelineEngine;
  diagnostics?: Diagnostic[];
}) {
  const [open, setOpen] = useState(false);
  if (!engine) return null;
  const variants: Record<PipelineEngine, { title: string; body: string; cls: string }> = {
    llm: {
      title: "Mode: AI-enhanced",
      body: "An AI model described the application from the evidence; AWS services were then selected by the deterministic rules.",
      cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    },
    rules: {
      title: "Mode: Rules-only",
      body: "No AI provider is configured. Services were selected by the deterministic rule engine from the detected evidence.",
      cls: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    },
    "rules-fallback": {
      title: "Mode: AI failed — rules baseline used",
      body: "An AI provider is configured but did not return a usable result for this request, so the deterministic rule engine answered instead.",
      cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    },
  };
  const v = variants[engine];
  const shown = (diagnostics ?? []).filter((d) => d.severity !== "info" || engine !== "rules");
  return (
    <div className={`mb-6 rounded-2xl border p-4 text-xs backdrop-blur-md ${v.cls}`} data-testid="engine-banner" data-engine={engine}>
      <div className="flex items-start gap-3">
        <Cpu className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="flex-1">
          <span className="font-semibold">{v.title}</span>
          <p className="mt-0.5 opacity-80">{v.body}</p>
          {shown.length > 0 && (
            <button
              className="mt-2 inline-flex items-center gap-1 underline underline-offset-2 opacity-90"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {open ? "Hide" : "Show"} pipeline diagnostics ({shown.length})
            </button>
          )}
          {open && (
            <ul className="mt-2 space-y-1 font-mono text-[11px] opacity-90">
              {shown.map((d, i) => (
                <li key={`${d.code}-${i}`}>
                  [{d.severity}] {d.stage}/{d.code}: {d.message}
                  {d.detail ? ` — ${d.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function GroundingBanner({ grounding }: { grounding: Grounding }) {
  if (grounding === "repo" || grounding === "repoFiles") {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-300 backdrop-blur-md">
        <FileCheck2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
        <div>
          <span className="font-semibold text-emerald-200">
            Grounding Verified: Repository Code Inspected
          </span>
          <p className="mt-0.5 text-emerald-300/80">
            AWS cloud architecture and service mappings were inferred directly from package manifests, source entrypoints, and infrastructure configurations.
          </p>
        </div>
      </div>
    );
  }

  if (grounding === "filenameOnly") {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-300 backdrop-blur-md">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
        <div>
          <span className="font-semibold text-amber-200">
            Inferred from repository file names only
          </span>
          <p className="mt-0.5 text-amber-300/80">
            File contents could not be retrieved from GitHub. Confidence ratings have been appropriately capped at <span className="font-mono text-amber-100 font-bold">low</span>.
          </p>
        </div>
      </div>
    );
  }

  if (grounding === "unfounded") {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300 backdrop-blur-md">
        <ShieldAlert className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
        <div>
          <span className="font-semibold text-red-200">
            Unfounded inference baseline
          </span>
          <p className="mt-0.5 text-red-300/80">
            Repository was inaccessible and no file signals were resolved. Architecture is provided using generic fallback defaults.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-4 text-xs text-accent-light backdrop-blur-md">
      <Sparkles className="h-4 w-4 shrink-0 text-accent mt-0.5" />
      <div>
        <span className="font-semibold text-foreground">
          Inferred from project description
        </span>
        <p className="mt-0.5 text-muted">
          Synthesized from your natural language requirements. Service confidence is calibrated to baseline assumptions.
        </p>
      </div>
    </div>
  );
}

export function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mb-6 space-y-2">
      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400 mt-0.5" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

export function AssumptionsDisclosure({ plan }: { plan: ServicePlan }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-surface/80 shadow-md backdrop-blur-md">
      <button
        className="flex w-full items-center justify-between px-5 py-3.5 text-xs font-semibold uppercase tracking-wider text-muted transition-colors hover:bg-surface-2"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Info className="h-4 w-4 text-accent" />
          Inference Rationale & Evidence ({plan.components.length} components, {plan.awsMappings.length} AWS services)
        </span>
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-200 ${
            open ? "rotate-180 text-accent" : ""
          }`}
        />
      </button>

      {open && (
        <ul className="divide-y divide-border/60 border-t border-border bg-surface-2/30">
          {plan.awsMappings.map((mapping, idx) => {
            const component = plan.components.find((c) => c.id === mapping.componentId);
            return (
              <li key={`${mapping.componentId}-${mapping.serviceId}-${idx}`} className="flex flex-col gap-1 px-5 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`inline-block rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                      mapping.confidence === "high"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : mapping.confidence === "medium"
                        ? "bg-sky-500/15 text-sky-400"
                        : "bg-muted/20 text-muted"
                    }`}
                  >
                    {mapping.confidence}
                  </span>
                  <span className="font-bold text-foreground">{mapping.serviceId}</span>
                  {component && (
                    <span className="font-mono text-muted">({component.type})</span>
                  )}
                </div>
                <p className="text-muted text-xs sm:text-right">{mapping.evidence}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function InsufficientSignalCard({
  message,
  repoName,
  readmeSnippet,
  onSwitchToDescription,
}: {
  message: string;
  repoName: string;
  readmeSnippet?: string;
  onSwitchToDescription: (prefill?: string) => void;
}) {
  return (
    <div className="mb-8 rounded-3xl border border-amber-500/30 bg-gradient-to-b from-amber-500/10 to-surface/90 p-6 shadow-xl backdrop-blur-md sm:p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-400">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-amber-200">
            Limited signal from this repository
          </h3>
          <p className="text-xs text-amber-300/80">{message}</p>
        </div>
      </div>

      {readmeSnippet && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-surface-2/60 p-4 text-xs italic text-muted">
          <p className="font-mono text-[10px] uppercase text-muted/70 not-italic mb-1">
            Detected README snippet:
          </p>
          &ldquo;{readmeSnippet}…&rdquo;
        </div>
      )}

      <div className="mt-6 flex items-center justify-end">
        <button
          onClick={() =>
            onSwitchToDescription(
              readmeSnippet ? `${repoName}: ${readmeSnippet}` : undefined
            )
          }
          className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/20 px-5 py-2 text-xs font-semibold text-amber-200 shadow-md transition-all hover:bg-amber-500/30 hover:border-amber-400/70 active:scale-95"
        >
          <span>Switch to Freeform Description</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}