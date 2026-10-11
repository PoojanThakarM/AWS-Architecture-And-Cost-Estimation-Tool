"use client";

/**
 * page.tsx — Main application UI
 *
 * Client Component:
 * - Serene, minimal pastel/lavender interface
 * - Centered primary interaction container (GitHub URL / Project description)
 * - Animated circular breathing analysis visualization during loading
 * - Multi-stage progress tracking
 * - Results presentation (Diagram, Cost breakdown with slider, Stack profile, Assumptions)
 * - Pure client-side cost scaling via scaleCostRows
 * - Region price updates via POST /api/prices
 */

import React, { useState, useCallback, useRef } from "react";
import type { CostResult } from "@/lib/cost";
import type { ServicePlan, Grounding } from "@/lib/schema";
import type { ProjectProfile } from "@/lib/repoAnalyzer";
import type { ArchitectureModel } from "@/lib/architecture";

import { AnalysisVisualizer } from "@/components/AnalysisVisualizer";
import { DiagramViewer } from "@/components/DiagramViewer";
import { CostCalculator } from "@/components/CostCalculator";
import { ArchitectureStack } from "@/components/ArchitectureStack";
import {
  GroundingBanner,
  WarningsBanner,
  AssumptionsDisclosure,
  InsufficientSignalCard,
} from "@/components/Banners";

import {
  FileText,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Layers,
  DollarSign,
  Compass,
  CheckCircle,
  HelpCircle,
  Code,
  ShieldAlert,
  Download,
  Copy,
  Check,
} from "lucide-react";

function GithubIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types matching /api/analyze response
// ---------------------------------------------------------------------------
interface AnalyzeResponse {
  input_kind: "github_url" | "description";
  grounding: Grounding;
  service_plan: ServicePlan;
  service_plans?: ServicePlan[];
  diagram_xml: string | null;
  diagram_xmls?: (string | null)[];
  cost_rows: CostResult | null;
  cost_rows_list?: (CostResult | null)[];
  warnings: string[];
  project_profile?: ProjectProfile;
  architecture_model?: ArchitectureModel;
}

interface InsufficientSignalResponse {
  status: "insufficient_signal";
  message: string;
  prefill: { repoName: string; readmeSnippet: string };
}

type ApiResult = AnalyzeResponse | InsufficientSignalResponse;

// Sample repositories for quick exploration
const SAMPLE_REPOS = [
  { name: "vercel/next.js", url: "https://github.com/vercel/next.js", label: "Fullstack Web" },
  { name: "expressjs/express", url: "https://github.com/expressjs/express", label: "Node API" },
  { name: "fastapi/fastapi", url: "https://github.com/fastapi/fastapi", label: "Python API" },
  { name: "supabase/supabase", url: "https://github.com/supabase/supabase", label: "Database / Auth" },
];

const SAMPLE_PROMPTS = [
  "Next.js web app with PostgreSQL database, Redis cache, and S3 file storage.",
  "Serverless image processing API with AWS Lambda, S3 bucket trigger, and DynamoDB.",
  "Containerized microservices with Docker, background Celery queue, and RDS PostgreSQL.",
];

