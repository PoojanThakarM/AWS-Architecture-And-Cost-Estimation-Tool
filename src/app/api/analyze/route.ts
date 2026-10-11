/**
 * /api/analyze — POST
 *
 * Stage 1: Input normalisation + validation (FLOW.md Stage 1).
 * Stage 2: Evidence extraction via RepoFetcher + insufficient-signal gate.
 * Stage 3: Inference — LLM builds an ArchitectureModel, validated and
 *          deterministically mapped to a ServicePlan (rules baseline = fallback).
 * Stage 4: Diagram XML generation via diagram.ts.
 * Stage 5: Cost estimation via cost.ts (default region us-east-1, 10k users).
 *
 * Decision 1:  Pipeline server-side only.
 * Decision 7:  SSRF protection — host allowlist (github.com), timeouts, length caps.
 * Decision 20: Insufficient-signal gate returns advisory payload, never a plan.
 * Decision 39: input_kind and grounding are separate fields; they may differ.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  fetchRepoSignals,
  isInsufficientSignal,
  signalsToRuleInput,
} from "@/lib/repoFetcher";
import { analyzeProject } from "@/lib/repoAnalyzer";
import { runInference, deriveGrounding } from "@/lib/inference";
import { generateDiagramXml } from "@/lib/diagram";
import { computeCostRows } from "@/lib/cost";
import type { RuleInput } from "@/lib/ruleEngine";
import type { ProjectProfile } from "@/lib/repoAnalyzer";
import type { Diagnostic, Grounding, ServicePlan } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface AnalyzeRequestBody {
  input: {
    kind: "github_url" | "description";
    value: string;
  };
  /** Optional region override (default: us-east-1) */
  region?: string;
  /** Optional user count override (default: 10_000) */
  userCount?: number;
}

// ---------------------------------------------------------------------------
// Input validation constants (Decision 7)
// ---------------------------------------------------------------------------
const MAX_DESCRIPTION_LENGTH = 100_000; // chars
const MAX_URL_LENGTH = 2_000; // chars
const ALLOWED_GITHUB_HOSTS = ["github.com"]; // SSRF allowlist

/**
 * userCount scales every cost row linearly. It had a floor of 1 and no ceiling,
 * so a caller could ask for 1e18 users and get a meaningless number rendered
 * with the same authority as a real estimate.
 */
const MIN_USER_COUNT = 1;
const MAX_USER_COUNT = 10_000_000;
const DEFAULT_USER_COUNT = 10_000;

/** Whole-request deadline. Past this, the LLM call is aborted and rules answer. */
const REQUEST_DEADLINE_MS = 90_000;

