/**
 * llmClient.ts  —  LLM provider factory + structured repository understanding
 *
 * The LLM's ONLY job is to build the ArchitectureModel — a structured
 * understanding of the whole repository as a system (components, technologies,
 * databases, APIs, external services, build config, runtime relationships).
 * It does NOT choose AWS services. AWS service selection happens later,
 * deterministically, in architecture.ts::mapArchitectureModelToServicePlan().
 *
 * Provider chain — tried IN ORDER until one returns a model. This is failover,
 * not precedence.
 *   1. GOOGLE_API_KEY       → gemini-3.8-flash              (@ai-sdk/google)
 *   2. OPENROUTER_API_KEY   → OpenRouter free models        (@openrouter/ai-sdk-provider)
 *
 * Failure is never silent. analyzeArchitecture returns a discriminated
 * LlmArchitectureResult carrying the reason and per-provider diagnostics, so
 * callers can tell "no provider configured" from "every provider failed" from
 * "the model answered but cited no real evidence".
 */

import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  ArchitectureModelSchema,
  validateArchitectureModel,
} from "./architecture.ts";
import { COMPONENT_TYPES } from "./schema.ts";
import type { ArchitectureModel, ArchitectureValidationFailure } from "./architecture.ts";
import type { Diagnostic, Grounding } from "./schema.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

const MODEL_IDS = {
  google: "gemini-3.8-flash",
  openrouter: [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "apodex/apodex-1.1-mini:free",
    "openrouter/free",
  ],
} as const;

interface ProviderConfig {
  name: string;
  model: string;
  /**
   * `LanguageModel` is the AI SDK's own union of accepted model values, so
   * generateObject takes this directly. The previous signature resolved to
   * `never` and forced `as never` at every call site, which defeated type
   * checking at exactly the boundary where provider clients differ.
   */
  getModel: () => LanguageModel;
}

/**
 * Every configured provider, in failover order.
 *
 * Returns a list rather than the first match: analyzeArchitecture walks it and
 * tries the next provider when one throws. A configured-but-dead key used to
 * make the whole LLM path unavailable.
 */
function resolveProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  if (process.env.GOOGLE_API_KEY) {
    const client = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
    providers.push({
      name: "google",
      model: MODEL_IDS.google,
      getModel: () => client(MODEL_IDS.google),
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    const client = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    for (const modelId of MODEL_IDS.openrouter) {
      providers.push({
        name: "openrouter",
        model: modelId,
        getModel: () => client.chat(modelId),
      });
    }
  }

  return providers;
}

export function llmConfigured(): boolean {
  return resolveProviders().length > 0;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * The component vocabulary, generated from the schema enum.
 *
 * Both prompt branches used to hand-write this list, and both disagreed with
 * `COMPONENT_TYPES`: the repo branch omitted scheduler/search/websocket, the
 * description branch omitted search. A model that answered with a type the
 * prompt named but the enum lacked — or picked a wrong-but-listed type because
 * the right one was never offered — failed `generateObject` schema validation,
 * which surfaced only as a rules fallback. Deriving it removes that class of
 * failure permanently.
 */
const COMPONENT_TYPE_LIST = COMPONENT_TYPES.join(", ");

function buildSystemPrompt(): string {
  return `You are a Senior Principal AWS Cloud Architect. You are given structured evidence extracted from a software repository or project description. Build a model of the system that ACTUALLY EXISTS in that evidence — nothing more.

THE EVIDENCE RULE (non-negotiable):
Every component you output MUST cite at least one concrete piece of genuine evidence
from the EVIDENCE INVENTORY or discovered components below in its "evidence" array.
Prefer citing evidence IDs (e.g. "ev-1", "ev-2") or exact manifest file paths (e.g. "order-service/pom.xml").
"Typical for this kind of app", "best practice", "production systems need this",
and "implied by the stack" are NOT evidence. NEVER invent evidence, non-existent files,
or hallucinated handler definitions. Any component citing non-existent or unsupported
evidence will be automatically rejected. A component with no valid evidence will be discarded.

MINIMAL ARCHITECTURES ARE CORRECT ARCHITECTURES:
There is no required number of components and no required set of layers. Most of
the seven classic tiers (edge, ingress, compute, data, messaging, observability,
external) will be ABSENT from any given project, and that is the right answer.
A repository of static HTML, CSS and JavaScript with no server code is a frontend
component and NOTHING ELSE — no Lambda, no API Gateway, no DynamoDB, no Secrets
Manager, no queue, no auth. A single script with no database is one component.
Do not add a database because "apps have databases", an auth component because
"apps have logins", or a queue because "apps do background work". Emit ONLY the
tiers the evidence proves. One component is a perfectly valid answer.

Report what you find, not what a mature system would eventually grow into. Do not
compensate for a small repository by inventing scale.

Output schema requirements:
- appType: primary pattern (static-site, serverless-api, containerised-app, event-driven, ml-pipeline, full-stack-web, data-pipeline, generic). Pick the one the evidence supports — "static-site" and "generic" are ordinary answers, not failures.
- appName: clean project / system name taken from the repo or description.
- description: 1-2 sentence overview of the application as it actually is.
- components: the system components the evidence proves. "type" MUST be exactly one of: ${COMPONENT_TYPE_LIST}. Any other value is rejected. Each has { id, name, type, technology, details, evidence, confidence }.
  - evidence: array of specific citations, as defined by THE EVIDENCE RULE. Never empty.
  - confidence: "high" when the evidence is a direct declaration (a dependency, a compose service, an IaC resource); "medium" when inferred from strong indirect signals such as an import or a README statement; "low" when the signal is weak. Do not report "high" for a guess — prefer omitting the component entirely.
- relationships: runtime connections you can actually justify between components you emitted: { from: <component id>, to: <component id>, type: "calls" | "reads" | "writes" | "triggers" | "sends" | "receives" | "subscribes" }. Both ids must refer to emitted components. If the project has one component, relationships is an empty array.

You are NOT choosing AWS services. Name the real technologies the project uses
("PostgreSQL", "Express", "React", "Redis"); AWS service selection happens later,
deterministically, from your model.`;
}

/**
 * Builds the evidence prompt for the architecture-model call.
 * Contains ONLY:
 *   1. The structured summary string from repoAnalyzer (profile text).
 *   2. The repository file-path structure (paths, never raw contents).
 *   3. A README excerpt.
 *   4. The sdkEvidence[] array.
 *   5. Discovered components from repoAnalyzer (CRITICAL - each is separate deployable unit).
 *   6. The user's input description (if present).
 * Explicitly excludes raw file dumps to prevent token overflow and hallucinations.
 */
export function buildArchitecturePrompt(
  profile: ProjectProfile | null,
  signals: RepoSignals | null,
  description: string,
  grounding: Grounding
): string {
  const parts: string[] = [];

  if (profile && (grounding === "repo" || grounding === "repoFiles" || grounding === "filenameOnly")) {
    parts.push(
      "Build the architecture model of this repository from the evidence below. " +
      "The evidence below is the ONLY thing you may model. Cite a specific line of " +
      "it in the 'evidence' array of every component you emit; emit no component " +
      "you cannot cite. If the repository turns out to be a single tier — a static " +
      "site, one script, one service with no database — say exactly that and stop. " +
      "Absent tiers are the expected result, not a gap for you to fill."
    );

    // 1. Structured analysis summary from repoAnalyzer
    parts.push(profile.summary);

    // 2. Repository structure — file paths only
    if (signals && signals.keyFiles.length > 0) {
      parts.push("\nREPOSITORY STRUCTURE (file paths):");
      for (const f of signals.keyFiles) {
        parts.push(`  - ${f.path}`);
      }
    }

    // 3. README excerpt
    const readme = signals?.keyFiles.find((f) => f.kind === "readme")?.content;
    if (readme) {
      parts.push(`\nREADME:\n${readme}`);
    }

    // 4. sdkEvidence array
    if (signals?.sdkEvidence && signals.sdkEvidence.length > 0) {
      parts.push("\nEXTRACTED SDK / CODE SIGNALS:");
      for (const ev of signals.sdkEvidence) {
        const hint = ev.serviceHint ?? ev.service ?? "AWS";
        const path = ev.filePath ?? ev.file ?? "code";
        const line = ev.line !== undefined ? `:${ev.line}` : "";
        const match = ev.matchSnippet ?? ev.match ?? "";
        parts.push(`  - [${hint}] ${path}${line} — "${match}"`);
      }
    }

    // 5. Discovered components — CRITICAL: each is a distinct deployable unit
    if (profile.discoveredComponents.length > 0) {
      parts.push(
        "\nDISCOVERED DEPLOYABLE COMPONENTS (extracted from IaC and source code):" +
        "\nEach entry below is a SEPARATE running process or data tier, already " +
        "backed by the evidence shown on its line. Model each one as its own " +
        "component — do NOT merge or collapse them — and carry that evidence " +
        "through into the component's 'evidence' array. This list is a floor, " +
        "not a template: do not invent sibling tiers to 'complete' it.\n"
      );
      for (const dc of profile.discoveredComponents) {
        const evidenceLine = dc.evidence.join("; ");
        parts.push(
          `  [${dc.type.toUpperCase()}] id="${dc.id}" name="${dc.name}" ` +
          `technology="${dc.technology}" confidence=${dc.confidence}` +
          (evidenceLine ? ` evidence="${evidenceLine}"` : "")
        );
      }
    }

    // 6. Evidence inventory (ground truth register)
    if (profile.evidenceRegister && profile.evidenceRegister.length > 0) {
      parts.push(
        "\nEVIDENCE INVENTORY (Ground Truth Evidence Records):\n" +
        "You may ONLY cite evidence IDs (e.g. 'ev-1', 'ev-2') or direct file paths from this list:\n" +
        profile.evidenceRegister.map(r => `  - [${r.id}] (${r.kind}) ${r.sourcePath}: ${r.detail} [${r.confidence}]`).join("\n")
      );
    }

    // 7. User description (if present)
    if (description) {
      parts.push(`\nADDITIONAL USER CONTEXT:\n${description}`);
    }
  } else {
    // Description path — no profile available
    parts.push(
      "Analyze the following project description and model the system it describes." +
      "\nThe description is your only evidence. Decompose it into the components it" +
      "\nactually states or unambiguously implies, and cite the phrase you took each" +
      "\none from in that component's 'evidence' array (e.g. evidence:" +
      "\n[\"description: 'stores votes in MongoDB'\"])." +
      `\n\nComponent types available (use EXACTLY one of these): ${COMPONENT_TYPE_LIST}.` +
      "\n\nEmit a tier ONLY where the description supports it. A description that" +
      "\nmentions no database gets no database; one that mentions no background" +
      "\nprocessing gets no worker and no queue; one that mentions no login gets no" +
      "\nauth component. Do not pad a short description into a multi-tier system —" +
      "\nif it describes one thing, return one component. Every component needs a" +
      "\nunique id, and relationships may only reference ids you emitted."
    );
    if (description) {
      parts.push(`\nProject description: ${description}`);
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main call
// ---------------------------------------------------------------------------

/** Why the LLM path did not produce a usable ArchitectureModel. */
export type LlmFailureReason =
  /** No provider key is set. Rules are the intended answer, not a degradation. */
  | "no-provider"
  /** Every configured provider threw (network, auth, rate limit, schema mismatch). */
  | "all-providers-failed"
  /** A provider answered, but the object failed schema or evidence validation. */
  | "model-invalid";

export type LlmArchitectureResult =
  | { model: ArchitectureModel; error: null; provider: string; diagnostics: Diagnostic[] }
  | {
      model: null;
      error: LlmFailureReason;
      /** Provider that produced the final failure, when one got that far. */
      provider: string | null;
      diagnostics: Diagnostic[];
    };

/** How long a single provider attempt may take before we move to the next one. */
const LLM_TIMEOUT_MS = 60_000;

/**
 * Builds the ArchitectureModel, trying each configured provider in turn.
 *
 * Never throws and never returns a bare null: the result always says WHY there
 * is no model, and `diagnostics` carries one entry per failed attempt. Callers
 * forward those into the API response so an LLM outage is visible to the user
 * instead of appearing as an unusually thin but confident inference.
 */
export async function analyzeArchitecture(opts: {
  signals: RepoSignals | null;
  description: string;
  inputKind: "github_url" | "description";
  grounding: Grounding;
  profile?: ProjectProfile | null;
  /** Overall pipeline deadline; aborts the in-flight provider call. */
  signal?: AbortSignal;
}): Promise<LlmArchitectureResult> {
  const diagnostics: Diagnostic[] = [];
  const providers = resolveProviders();

  if (providers.length === 0) {
    diagnostics.push({
      stage: "llm",
      severity: "info",
      code: "llm-not-configured",
      message:
        "No LLM provider key is configured — the deterministic rule engine produced this plan.",
    });
    return { model: null, error: "no-provider", provider: null, diagnostics };
  }

  const prompt = buildArchitecturePrompt(
    opts.profile ?? null,
    opts.signals,
    opts.description,
    opts.grounding
  );
  const system = buildSystemPrompt();

  // Tracks the most informative failure so the caller can distinguish "the
  // model answered but cited nothing real" from "nobody answered at all".
  let lastValidationFailure: { provider: string; failure: ArchitectureValidationFailure } | null =
    null;

  for (const provider of providers) {
    const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
    const abort = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    try {
      const { object: raw } = await generateObject({
        model: provider.getModel(),
        schema: ArchitectureModelSchema,
        system,
        prompt,
        temperature: 0,
        maxRetries: 3,
        abortSignal: abort,
      });

      const validation = validateArchitectureModel(raw, opts.profile?.evidenceRegister);
      if (validation.model) {
        return { model: validation.model, error: null, provider: provider.name, diagnostics };
      }

      // The provider is alive and answering; the answer is unusable. Trying the
      // next provider is still worth it — a different model may cite properly.
      lastValidationFailure = { provider: provider.name, failure: validation };
      diagnostics.push({
        stage: "llm",
        severity: "warning",
        code: `llm-model-${validation.reason}`,
        message: `${provider.name} returned a model that failed validation (${validation.reason}).`,
        detail: validation.detail,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[llmClient] ${provider.name}/${provider.model} architecture call failed:`,
        message
      );
      diagnostics.push({
        stage: "llm",
        severity: "warning",
        code: "llm-call-failed",
        message: `LLM provider ${provider.name} failed; trying the next configured provider.`,
        detail: `${provider.model}: ${message}`.slice(0, 1_000),
      });

      // An aborted overall request is not a provider problem — stop retrying.
      if (opts.signal?.aborted) break;
    }
  }

  if (lastValidationFailure) {
    return {
      model: null,
      error: "model-invalid",
      provider: lastValidationFailure.provider,
      diagnostics,
    };
  }

  diagnostics.push({
    stage: "llm",
    severity: "error",
    code: "llm-all-providers-failed",
    message: `All ${providers.length} configured LLM provider(s) failed — falling back to the rule engine.`,
    detail: providers.map((p) => `${p.name}/${p.model}`).join(", "),
  });
  return { model: null, error: "all-providers-failed", provider: null, diagnostics };
}