function formatAnalysisReport(res: AnalyzeResponse): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("AWS ARCHITECTURE & SERVICE REQUIREMENTS ANALYSIS REPORT");
  lines.push("================================================================================");
  lines.push(`Input Kind:         ${res.input_kind}`);
  lines.push(`Grounding Level:    ${res.grounding}`);
  lines.push(`Detected Pattern:   ${res.service_plan.detectedPattern ?? "generic"}`);
  lines.push(`Mapped AWS Services: ${res.service_plan.awsMappings.length}`);
  if (res.cost_rows) {
    lines.push(`Monthly Estimate:   $${res.cost_rows.totalMonthlyUsd.toFixed(2)} USD/mo (${res.cost_rows.region}, 10,000 users)`);
  }
  lines.push("================================================================================\n");

  lines.push("1. INFERRED AWS CLOUD SERVICES REQUIRED");
  lines.push("--------------------------------------------------------------------------------");
  res.service_plan.awsMappings.forEach((m, idx) => {
    lines.push(`[${idx + 1}] Service:    ${m.serviceId}`);
    lines.push(`    Component:  ${m.componentId}`);
    lines.push(`    Confidence: ${m.confidence.toUpperCase()}`);
    lines.push(`    Evidence:   ${m.evidence}`);
    lines.push("");
  });

  lines.push("2. DISCOVERED APPLICATION COMPONENTS");
  lines.push("--------------------------------------------------------------------------------");
  res.service_plan.components.forEach((c, idx) => {
    lines.push(`[${idx + 1}] ID:         ${c.id}`);
    lines.push(`    Type:       ${c.type}`);
    lines.push(`    Technology: ${c.technology}`);
    lines.push(`    Status:     ${c.status} (${c.confidence} confidence)`);
    if (c.evidence.length > 0) {
      lines.push(`    Evidence:   ${c.evidence.join("; ")}`);
    }
    lines.push("");
  });

  if (res.project_profile) {
    const p = res.project_profile;
    lines.push("3. REPOSITORY CODE SIGNALS & TECH STACK");
    lines.push("--------------------------------------------------------------------------------");
    if (p.languages?.length) {
      lines.push(`Languages:      ${p.languages.map((l) => `${l.name} (${l.evidence})`).join(", ")}`);
    }
    if (p.frameworks?.length) {
      lines.push(`Frameworks:     ${p.frameworks.map((f) => `${f.name} (${f.evidence})`).join(", ")}`);
    }
    if (p.databases?.length) {
      lines.push(`Databases:      ${p.databases.map((d) => `${d.name} (${d.evidence})`).join(", ")}`);
    }
    if (p.infrastructure?.length) {
      lines.push(`Infrastructure: ${p.infrastructure.map((i) => `${i.name} (${i.evidence})`).join(", ")}`);
    }
    if (p.awsUsage?.length) {
      lines.push(`AWS SDK Calls:  ${p.awsUsage.map((a) => `${a.name} (${a.evidence})`).join(", ")}`);
    }
    lines.push("");
  }

  if (res.warnings?.length) {
    lines.push("4. WARNINGS & ADVISORIES");
    lines.push("--------------------------------------------------------------------------------");
    res.warnings.forEach((w) => lines.push(`• ${w}`));
    lines.push("");
  }

  lines.push("================================================================================");
  lines.push("END OF REPORT");
  lines.push("================================================================================");
  return lines.join("\n");
}

