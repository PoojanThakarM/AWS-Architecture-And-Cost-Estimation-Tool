/**
 * inference.ts  —  FLOW.md Stage 3: Inference orchestration
 *
 * New pipeline (avoids collapse problem by construction):
 *   RepoSignals/description → LLM → ArchitectureModel → validation
 *     → deterministic AWS service mapping → ServicePlan
 *
 * The LLM never picks AWS services directly. It builds a single structured
 * ArchitectureModel of the whole application as a system; architecture.ts maps
 * that model to the ServicePlan. Downstream (diagram, cost) consume the ServicePlan.
 */

import { runRuleEngine } from "./ruleEngine.ts";
import { analyzeArchitecture, llmConfigured } from "./llmClient.ts";
import { mapArchitectureModelToServicePlan } from "./architecture.ts";
import type { ArchitectureModel } from "./architecture.ts";
import {
  type Diagnostic,
  type PipelineEngine,
  type ServicePlan,
  type Grounding,
} from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Grounding derivation
// ---------------------------------------------------------------------------

export function deriveGrounding(opts: {
  description?: string;
  fetchedFiles?: { content: string | null }[];
  treeFilenames?: string[];
}): Grounding {
  if (opts.description && opts.description.trim().length > 0) {
    return "description";
  }
  const files = opts.fetchedFiles ?? [];
  const hasContent = files.some((f) => f.content !== null);
  if (hasContent) {
    return "repoFiles";
  }
  if (files.length > 0 || (opts.treeFilenames && opts.treeFilenames.length > 0)) {
    return "filenameOnly";
  }
  return "unfounded";
}

/** Caps all component confidence to "low" for non-code grounded results. */
export function applyGroundingCap(plan: ServicePlan, grounding: Grounding): ServicePlan {
  if (grounding === "repo" || grounding === "repoFiles") return plan;

  const cappedComponents = plan.components.map((c) => ({ ...c, confidence: "low" as const }));
  const cappedMappings = plan.awsMappings.map((m) => ({ ...m, confidence: "low" as const }));
  return { ...plan, components: cappedComponents, awsMappings: cappedMappings };
}

import { buildAlternateProposal } from "./patternAlternates.ts";



// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface InferenceInput {
  ruleInput: RuleInput;
  signals: RepoSignals | null;
  description: string;
  profile?: ProjectProfile | null;
  /** Overall request deadline, forwarded to the LLM call. */
  signal?: AbortSignal;
}

export interface InferenceResult {
  plan: ServicePlan;
  plans: ServicePlan[];
  architectureModel: ArchitectureModel | null;
  /**
   * Which path produced `plan`. "rules-fallback" specifically means an LLM was
   * configured and failed — the one case a user must be told about, and the one
   * that used to be indistinguishable from a successful thin inference.
   */
  engine: PipelineEngine;
  /** Machine-readable record of every failure and degradation along the way. */
  diagnostics: Diagnostic[];
}

/**
 * Separates the plan from its `proposals` array without aliasing.
 *
 * `{ ...plan }` is shallow: the copy and the original share `components`,
 * `awsMappings`, `relationships`, and `deploymentModel` by reference. Since the
 * plan then stores the copy inside its own `proposals[0]`, any later in-place
 * mutation of a mapping would write through to both. structuredClone severs it.
 */
function detachProposal(plan: ServicePlan): ServicePlan {
  const copy = structuredClone(plan);
  delete copy.proposals;
  return copy;
}

/**
 * Runs the full inference pipeline:
 *   1. LLM builds the ArchitectureModel (if configured).
 *   2. The model is validated and deterministically mapped to a ServicePlan.
 *   3. No LLM (or LLM failure) → deterministic rules baseline.
 *
 * Always returns a schema-valid ServicePlan — never throws, and never returns
 * an unvalidated plan.
 */
/**
 * Records an informational diagnostic when the plan carries a non-OK terminal
 * state, so downstream code can tell "correctly minimal" from "parse failure".
 */
function pushTerminalStateDiagnostic(
  plan: ServicePlan,
  diagnostics: Diagnostic[]
): void {
  const state = plan.terminalState ?? "OK";
  if (state === "OK") return;
  diagnostics.push({
    stage: "inference",
    severity: "info",
    code: `terminal-state-${state.toLowerCase().replace(/_/g, "-")}`,
    message:
      `No deployable compute/framework combination was detected (terminal state ${state}); ` +
      "the minimal diagram and service list are intentional, not a parse failure.",
  });
}

export async function runInference(input: InferenceInput): Promise<InferenceResult> {
  const { ruleInput, signals, description, profile } = input;
  const diagnostics: Diagnostic[] = [];

  // Fallback: deterministic rule engine (no LLM configured, or LLM failed).
  const baseline = (engine: PipelineEngine): InferenceResult => {
    const basePlan = runRuleEngine({ ...ruleInput, profile: profile ?? undefined });
    pushTerminalStateDiagnostic(basePlan, diagnostics);
    const plans =
      basePlan.proposals && basePlan.proposals.length > 0 ? basePlan.proposals : [basePlan];
    return { plan: basePlan, plans, architectureModel: null, engine, diagnostics };
  };

  // Central reasoning path requires an LLM provider.
  const llmAvailable = llmConfigured();

  // 1. LLM builds the architecture model of the whole repo/system.
  const llm = await analyzeArchitecture({
    signals,
    description,
    inputKind: ruleInput.inputKind,
    grounding: ruleInput.grounding,
    profile: profile ?? null,
    signal: input.signal,
  });
  diagnostics.push(...llm.diagnostics);

  // 2. On failure fall back to rules, but record WHICH kind of failure it was.
  //    "rules" = nothing was configured, so rules are the intended answer.
  //    "rules-fallback" = an LLM was configured and did not deliver.
  if (!llm.model) {
    if (llmAvailable) {
      diagnostics.push({
        stage: "inference",
        severity: "warning",
        code: "llm-fallback-to-rules",
        message:
          "The AI analysis was unavailable, so this plan came from keyword rules only. " +
          "Treat the service list as a starting point rather than a reading of your project.",
        detail: `reason: ${llm.error}`,
      });
    }
    return baseline(llmAvailable ? "rules-fallback" : "rules");
  }

  // 3. Deterministic AWS service mapping from the model — the ONLY inference path.
  const primaryPlan = mapArchitectureModelToServicePlan(llm.model, {
    inputKind: ruleInput.inputKind,
    grounding: ruleInput.grounding,
    truncated: ruleInput.truncated,
    parseErrors: ruleInput.parseErrors,
    workloadClassification: profile?.workloadClassification,
    evidenceRegister: profile?.evidenceRegister,
    diagnostics,
  });

  const cappedPlan = applyGroundingCap(primaryPlan, ruleInput.grounding);
  const alternatePlan = buildAlternateProposal(cappedPlan, ruleInput);
  const p1 = detachProposal(cappedPlan);
  const p2 = alternatePlan
    ? detachProposal(applyGroundingCap(alternatePlan, ruleInput.grounding))
    : null;
  const plans = p2 ? [p1, p2] : [p1];
  cappedPlan.proposals = plans;
  pushTerminalStateDiagnostic(cappedPlan, diagnostics);

  return {
    plan: cappedPlan,
    plans,
    architectureModel: llm.model,
    engine: "llm",
    diagnostics,
  };
}