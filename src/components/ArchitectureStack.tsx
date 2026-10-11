"use client";

import React from "react";
import type { ServicePlan, DiscoveredComponent, AwsServiceMapping } from "@/lib/schema";
import {
  Server,
  Database,
  Cpu,
  Layers,
  Code2,
  FileCode,
  Box,
  HardDrive,
  ShieldCheck,
  Zap,
  Activity,
  CheckCircle2,
  Sparkles,
} from "lucide-react";

export interface ArchitectureStackProps {
  plan: ServicePlan;
  projectProfile?: {
    languages?: { name: string; evidence: string; confidence: string }[];
    frameworks?: { name: string; evidence: string; confidence: string }[];
    databases?: { name: string; evidence: string; confidence: string }[];
    infrastructure?: { name: string; evidence: string; confidence: string }[];
    entryPoints?: string[];
    awsUsage?: { name: string; evidence: string; confidence: string }[];
    deploymentHints?: { name: string; evidence: string; confidence: string }[];
    summary?: string;
  } | null;
  architectureModel?: {
    appName?: string;
    description?: string;
    languages?: string[];
    frameworks?: string[];
    databases?: string[];
    components?: {
      id: string;
      name: string;
      type: string;
      technology: string;
      details?: string;
    }[];
  } | null;
}

function componentIcon(type: DiscoveredComponent["type"]) {
  switch (type) {
    case "frontend": return <Server className="h-4 w-4" />;
    case "backend": return <Server className="h-4 w-4" />;
    case "api": return <Cpu className="h-4 w-4" />;
    case "worker": return <Activity className="h-4 w-4" />;
    case "scheduler": return <Zap className="h-4 w-4" />;
    case "database": return <Database className="h-4 w-4" />;
    case "cache": return <HardDrive className="h-4 w-4" />;
    case "queue": return <Layers className="h-4 w-4" />;
    case "object-storage": return <Box className="h-4 w-4" />;
    case "search": return <Activity className="h-4 w-4" />;
    case "auth": return <ShieldCheck className="h-4 w-4" />;
    case "websocket": return <Zap className="h-4 w-4" />;
    case "proxy": return <Cpu className="h-4 w-4" />;
    case "external-service": return <FileCode className="h-4 w-4" />;
    case "messaging": return <Layers className="h-4 w-4" />;
    default: return <Box className="h-4 w-4" />;
  }
}

export function ArchitectureStack({
  plan,
  projectProfile,
  architectureModel,
}: ArchitectureStackProps) {
  const { components, awsMappings, detectedPattern, metadata } = plan;

  return (
    <div className="flex flex-col gap-6">
      {/* Pattern Overview Card */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-accent/25 bg-gradient-to-r from-surface via-surface-2 to-surface p-5 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 border border-accent/30 text-accent shadow-[0_0_20px_rgba(167,139,250,0.2)]">
            <Layers className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                Synthesized Pattern
              </span>
              <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent uppercase">
                {detectedPattern ?? "generic"}
              </span>
            </div>
            <h3 className="text-lg font-bold text-foreground">
              {((detectedPattern ?? "generic") as string)
                .split("-")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ")} Architecture
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-2">
            <span className="text-muted">Discovered Components: </span>
            <span className="font-semibold text-foreground">
              {components.length}
            </span>
          </div>
          <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-2">
            <span className="text-muted">AWS Services Mapped: </span>
            <span className="font-semibold text-foreground">
              {awsMappings.length}
            </span>
          </div>
          <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-2">
            <span className="text-muted">Grounding: </span>
            <span className="font-semibold text-accent">
              {metadata.grounding}
            </span>
          </div>
        </div>
      </div>

      {/* Detected Project Profile (if available) */}
      {projectProfile && (
        <div className="rounded-2xl border border-border bg-surface/80 p-5 shadow-md backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-accent" />
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
                Detected Codebase Stack
              </h4>
            </div>
            <span className="text-[11px] text-muted">Extracted from repository signals</span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Languages */}
            {projectProfile.languages && projectProfile.languages.length > 0 && (
              <div className="rounded-xl border border-border/60 bg-surface-2/40 p-3.5">
                <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                  Languages
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {projectProfile.languages.map((l) => (
                    <span
                      key={l.name}
                      className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Frameworks */}
            {projectProfile.frameworks && projectProfile.frameworks.length > 0 && (
              <div className="rounded-xl border border-border/60 bg-surface-2/40 p-3.5">
                <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                  Frameworks
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {projectProfile.frameworks.map((f) => (
                    <span
                      key={f.name}
                      className="rounded-md border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-light"
                    >
                      {f.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Databases */}
            {projectProfile.databases && projectProfile.databases.length > 0 && (
              <div className="rounded-xl border border-border/60 bg-surface-2/40 p-3.5">
                <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                  Databases
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {projectProfile.databases.map((d) => (
                    <span
                      key={d.name}
                      className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      {d.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Infrastructure Configs */}
            {projectProfile.infrastructure && projectProfile.infrastructure.length > 0 && (
              <div className="rounded-xl border border-border/60 bg-surface-2/40 p-3.5">
                <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                  Infrastructure Configs
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {projectProfile.infrastructure.map((i) => (
                    <span
                      key={i.name}
                      className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      {i.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mapped AWS Services Grid */}
      <div className="rounded-2xl border border-border bg-surface/80 p-5 shadow-md backdrop-blur-md">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Inferred AWS Cloud Services ({awsMappings.length} services)
            </h4>
          </div>
          <span className="text-[11px] text-muted">Mapped from discovered components</span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {awsMappings.map((mapping, idx) => {
            const component = components.find((c) => c.id === mapping.componentId);
            const isHigh = mapping.confidence === "high";
            const isMedium = mapping.confidence === "medium";

            return (
              <div
                key={`${mapping.componentId}-${mapping.serviceId}-${idx}`}
                className="group relative flex flex-col justify-between rounded-2xl border border-border/80 bg-surface-2/50 p-4 transition-all hover:border-accent/40 hover:bg-surface-2/80 hover:shadow-lg"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs uppercase tracking-wider text-muted">
                      {component?.type ?? "component"}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                        isHigh
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                          : isMedium
                          ? "bg-sky-500/15 text-sky-400 border border-sky-500/30"
                          : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                      }`}
                    >
                      {mapping.confidence} confidence
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    {component ? componentIcon(component.type) : null}
                    <span className="text-lg font-bold text-foreground">
                      {mapping.serviceId}
                    </span>
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    {mapping.evidence}
                  </p>
                  {component && component.evidence.length > 0 && (
                    <p className="mt-1 text-[10px] text-muted/60">
                      Source: {component.evidence[0]}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}