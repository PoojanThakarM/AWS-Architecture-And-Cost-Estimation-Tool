"use client";

import React, { useEffect, useState, useMemo } from "react";
import {
  Layers,
  CheckCircle2,
  Sparkles,
} from "lucide-react";

export interface AnalysisVisualizerProps {
  inputKind: "github_url" | "description";
  inputValue: string;
  isComplete: boolean;
  onTransitionComplete?: () => void;
}

interface StageDefinition {
  title: string;
  description: string;
  detail: string;
  durationMs: number;
}

const GITHUB_STAGES: StageDefinition[] = [
  {
    title: "Connecting to repository",
    description: "Resolving repository signals and verifying access...",
    detail: "Querying GitHub API for file trees and commit history",
    durationMs: 1400,
  },
  {
    title: "Scanning project structure",
    description: "Inspecting directory layout and manifests...",
    detail: "Detecting package.json, Dockerfile, requirements.txt, and manifests",
    durationMs: 1600,
  },
  {
    title: "Understanding application components",
    description: "Identifying frameworks, runtimes, and entry points...",
    detail: "Analyzing Next.js, FastAPI, Express, Django, and runtime topologies",
    durationMs: 1800,
  },
  {
    title: "Analyzing dependencies",
    description: "Extracting SDK references and ecosystem libraries...",
    detail: "Searching for aws-sdk, boto3, prisma, pg, redis, and client packages",
    durationMs: 1800,
  },
  {
    title: "Mapping component relationships",
    description: "Constructing system architecture topology...",
    detail: "Tracing API routes, database connections, and background workers",
    durationMs: 2000,
  },
  {
    title: "Identifying infrastructure requirements",
    description: "Determining compute, database, and storage parameters...",
    detail: "Evaluating stateless tiers, persistent databases, and asset buckets",
    durationMs: 2000,
  },
  {
    title: "Mapping architecture to AWS",
    description: "Selecting optimal AWS cloud services...",
    detail: "Matching application components with AWS ECS, Lambda, RDS, S3, ALB",
    durationMs: 2200,
  },
  {
    title: "Preparing architecture diagram",
    description: "Synthesizing interactive draw.io blueprint...",
    detail: "Arranging VPC boundaries, subnets, gateways, and layout edges",
    durationMs: 2200,
  },
  {
    title: "Calculating estimated AWS cost",
    description: "Querying AWS Price List catalog for regional rates...",
    detail: "Computing unit prices and baseline traffic scaling in us-east-1",
    durationMs: 2000,
  },
  {
    title: "Architecture analysis complete",
    description: "Finalizing cloud blueprint and cost model...",
    detail: "Your customized AWS architecture is ready for exploration",
    durationMs: 1000,
  },
];

const DESCRIPTION_STAGES: StageDefinition[] = [
  {
    title: "Parsing project description",
    description: "Extracting semantic architecture intent and constraints...",
    detail: "Analyzing workload tiers, user traffic scale, and performance needs",
    durationMs: 1400,
  },
  {
    title: "Inferring application components",
    description: "Identifying frontend, backend API, and worker services...",
    detail: "Formulating application topology and tier separation",
    durationMs: 1800,
  },
  {
    title: "Determining data & persistence needs",
    description: "Evaluating database models, caches, and storage...",
    detail: "Selecting relational, document, or key-value persistence tiers",
    durationMs: 1800,
  },
  {
    title: "Mapping architecture to AWS",
    description: "Matching components with native AWS cloud services...",
    detail: "Choosing appropriate compute (ECS/Lambda), database (Aurora/DynamoDB), and VPC",
    durationMs: 2200,
  },
  {
    title: "Synthesizing architecture diagram",
    description: "Generating visual layout and network boundaries...",
    detail: "Building standard draw.io layout with subnets and security zones",
    durationMs: 2200,
  },
  {
    title: "Calculating estimated AWS cost",
    description: "Estimating monthly cost breakdown for 10k baseline users...",
    detail: "Querying AWS Price List catalog for live unit prices",
    durationMs: 2000,
  },
  {
    title: "Architecture analysis complete",
    description: "Finalizing cloud blueprint...",
    detail: "Your customized AWS architecture is ready for exploration",
    durationMs: 1000,
  },
];