const ALLOWED_REGIONS = new Set([
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-south-1", "sa-east-1", "ca-central-1",
]);

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ALLOWED_GITHUB_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function cleanPlanForSerialization(plan: ServicePlan): ServicePlan {
  if (!plan) return plan;
  const { proposals, ...rest } = plan;
  if (!proposals || proposals.length === 0) {
    return rest as ServicePlan;
  }
  const cleanProposals = proposals.map((p: any) => {
    if (!p) return p;
    const { proposals: _sub, ...subRest } = p;
    return subRest as ServicePlan;
  });
  return { ...rest, proposals: cleanProposals } as ServicePlan;
}

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Parse body ───────────────────────────────────────────────────────────
  let body: AnalyzeRequestBody;
  try {
    body = (await req.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // User-facing prose (warnings) and machine-readable pipeline records
  // (diagnostics) are collected separately: the UI shows the former, tests and
  // the debug view key on the latter's stable `code`.
  const warnings: string[] = [];
  const diagnostics: Diagnostic[] = [];

  try {

  // ── Validate shape ───────────────────────────────────────────────────────
  if (
    !body?.input ||
    typeof body.input !== "object" ||
    !["github_url", "description"].includes(body.input.kind) ||
    typeof body.input.value !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          'Request body must be { input: { kind: "github_url" | "description", value: string } }',
      },
      { status: 400 }
    );
  }

  const { kind, value } = body.input;

  // Region + user count (optional, with safe defaults)
  const region =
    typeof body.region === "string" && ALLOWED_REGIONS.has(body.region)
      ? body.region
      : "us-east-1";
  const requestedUsers =
    typeof body.userCount === "number" && Number.isFinite(body.userCount)
      ? Math.round(body.userCount)
      : DEFAULT_USER_COUNT;
  const userCount = Math.min(Math.max(requestedUsers, MIN_USER_COUNT), MAX_USER_COUNT);

  // ── Validate value per kind (Decision 7) ─────────────────────────────────
  if (kind === "github_url") {
    if (value.length > MAX_URL_LENGTH) {
      return NextResponse.json(
        { error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (!isGitHubUrl(value)) {
      return NextResponse.json(
        { error: "URL must be a valid github.com HTTPS URL" },
        { status: 400 }
      );
    }
  } else {
    if (value.trim().length === 0) {
      return NextResponse.json(
        { error: "Description must not be empty" },
        { status: 400 }
      );
    }
    if (value.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`,
        },
        { status: 400 }
      );
    }
  }

  if (requestedUsers !== userCount) {
    warnings.push(
      `User count clamped to ${userCount.toLocaleString()} (allowed range ${MIN_USER_COUNT}–${MAX_USER_COUNT.toLocaleString()}).`
    );
  }

  // ── Stage 2: Evidence extraction (FLOW.md Stage 2) ───────────────────────
  let ruleInput: RuleInput;
  let signals = null;
  let grounding: Grounding;
  let description = "";
  let profile: ProjectProfile | null = null;

  if (kind === "github_url") {
    const githubToken = process.env.GITHUB_TOKEN;
    signals = await fetchRepoSignals(value, githubToken);

    // Insufficient-signal gate (Decision 20 / flaw 8)
    if (isInsufficientSignal(signals)) {
      const readme = signals.keyFiles.find((f) => f.kind === "readme");
      const snippet = readme?.content?.slice(0, 200) ?? "";
      return NextResponse.json({
        status: "insufficient_signal",
        message:
          "Couldn't extract enough from this repo — describe it instead.",
        prefill: { repoName: signals.repoName, readmeSnippet: snippet },
      });
    }

    // Grounding: derive directly and only from evidence actually consumed (Fix 2)
    grounding = deriveGrounding({
      description: "",
      fetchedFiles: signals.keyFiles,
    });

    if (grounding === "filenameOnly") {
      warnings.push(
        "Could not fetch repo file contents — inferred from file names only."
      );
    } else if (grounding === "unfounded") {
      warnings.push(
        "Could not access repo or resolve any file names — inference is unfounded with low confidence."
      );
    }

    // ── Stage 2b: Project Analysis (NEW) ─────────────────────────────────────
    // Analyzes what the repository actually contains BEFORE any AWS inference.
    // Produces a structured ProjectProfile (languages, frameworks, databases,
    // infrastructure) that replaces the raw file dump sent to the LLM.
    profile = analyzeProject(signals);

    // Parse failures used to be collected by repoAnalyzer and then dropped on
    // the floor, so a manifest we could not read looked identical to one that
    // declared nothing.
    const parseFailures = profile.parseFailures ?? [];
    if (parseFailures.length > 0) {
      warnings.push(
        `${parseFailures.length} manifest file(s) could not be parsed — their dependencies were not analyzed.`
      );
      diagnostics.push({
        stage: "analyze",
        severity: "warning",
        code: "manifest-parse-failed",
        message: `${parseFailures.length} manifest file(s) failed to parse and contributed no dependency evidence.`,
        detail: parseFailures.join("; ").slice(0, 1_000),
      });
    }

    ruleInput = signalsToRuleInput(signals, kind, grounding);

    if (signals.truncated) {
      warnings.push("Some files were truncated due to size limits.");
    }
    if (signals.parseErrors.length > 0) {
      warnings.push(
        `${signals.parseErrors.length} file(s) could not be parsed and were used as filename-only signals.`
      );
    }
  } else {
    // Freeform description path — no fetch, grounding = description
    grounding = "description";
    description = value;
    ruleInput = {
      description: value,
      fileContent: "",
      fileNames: [],
      inputKind: kind,
      grounding,
      truncated: false,
      parseErrors: [],
    };
  }

  // ── Stage 3: Inference ────────────────────────────────────────────────────
  // Central reasoning path: LLM → ArchitectureModel → validation → deterministic
  // AWS service mapping. Rules baseline is only the no-LLM / LLM-failure fallback.
  // Whole-request deadline. Without one, a hung provider held the connection
  // open for as long as the socket lasted; now the LLM call is aborted and the
  // rules baseline answers instead.
  const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);

  const {
    plan: servicePlan,
    plans: servicePlans,
    architectureModel,
    engine,
    diagnostics: inferenceDiagnostics,
  } = await runInference({
    ruleInput,
    signals,
    description,
    profile, // structured analysis from Stage 2b
    signal: deadline,
  });

  diagnostics.push(...inferenceDiagnostics);

  // The one case the user must always be able to see: an LLM provider WAS
  // configured, the LLM path failed, and rules quietly answered instead.
  if (engine === "rules-fallback") {
    warnings.push(
      "AI analysis was unavailable for this request — the result comes from the deterministic rule engine and may be less specific."
    );
  }

  const allPlans = servicePlans && servicePlans.length > 0 ? servicePlans : [servicePlan];

  // Grounding warning (Decision 19 / Fix 2)
  if (grounding === "description") {
    warnings.push(
      "Inferred from your description only — not verified against code."
    );
  } else if (grounding === "filenameOnly") {
    warnings.push(
      "Inferred from file names only — file contents could not be read."
    );
  } else if (grounding === "unfounded") {
    warnings.push(
      "Unfounded inference — no repository files or description available."
    );
  }

  // ── Stage 4: Diagram XML ──────────────────────────────────────────────────
  const diagramXmls: (string | null)[] = [];
  for (const p of allPlans) {
    try {
      diagramXmls.push(generateDiagramXml(p, signals?.sdkEvidence));
    } catch (err) {
      console.warn("[analyze] Diagram generation failed:", err);
      diagramXmls.push(null);
    }
  }
  const diagramXml = diagramXmls[0] ?? null;
  if (!diagramXml) {
    warnings.push("Diagram generation failed — diagram unavailable.");
  }

  // ── Stage 5: Cost rows ────────────────────────────────────────────────────
  const costRowsList = [];
  for (const p of allPlans) {
    try {
      const rows = await computeCostRows(p, region, userCount);
      costRowsList.push(rows);
    } catch (err) {
      console.warn("[analyze] Cost computation failed:", err);
      costRowsList.push(null);
    }
  }
  const costRows = costRowsList[0] ?? null;
  if (!costRows) {
    warnings.push("Cost estimation failed — estimates unavailable.");
  }

  // ── Response ─────────────────────────────────────────────────────────────
  return NextResponse.json({
    input_kind: kind,
    grounding,
    service_plan: cleanPlanForSerialization(servicePlan),
    service_plans: allPlans.map(cleanPlanForSerialization),
    diagram_xml: diagramXml,
    diagram_xmls: diagramXmls,
    cost_rows: costRows,
    cost_rows_list: costRowsList,
    warnings,
    // Which code path actually produced this plan, and every failure recorded
    // along the way. Before these existed, an LLM outage and a confident
    // inference were indistinguishable in the response.
    engine,
    diagnostics,
    // architecture_model is the LLM's structured understanding of the whole repo
    // (single source of truth for the derived service plan) — exposed for transparency.
    ...(architectureModel ? { architecture_model: architectureModel } : {}),
    // project_profile is included for transparency/debugging when repo analysis ran
    ...(profile ? { project_profile: profile } : {}),
  });
  } catch (err) {
    // The message stays server-side. Returning err.message leaked internal
    // paths, provider errors, and upstream URLs to the browser.
    console.error("[analyze] Uncaught analysis error:", err);
    return NextResponse.json(
      { error: "Internal server error during analysis" },
      { status: 500 }
    );
  }
}