export default function Home() {
  // Input state
  const [activeTab, setActiveTab] = useState<"github" | "description">("github");
  const [githubUrl, setGithubUrl] = useState("");
  const [description, setDescription] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [insufficientSignal, setInsufficientSignal] =
    useState<InsufficientSignalResponse | null>(null);
  const [resultTab, setResultTab] = useState<"diagram" | "cost" | "stack" | "assumptions" | "raw">("diagram");
  const [copiedText, setCopiedText] = useState(false);

  // Keep track of what was submitted for the visualizer
  const submittedValueRef = useRef("");

  // Submission handler
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      setError(null);
      setResult(null);
      setInsufficientSignal(null);
      setAnalysisComplete(false);
      setShowResults(false);
      setLoading(true);

      const targetValue = activeTab === "github" ? githubUrl.trim() : description.trim();
      submittedValueRef.current = targetValue;

      const input =
        activeTab === "github"
          ? { kind: "github_url" as const, value: targetValue }
          : { kind: "description" as const, value: targetValue };

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });

        let data: ApiResult | null = null;
        try {
          data = (await res.json()) as ApiResult;
        } catch {
          // Empty or non-JSON response body
        }

        if (!res.ok) {
          setError(
            (data as { error?: string } | null)?.error ??
              `Server error (HTTP ${res.status})`
          );
          setLoading(false);
          return;
        }

        if (!data) {
          setError("Server returned empty or invalid response");
          setLoading(false);
          return;
        }

        if ("status" in data && data.status === "insufficient_signal") {
          setInsufficientSignal(data as InsufficientSignalResponse);
          setLoading(false);
          return;
        }

        setResult(data as AnalyzeResponse);
        setAnalysisComplete(true);
        // AnalysisVisualizer will call onTransitionComplete when the 100% animation wraps up
      } catch (err) {
        setError((err as Error).message ?? "Network connection error");
        setLoading(false);
      }
    },
    [activeTab, githubUrl, description]
  );

  // Transition from visualizer to results
  const handleTransitionToResults = useCallback(() => {
    setLoading(false);
    setShowResults(true);
    setResultTab("diagram");
  }, []);

  // Reset to initial input state
  const handleReset = useCallback(() => {
    setShowResults(false);
    setResult(null);
    setError(null);
    setInsufficientSignal(null);
    setLoading(false);
    setAnalysisComplete(false);
  }, []);

  // Switch to description tab and prefill from insufficient signal
  const handleSwitchToDescription = useCallback((prefill?: string) => {
    if (prefill) setDescription(prefill);
    setActiveTab("description");
    setInsufficientSignal(null);
    setError(null);
  }, []);

  const diagramFilename = result
    ? `${result.service_plan.detectedPattern ?? "generic"}-architecture.drawio`
    : "architecture.drawio";

  return (
    <div className="relative flex min-h-screen flex-col font-sans">
      {/* Top Ambient Navigation Bar */}
      <header className="sticky top-0 z-40 border-b border-border/40 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent to-indigo-500 text-on-accent shadow-[0_0_20px_rgba(167,139,250,0.35)]">
              <Compass className="h-5 w-5" />
            </div>
            <div>
              <span className="font-semibold tracking-tight text-foreground sm:text-base">
                AWS Architect
              </span>
              <span className="ml-2 hidden rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent sm:inline">
                SGP Cloud Modeler
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {showResults && (
              <button
                onClick={handleReset}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted transition-all hover:border-accent/40 hover:text-foreground active:scale-95"
              >
                <RefreshCw className="h-3 w-3" />
                <span>New Analysis</span>
              </button>
            )}
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface-2/60 px-3.5 py-1.5 text-xs font-medium text-muted transition-all hover:border-accent/40 hover:text-foreground"
            >
              <GithubIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main
        className={`mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 sm:py-8 transition-all duration-300 ${
          !loading && showResults && resultTab === "diagram"
            ? "max-w-6xl xl:max-w-7xl"
            : "max-w-5xl"
        }`}
      >
        {/* ========================================================================= */}
        {/* 1. LOADING / ANALYSIS ANIMATED EXPERIENCE (The Star Feature)              */}
        {/* ========================================================================= */}
        {loading && (
          <div className="my-auto animate-fadeIn">
            <AnalysisVisualizer
              inputKind={activeTab === "github" ? "github_url" : "description"}
              inputValue={submittedValueRef.current}
              isComplete={analysisComplete}
              onTransitionComplete={handleTransitionToResults}
            />
          </div>
        )}

        {/* ========================================================================= */}
        {/* 2. RESULTS STATE                                                          */}
        {/* ========================================================================= */}
        {!loading && showResults && result && (
          <div className="flex flex-col gap-6 animate-fadeIn">
            {/* Top Blueprint Summary Hero Card */}
            <div className="glass-panel relative overflow-hidden rounded-3xl p-6 sm:p-8">
              <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 font-mono text-xs font-semibold text-accent-light">
                      <Sparkles className="h-3 w-3 text-accent" />
                      {(result.service_plan.detectedPattern ?? "generic")
                        .split("-")
                        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(" ")} Architecture
                    </span>
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
                      {result.service_plan.awsMappings.length} Cloud Services Mapped
                    </span>
                  </div>

                  <h2 className="mt-3 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                    Custom Cloud Architecture Blueprint
                  </h2>

                  <p className="mt-1 text-sm text-muted">
                    Inferred from{" "}
                    <span className="font-medium text-foreground">
                      {result.input_kind === "github_url" ? "GitHub Repository" : "Project Description"}
                    </span>
                    . Ready for diagram export and cost scaling.
                  </p>
                </div>

                {/* Quick Monthly Estimate Badge */}
                {result.cost_rows && (
                  <div className="flex flex-col items-start rounded-2xl border border-accent/25 bg-surface-2/60 p-4 shadow-sm backdrop-blur-md md:items-end">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      Est. Baseline Cost
                    </span>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-mono text-2xl font-bold text-accent sm:text-3xl">
                        ${result.cost_rows.totalMonthlyUsd.toFixed(2)}
                      </span>
                      <span className="text-xs text-muted">/ mo</span>
                    </div>
                    <span className="text-[10px] text-muted">
                      at 10,000 active users ({result.cost_rows.region})
                    </span>
                  </div>
                )}
              </div>

              {/* Navigation Tabs Pill Bar */}
              <div className="mt-8 flex flex-wrap gap-2 border-t border-border/70 pt-6">
                {[
                  { id: "diagram" as const, label: "Architecture Diagram", icon: Layers },
                  { id: "cost" as const, label: "Cost Estimation & Scaling", icon: DollarSign },
                  { id: "stack" as const, label: "Detected Stack & Cloud Services", icon: Code },
                  { id: "raw" as const, label: "Services List (.txt) & Diagnostics", icon: FileText },
                  { id: "assumptions" as const, label: "Inference Rationale", icon: HelpCircle },
                ].map((tab) => {
                  const isActive = resultTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setResultTab(tab.id)}
                      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-all active:scale-95 ${
                        isActive
                          ? "bg-accent text-on-accent font-semibold shadow-[0_0_15px_rgba(167,139,250,0.4)]"
                          : "bg-surface-2 text-muted hover:bg-surface-3 hover:text-foreground border border-border"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Grounding & Warnings Banners */}
            <GroundingBanner grounding={result.grounding} />
            <WarningsBanner warnings={result.warnings} />

            {/* Tab Views */}
            <div className="flex flex-1 flex-col min-h-[500px]">
              {resultTab === "diagram" &&
                (result.service_plans && result.service_plans.length > 1 && result.diagram_xmls ? (
                  <div className="flex flex-col gap-6 animate-fadeIn">
                    {result.service_plan.tradeOffDimension && (
                      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
                        <div className="flex items-center gap-2 text-primary font-semibold text-sm">
                          <Sparkles className="h-4 w-4" />
                          <span>Architectural Trade-Off Comparison: {result.service_plan.tradeOffDimension}</span>
                        </div>
                        {result.service_plan.tradeOffDescription && (
                          <p className="mt-1 text-xs text-muted leading-relaxed">
                            {result.service_plan.tradeOffDescription}
                          </p>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      {result.service_plans.map((plan, idx) => {
                        const xml = result.diagram_xmls?.[idx] ?? result.diagram_xml;
                        const title = plan.proposalTitle || `Proposal ${idx === 0 ? "A" : "B"}: ${plan.detectedPattern ?? "Architecture"}`;
                        return (
                          <div key={idx} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
                            <div className="flex items-center justify-between pb-2 border-b border-border">
                              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                                {idx === 0 ? "Primary Architecture" : "Alternate Proposal"}
                              </span>
                              <span className="text-xs font-medium text-foreground">{title}</span>
                            </div>
                            {xml ? (
                              <DiagramViewer
                                diagramXml={xml}
                                filename={`${(plan.detectedPattern ?? "arch").replace(/[^a-zA-Z0-9_-]/g, "-")}-proposal-${idx + 1}.drawio`}
                                patternTitle={plan.detectedPattern ?? "generic"}
                              />
                            ) : (
                              <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-surface-2 text-xs text-muted">
                                Diagram unavailable
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : result.diagram_xml ? (
                  <DiagramViewer
                    diagramXml={result.diagram_xml}
                    filename={diagramFilename}
                    patternTitle={result.service_plan.detectedPattern ?? "generic"}
                  />
                ) : (
                  <div className="flex h-64 items-center justify-center rounded-2xl border border-border bg-surface text-center text-sm text-muted">
                    Diagram generation unavailable for this specific configuration.
                  </div>
                ))}

              {resultTab === "cost" &&
                (result.service_plans && result.service_plans.length > 1 && result.cost_rows_list ? (
                  <div className="flex flex-col gap-6 animate-fadeIn">
                    {result.service_plan.tradeOffDimension && (
                      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
                        <div className="flex items-center gap-2 text-primary font-semibold text-sm">
                          <DollarSign className="h-4 w-4" />
                          <span>Cost Comparison: {result.service_plan.tradeOffDimension}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted leading-relaxed">
                          Side-by-side AWS cost estimates for both architectural proposals under identical usage parameters.
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      {result.service_plans.map((plan, idx) => {
                        const costData = result.cost_rows_list?.[idx] ?? result.cost_rows;
                        const title = plan.proposalTitle || `Proposal ${idx === 0 ? "A" : "B"}`;
                        return (
                          <div key={idx} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
                            <div className="flex items-center justify-between pb-2 border-b border-border">
                              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                                {idx === 0 ? "Primary Architecture" : "Alternate Proposal"}
                              </span>
                              <span className="text-xs font-medium text-foreground">{title}</span>
                            </div>
                            {costData ? (
                              <CostCalculator
                                initialCost={costData}
                                servicePlan={plan}
                              />
                            ) : (
                              <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-surface-2 text-xs text-muted">
                                Pricing unavailable
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : result.cost_rows ? (
                  <CostCalculator
                    initialCost={result.cost_rows}
                    servicePlan={result.service_plan}
                  />
                ) : (
                  <div className="flex h-64 items-center justify-center rounded-2xl border border-border bg-surface text-center text-sm text-muted">
                    Pricing catalog could not be computed for this configuration.
                  </div>
                ))}

              {resultTab === "stack" && (
                <ArchitectureStack
                  plan={result.service_plan}
                  projectProfile={result.project_profile}
                  architectureModel={result.architecture_model}
                />
              )}

              {resultTab === "raw" && (
                <div className="flex flex-col gap-4 animate-fadeIn">
                  {/* Action Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2 p-4">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Raw Analysis & Inferred Services Report
                      </h3>
                      <p className="text-xs text-muted">
                        Plain-text inspection of repository signals, component discovery, and mapped AWS services.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const text = formatAnalysisReport(result);
                          navigator.clipboard.writeText(text);
                          setCopiedText(true);
                          setTimeout(() => setCopiedText(false), 2000);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-muted transition-all hover:text-foreground hover:border-accent/40 active:scale-95"
                      >
                        {copiedText ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span className="text-emerald-300">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>Copy Text</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const text = formatAnalysisReport(result);
                          const blob = new Blob([text], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${diagramFilename.replace(/\.drawio$/, "")}-analysis.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/15 px-4 py-1.5 text-xs font-semibold text-accent-light shadow-sm transition-all hover:bg-accent/25 active:scale-95"
                      >
                        <Download className="h-3.5 w-3.5 text-accent" />
                        <span>Download .txt</span>
                      </button>
                    </div>
                  </div>

                  {/* Preformatted Monospace Code Block */}
                  <div className="overflow-x-auto rounded-2xl border border-border bg-surface p-5 shadow-lg">
                    <pre className="font-mono text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
                      {formatAnalysisReport(result)}
                    </pre>
                  </div>
                </div>
              )}

              {resultTab === "assumptions" && (
                <div className="rounded-2xl border border-border bg-surface p-6 shadow-md">
                  <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">
                    Inference Engine Assumptions & Justifications
                  </h3>
                  <AssumptionsDisclosure plan={result.service_plan} />
                  <p className="text-xs text-muted leading-relaxed">
                    The inference engine applies a two-tier analysis: deterministic signal extraction from manifests/configs, corroborated with structured LLM reasoning to map optimal AWS cloud slots.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 3. INITIAL / IDLE STATE — Primary Input & Hero Area                       */}
        {/* ========================================================================= */}
        {!loading && !showResults && (
          <div className="my-auto flex flex-col items-center">
            {/* Hero Calm Heading */}
            <div className="mb-8 text-center sm:mb-10">
              <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light shadow-[0_0_20px_rgba(167,139,250,0.12)]">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                <span>AI-Powered Cloud Architecture Engine</span>
              </div>

              <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-5xl">
                Transform any codebase into a{" "}
                <span className="shimmer-text">production AWS blueprint</span>
              </h1>

              <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
                Submit a GitHub repository or describe your application concept. Our engine infers the optimal AWS services, creates an editable draw.io diagram, and calculates realistic monthly pricing.
              </p>
            </div>

            {/* Primary Centered Input Container */}
            <div className="glass-panel w-full max-w-2xl rounded-3xl p-6 shadow-2xl sm:p-8">
              {/* Tab Selector Switcher */}
              <div className="mb-6 flex rounded-full bg-surface-2 p-1 border border-border">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("github");
                    setError(null);
                  }}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-full py-2 text-xs font-medium transition-all ${
                    activeTab === "github"
                      ? "bg-accent text-on-accent font-semibold shadow-md"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <GithubIcon className="h-3.5 w-3.5" />
                  <span>GitHub Repository</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("description");
                    setError(null);
                  }}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-full py-2 text-xs font-medium transition-all ${
                    activeTab === "description"
                      ? "bg-accent text-on-accent font-semibold shadow-md"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Project Description</span>
                </button>
              </div>

              {/* Form Input */}
              <form onSubmit={handleSubmit}>
                {activeTab === "github" ? (
                  <div>
                    <label
                      htmlFor="github-url"
                      className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted"
                    >
                      Repository URL
                    </label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-muted">
                        <GithubIcon className="h-4 w-4 text-accent" />
                      </div>
                      <input
                        id="github-url"
                        type="url"
                        placeholder="https://github.com/owner/repository"
                        value={githubUrl}
                        onChange={(e) => setGithubUrl(e.target.value)}
                        required
                        className="w-full rounded-2xl border border-border bg-surface-2/70 py-3.5 pl-11 pr-4 text-sm text-foreground placeholder:text-muted/50 transition-all focus:border-accent/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                      />
                    </div>

                    {/* Quick Sample Repositories Chips */}
                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-muted mr-1">Try sample:</span>
                      {SAMPLE_REPOS.map((sample) => (
                        <button
                          key={sample.name}
                          type="button"
                          onClick={() => setGithubUrl(sample.url)}
                          className="rounded-full border border-border/80 bg-surface-2/60 px-3 py-1 text-[11px] font-mono text-muted transition-all hover:border-accent/40 hover:text-foreground hover:bg-surface-3"
                        >
                          {sample.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label
                      htmlFor="description"
                      className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted"
                    >
                      Application Specification
                    </label>
                    <textarea
                      id="description"
                      placeholder="Describe what your app does, expected user scale, database requirements, background job processing, or specific cloud services you plan to use..."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      required
                      rows={5}
                      maxLength={8000}
                      className="w-full resize-y rounded-2xl border border-border bg-surface-2/70 p-4 text-sm text-foreground placeholder:text-muted/50 transition-all focus:border-accent/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />

                    {/* Character Count & Quick Starters */}
                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
                      <span>Be as detailed as you like</span>
                      <span className="font-mono">{description.length} / 8000</span>
                    </div>

                    {/* Prompt Starter Pills */}
                    <div className="mt-3 space-y-1.5">
                      <span className="text-[11px] text-muted">Example prompt starters:</span>
                      <div className="flex flex-col gap-1.5">
                        {SAMPLE_PROMPTS.map((prompt, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setDescription(prompt)}
                            className="rounded-xl border border-border/60 bg-surface-2/40 px-3 py-1.5 text-left text-xs text-muted transition-all hover:border-accent/40 hover:text-foreground hover:bg-surface-2"
                          >
                            &ldquo;{prompt}&rdquo;
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Primary Action Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-full bg-gradient-to-r from-accent-secondary via-accent to-purple-400 py-3.5 text-sm font-semibold text-on-accent shadow-[0_0_25px_rgba(167,139,250,0.35)] transition-all hover:shadow-[0_0_35px_rgba(167,139,250,0.5)] hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span>Analyse & Generate Architecture</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </form>
            </div>

            {/* Feature Highlights Pills */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4 text-xs text-muted sm:gap-8">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-accent" />
                <span>Zero AWS IAM Credentials Required</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-accent" />
                <span>Live AWS Price List Catalog Sync</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-accent" />
                <span>Exportable .drawio Diagrams</span>
              </div>
            </div>

            {/* Insufficient Signal Notice Card (if any) */}
            {insufficientSignal && (
              <div className="mt-8 w-full max-w-2xl">
                <InsufficientSignalCard
                  message={insufficientSignal.message}
                  repoName={insufficientSignal.prefill.repoName}
                  readmeSnippet={insufficientSignal.prefill.readmeSnippet}
                  onSwitchToDescription={handleSwitchToDescription}
                />
              </div>
            )}

            {/* Error Message Card (if any) */}
            {error && (
              <div className="mt-8 flex w-full max-w-2xl items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300 backdrop-blur-md">
                <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />
                <div>
                  <span className="font-semibold text-red-200">Analysis Error</span>
                  <p className="mt-0.5 text-red-300/80">{error}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 text-center text-xs text-muted">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 sm:flex-row sm:px-6">
          <p>
            AWS Architecture Estimator · SGP University Project
          </p>
          <p className="text-[11px] text-muted/70">
            Estimates and diagrams are illustrative and modeled on standard AWS On-Demand catalogs.
          </p>
        </div>
      </footer>
    </div>
  );
}