export function AnalysisVisualizer({
  inputKind,
  inputValue,
  isComplete,
  onTransitionComplete,
}: AnalysisVisualizerProps) {
  const stages = useMemo(
    () => (inputKind === "github_url" ? GITHUB_STAGES : DESCRIPTION_STAGES),
    [inputKind]
  );

  const [currentStageIdx, setCurrentStageIdx] = useState(0);
  const [progress, setProgress] = useState(12);

  // Progressive stage stepper
  useEffect(() => {
    if (isComplete) {
      // Fast forward smoothly to 100%
      setCurrentStageIdx(stages.length - 1);
      setProgress(100);

      const timer = setTimeout(() => {
        onTransitionComplete?.();
      }, 700);

      return () => clearTimeout(timer);
    }

    // Normal progressive advancement
    const interval = setInterval(() => {
      setCurrentStageIdx((prev) => {
        if (prev < stages.length - 2) {
          return prev + 1;
        }
        return prev;
      });

      setProgress((prev) => {
        // Asymptotically approach 92% until complete
        if (prev < 92) {
          const step = Math.max(1, Math.round((92 - prev) / 6));
          return Math.min(92, prev + step);
        }
        return prev;
      });
    }, 1800);

    return () => clearInterval(interval);
  }, [isComplete, stages, onTransitionComplete]);

  const currentStage = stages[currentStageIdx] || stages[0];
  const shortInputValue =
    inputValue.length > 50 ? `${inputValue.slice(0, 47)}…` : inputValue;

  return (
    <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center justify-center px-4 py-8 sm:py-12">
      {/* Top calm header */}
      <div className="mb-8 text-center sm:mb-12">
        <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light shadow-[0_0_20px_rgba(167,139,250,0.15)]">
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-accent" />
          <span>AI Architecture Analysis in Progress</span>
        </div>

        <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {isComplete ? (
            <span className="text-emerald-300">Architecture Blueprint Ready</span>
          ) : (
            <span className="shimmer-text">Analyzing your repository</span>
          )}
        </h2>

        <p className="mt-2 text-sm text-muted">
          {inputKind === "github_url" ? (
            <>
              Inspecting <span className="font-mono text-foreground/90">{shortInputValue}</span>
            </>
          ) : (
            "Deconstructing project specifications and inferring optimal AWS cloud services"
          )}
        </p>
      </div>

      {/* Central Visual Element — Meditation / Breathing Circular Animation */}
      <div className="relative my-4 flex h-72 w-72 items-center justify-center sm:h-96 sm:w-96">
        {/* Soft Ambient Outer Glow */}
        <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-accent/20 via-indigo-500/15 to-purple-500/20 blur-3xl" />

        {/* Concentric Ripple Waves */}
        <div className="animate-ripple-1 absolute inset-4 rounded-full border border-accent/25 bg-accent/[0.02]" />
        <div className="animate-ripple-2 absolute inset-12 rounded-full border border-indigo-400/20 bg-indigo-500/[0.02]" />
        <div className="animate-ripple-3 absolute inset-20 rounded-full border border-purple-400/20 bg-purple-500/[0.02]" />

        {/* SVG Orbital Dash Rings */}
        <svg
          className="animate-orbit-slow pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 400 400"
        >
          <circle
            cx="200"
            cy="200"
            r="165"
            fill="none"
            stroke="rgba(167, 139, 250, 0.25)"
            strokeWidth="1.5"
            strokeDasharray="4 8"
          />
          <circle
            cx="200"
            cy="200"
            r="130"
            fill="none"
            stroke="rgba(129, 140, 248, 0.2)"
            strokeWidth="1"
            strokeDasharray="6 12"
          />
        </svg>

        <svg
          className="animate-orbit-reverse pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 400 400"
        >
          <circle
            cx="200"
            cy="200"
            r="100"
            fill="none"
            stroke="rgba(192, 132, 252, 0.2)"
            strokeWidth="1.2"
            strokeDasharray="2 10"
          />
        </svg>


        {/* Central Glowing Breathing Orb Core */}
        <div className="animate-breathe-core relative z-10 flex h-28 w-28 flex-col items-center justify-center rounded-full border border-accent/40 bg-gradient-to-br from-surface-2 via-surface to-surface-3 shadow-2xl backdrop-blur-xl sm:h-36 sm:w-36">
          {/* Inner Light Pulse */}
          <div className="absolute inset-2 rounded-full bg-gradient-to-tr from-accent/20 to-indigo-500/25 blur-md" />

          {isComplete ? (
            <div className="relative z-20 flex flex-col items-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-400 animate-bounce" />
              <span className="mt-1 font-mono text-xs font-semibold text-emerald-300">
                100%
              </span>
            </div>
          ) : (
            <div className="relative z-20 flex flex-col items-center">
              <Layers className="h-8 w-8 text-accent-light drop-shadow-[0_0_10px_rgba(167,139,250,0.8)] sm:h-10 sm:w-10" />
              <span className="mt-1 font-mono text-xs font-semibold tracking-wider text-accent">
                {progress}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Dynamic Stage Banner & Live Status Information */}
      <div className="mt-8 flex w-full max-w-xl flex-col items-center text-center">
        {/* Step Badge */}
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-surface-2 px-3 py-1 font-mono text-xs font-medium text-accent border border-border">
            Step {currentStageIdx + 1} of {stages.length}
          </span>
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />
        </div>

        {/* Stage Title */}
        <h3 className="mt-3 text-lg font-medium text-foreground transition-all duration-300">
          {currentStage.title}
        </h3>

        {/* Stage Description & Subtext */}
        <p className="mt-1 text-sm text-muted transition-all duration-300">
          {currentStage.description}
        </p>
        <p className="mt-0.5 text-xs text-muted/70 font-mono">
          {currentStage.detail}
        </p>

        {/* Smooth Progress Bar */}
        <div className="mt-6 w-full overflow-hidden rounded-full bg-surface-2 p-1 border border-border">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-accent-secondary via-accent to-purple-400 shadow-[0_0_15px_rgba(167,139,250,0.5)] transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Stage Steps Mini Indicators */}
        <div className="mt-8 flex w-full justify-between gap-1 overflow-x-auto py-1">
          {stages.map((st, idx) => {
            const isFinished = idx < currentStageIdx || isComplete;
            const isCurrent = idx === currentStageIdx && !isComplete;

            return (
              <div
                key={st.title}
                className="group relative flex flex-col items-center flex-1"
                title={`${idx + 1}. ${st.title}`}
              >
                <div
                  className={`h-2 w-full rounded-full transition-all duration-300 ${
                    isFinished
                      ? "bg-accent/80"
                      : isCurrent
                      ? "bg-accent shadow-[0_0_10px_rgba(167,139,250,0.8)] animate-pulse"
                      : "bg-surface-2"
                  }`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
