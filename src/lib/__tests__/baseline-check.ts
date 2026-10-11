/**
 * baseline-check.ts — Diagnostic tool for inference pipeline regression testing
 *
 * Runs the 8 repos documented in "testing baseline.md" through the actual
 * inference pipeline (rules-only AND rules+LLM merged) and reports plain-text
 * pass/fail against that file's documented expected architecture and "Do not
 * infer" lists.
 *
 * NOT a unit test — hits real GitHub repos over the network.
 * Run via:  npm run test:baseline
 *           node --experimental-strip-types src/lib/__tests__/baseline-check.ts
 *
 * Source of truth: ../../"testing baseline.md"  (adjacent to package.json)
 * IMPORTANT: Fixture data below is hand-derived from "testing baseline.md".
 *            If that file changes, update FIXTURES here to match.
 *            Search for "SYNC WITH testing_baseline.md" to find all spots.
 */

// MUST be the first import: populates process.env from .env.local before any
// pipeline module initialises. Import declarations are hoisted, so an inline
// process.loadEnvFile() call further down this file would run too late.
import { loadedEnvFiles, envCandidatePaths } from "./loadEnv.ts";

import { fetchRepoSignals, signalsToRuleInput } from "../repoFetcher.ts";
import { analyzeProject } from "../repoAnalyzer.ts";
import { runRuleEngine } from "../ruleEngine.ts";
import { runInference, deriveGrounding } from "../inference.ts";
import { llmConfigured } from "../llmClient.ts";
import type { ServiceId } from "../schema.ts";
import type { RepoSignals } from "../repoFetcher.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Sentinel: repos whose URLs are not yet known
// ---------------------------------------------------------------------------

const NEEDS_URL = "NEEDS_URL" as const;
type MaybeUrl = string | typeof NEEDS_URL;

// ---------------------------------------------------------------------------
// Service name → ServiceId mapping table
//
// SYNC WITH testing_baseline.md
// Maps the prose/AWS-name style used in testing_baseline.md → canonical ServiceId.
// If a name has no confident match, it appears as UNMAPPED in output.
// ---------------------------------------------------------------------------

const SERVICE_NAME_MAP: Record<string, ServiceId> = {
  // Compute
  "Amplify Hosting": "Amplify",
  "Amplify": "Amplify",
  "App Runner": "AppRunner",
  "Fargate": "Fargate",
  "Fargate + ALB": "Fargate",   // Fargate is the compute; ALB is separate
  "EKS": "EKS",
  "EC2": "EC2",
  "Lambda": "Lambda",
  "EC2 g4dn/g5": "EC2",
  "SageMaker Training Job": "SageMaker",
  "SageMaker Endpoint": "SageMaker",
  "SageMaker": "SageMaker",
  "Batch": "Batch",

  // Databases
  "RDS for MySQL": "RDS",
  "RDS for PostgreSQL": "RDS",
  "RDS": "RDS",
  "DynamoDB": "DynamoDB",
  "DocumentDB": "DocumentDB",
  "DocumentDB or external MongoDB Atlas": "DocumentDB",
  "ElastiCache for Redis": "ElastiCache",
  "ElastiCache": "ElastiCache",
  "Aurora": "Aurora",

  // Storage & CDN
  "S3": "S3",
  "S3 + CloudFront": "S3",       // S3 is primary; CloudFront handled separately
  "CloudFront": "CloudFront",
  "ECR": "ECR",

  // Networking
  "ALB": "ALB",
  "API Gateway": "APIGateway",
  "APIGateway": "APIGateway",

  // Messaging
  "MSK": "MSK",
  "MSK for Kafka": "MSK",
  "SQS": "SQS",
  "Glue Schema Registry": "Glue",

  // Security & Auth
  "Cognito": "Cognito",

  // Email
  "SES": "SES",

  // ML / Lambda combo
  "Lambda container + API Gateway": "Lambda",  // Lambda is primary

  // Search
  "OpenSearch Service": "OpenSearch",
  "OpenSearch": "OpenSearch",

  // Observability
  "CloudWatch": "CloudWatch",
  "AMP + AMG": "CloudWatch",  // no AMP/AMG in ServiceId; CloudWatch is closest
  "X-Ray": "XRay",
  "ADOT -> CloudWatch": "CloudWatch",
};

// ---------------------------------------------------------------------------
// Fixtures — SYNC WITH testing_baseline.md
//
// Source of truth: "testing baseline.md" (adjacent to package.json)
//
// URL STATUS as of initial commit — 7 repos require URLs from the operator:
//   Repo #1  Kuzma02 Electronics eCommerce          ← NEEDS_URL
//   Repo #2  Decentralized Voting System             ← confirmed
//   Repo #3  Plant Disease Identification using CNN  ← NEEDS_URL
//   Repo #4  SatvikPraveen Next.js eCommerce         ← NEEDS_URL
//   Repo #5  pandaind/springboot-microservices        ← NEEDS_URL
//   Repo #6  rahult18/springcommerce                 ← NEEDS_URL
//   Repo #7  ibatulanandjp/ecommerce-microservices    ← NEEDS_URL
//   Repo #8  omarfesal/ecommerce-multi-vendor        ← NEEDS_URL
// ---------------------------------------------------------------------------

interface BaselineFixture {
  /** Human-readable repo name from testing_baseline.md */
  name: string;
  /** GitHub https URL or NEEDS_URL sentinel */
  url: MaybeUrl;
  /**
   * Expected services from the "Architecture" section.
   * Each entry is a prose name (resolved via SERVICE_NAME_MAP) or an array of
   * alternatives — any one alternative present in output satisfies that entry.
   * Entries like "S3 + CloudFront" are split on "+" — each part is checked.
   */
  expected: Array<string | string[]>;
  /** Services listed under "Do not infer" — must NOT appear in output. */
  doNotInfer: string[];
}

// SYNC WITH testing_baseline.md ← update both if the doc changes
const FIXTURES: readonly BaselineFixture[] = [
  // ── 1. Kuzma02 Electronics eCommerce ─────────────────────────────────────
  {
    name: "Kuzma02 Electronics eCommerce",
    url: "https://github.com/Kuzma02/Electronics-eCommerce-Shop-With-Admin-Dashboard-NextJS-NodeJS",
    expected: [
      ["Amplify Hosting", "App Runner", "Fargate"], // compute — any one is fine
      "RDS for MySQL",
      "S3 + CloudFront",                            // split into S3 AND CloudFront
    ],
    doNotInfer: [
      // "PostgreSQL" has no ServiceId → maps to RDS, but the intent is MySQL-only;
      // we map "RDS for PostgreSQL" → RDS, so a plain "PostgreSQL" DNI can't be
      // meaningfully tested against the ServiceId allowlist — it's logged UNMAPPED.
      "DynamoDB",
      "Cognito",
      "SES",
      "ElastiCache",
      "SQS",
      "OpenSearch",
      "EKS",
    ],
  },

  // ── 2. Decentralized Voting System ───────────────────────────────────────
  {
    name: "Decentralized Voting System",
    url: "https://github.com/Jaimin-chavda/Decentralized-Voting-System",
    expected: [
      "S3 + CloudFront",
      ["App Runner", "Fargate"],
      ["DocumentDB", "DocumentDB or external MongoDB Atlas"],
    ],
    doNotInfer: [
      "RDS",
      "DynamoDB",
      "Cognito",
      "ElastiCache",
    ],
  },

  // ── 3. Plant Disease Identification using CNN ─────────────────────────────
  {
    name: "Plant Disease Identification using CNN",
    url: "https://github.com/sumanismcse/Plant-Disease-Identification-using-CNN",
    expected: [
      ["SageMaker Training Job", "EC2 g4dn/g5"],
      "S3",
      "ECR",
    ],
    doNotInfer: [
      "RDS",
      "DynamoDB",
      "ALB",
      "CloudFront",
      "Cognito",
      "SQS",
    ],
  },

  // ── 4. SatvikPraveen Next.js eCommerce ───────────────────────────────────
  {
    name: "SatvikPraveen Next.js eCommerce",
    url: "https://github.com/SatvikPraveen/Nextjs-Ecommerce",
    expected: [
      ["Fargate", "Amplify Hosting"],
      "ECR",
      "RDS for PostgreSQL",
      "S3 + CloudFront",
      "SES",
    ],
    doNotInfer: [
      "DynamoDB",
      "ElastiCache",
      "OpenSearch",
      "SQS",
      "Cognito",
      "EKS",
    ],
  },

  // ── 5. pandaind/springboot-microservices ─────────────────────────────────
  {
    name: "pandaind/springboot-microservices",
    url: "https://github.com/pandaind/springboot-microservices",
    expected: [
      "EKS",
      "ECR",
      "ALB",
      "RDS for PostgreSQL",
      "DocumentDB",
      "MSK for Kafka",
      "SES",
    ],
    doNotInfer: [
      "DynamoDB",
      "SQS",       // "SQS as replacement for Kafka" — must not appear
      "Amplify",
      "ElastiCache",
      "OpenSearch",
    ],
  },

  // ── 6. rahult18/springcommerce ────────────────────────────────────────────
  {
    name: "rahult18/springcommerce",
    url: "https://github.com/rahult18/springcommerce",
    expected: [
      "Fargate",
      "ECR",
      "RDS for MySQL",
      "DocumentDB",
      "MSK",
      "SES",
    ],
    doNotInfer: [
      "EKS",
      "DynamoDB",
      "ElastiCache",
      "OpenSearch",
    ],
  },

  // ── 7. ibatulanandjp/ecommerce-microservices ─────────────────────────────
  {
    name: "ibatulanandjp/ecommerce-microservices",
    url: "https://github.com/ibatulanandjp/ecommerce-microservices",
    expected: [
      "Fargate",
      "ECR",
      "RDS for MySQL",
      "DocumentDB",
      "MSK",
      "SES",
    ],
    doNotInfer: [
      "EKS",
      "DynamoDB",
      "ElastiCache",
      "OpenSearch",
      "Amplify",
    ],
  },

  // ── 8. omarfesal/ecommerce-multi-vendor-platform ─────────────────────────
  {
    name: "omarfesal/ecommerce-multi-vendor-platform",
    url: "https://github.com/omarfesal/ecommerce-multi-vendor-platform",
    expected: [
      ["EKS", "Fargate"],
      "ECR",
      "ALB",
      "RDS for PostgreSQL",
      "DynamoDB",
      "ElastiCache for Redis",
      "MSK",
      "OpenSearch Service",
      "S3 + CloudFront",
    ],
    doNotInfer: [],  // README declares all of these; no explicit do-not-infer
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveName(proseName: string): ServiceId | null {
  if (SERVICE_NAME_MAP[proseName] !== undefined) return SERVICE_NAME_MAP[proseName];
  const trimmed = proseName.trim();
  return SERVICE_NAME_MAP[trimmed] ?? null;
}

function planServiceIds(plan: ServicePlan): Set<ServiceId> {
  return new Set(plan.awsMappings.map((m) => m.serviceId));
}

function sortedIds(s: Set<ServiceId>): ServiceId[] {
  return [...s].sort();
}

function fmtIds(ids: ServiceId[]): string {
  return ids.length === 0 ? "(none)" : ids.join(", ");
}

function fmtStrings(strs: string[]): string {
  return strs.length === 0 ? "(none)" : strs.join(", ");
}

// ---------------------------------------------------------------------------
// Expected-service comparison
// ---------------------------------------------------------------------------

function compareExpected(
  expected: Array<string | string[]>,
  planIds: Set<ServiceId>
): { missingEntries: string[]; unmapped: string[] } {
  const missingEntries: string[] = [];
  const unmapped: string[] = [];

  for (const entry of expected) {
    // Normalise to array of alternative prose names
    const alternatives = Array.isArray(entry) ? entry : [entry];

    // Expand "S3 + CloudFront" → ["S3", "CloudFront"]
    // An entry like ["S3 + CloudFront"] succeeds if ANY of S3, CloudFront present.
    const allAltNames = alternatives.flatMap((alt) =>
      alt.includes("+") ? alt.split("+").map((s) => s.trim()) : [alt]
    );

    const resolvedIds = allAltNames.map((name) => ({
      name,
      id: resolveName(name),
    }));

    const knownResolved = resolvedIds.filter((r) => r.id !== null);
    const unknownNames = resolvedIds.filter((r) => r.id === null).map((r) => r.name);

    for (const u of unknownNames) unmapped.push(u);

    if (knownResolved.length > 0) {
      const anyPresent = knownResolved.some((r) => r.id && planIds.has(r.id));
      if (!anyPresent) {
        missingEntries.push(alternatives.join(" | "));
      }
    }
  }

  return { missingEntries, unmapped };
}

// ---------------------------------------------------------------------------
// Do-not-infer check
// ---------------------------------------------------------------------------

function checkDoNotInfer(
  doNotInfer: string[],
  planIds: Set<ServiceId>
): { violations: ServiceId[]; unmapped: string[] } {
  const violations: ServiceId[] = [];
  const unmapped: string[] = [];

  for (const name of doNotInfer) {
    const id = resolveName(name);
    if (id === null) {
      unmapped.push(name);
    } else if (planIds.has(id)) {
      violations.push(id);
    }
  }

  return { violations, unmapped };
}

// ---------------------------------------------------------------------------
// Pipeline helpers — rules-only and merged
// ---------------------------------------------------------------------------

async function runRulesOnly(
  url: string,
  githubToken?: string
): Promise<{ plan: ServicePlan; signals: RepoSignals }> {
  const signals = await fetchRepoSignals(url, githubToken);
  const grounding = deriveGrounding({ description: "", fetchedFiles: signals.keyFiles });
  const ruleInput = signalsToRuleInput(signals, "github_url", grounding);
  const profile = analyzeProject(signals);
  // runRuleEngine is synchronous and does NOT call llmConfigured() — always rules-only.
  const plan = runRuleEngine({ ...ruleInput, profile });
  return { plan, signals };
}

async function runMerged(
  url: string,
  signals: RepoSignals,
  _githubToken?: string
): Promise<{ plan: ServicePlan; usedLlm: boolean }> {
  const grounding = deriveGrounding({ description: "", fetchedFiles: signals.keyFiles });
  const ruleInput = signalsToRuleInput(signals, "github_url", grounding);
  const profile = analyzeProject(signals);
  // runInference calls llmConfigured() internally; if no key is set it uses rules.
  // architectureModel is non-null only when the LLM path actually produced a model,
  // so it is the honest signal for whether this column measured anything new.
  const { plan, architectureModel } = await runInference({
    ruleInput,
    signals,
    description: "",
    profile,
  });
  return { plan, usedLlm: architectureModel !== null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * The merged column only means something if an LLM provider is actually
 * reachable. Pass --rules-only to intentionally measure the rules baseline
 * alone; otherwise a missing key is a hard failure, not a silent fallback.
 */
const RULES_ONLY_MODE = process.argv.includes("--rules-only");
const V2_MODE = process.argv.includes("--v2");

// ---------------------------------------------------------------------------
// V2 fixtures — derived from testing_baseline_v2.md (12 benchmark repos).
// Invariants per repo: compute exclusivity, DB engine label, do-not-infer,
// provenance completeness, terminal state.
// ---------------------------------------------------------------------------

interface V2Fixture {
  name: string;
  url: string;
  expected: ServiceId[];
  doNotInfer: ServiceId[];
  /** Expected engine substring in the RDS mapping evidence ("(PostgreSQL)" / "(MySQL)"), or null. */
  expectedDbEngine: string | null;
  expectedTerminalState: string;
}

const V2_FIXTURES: readonly V2Fixture[] = [
  { name: "example-voting-app", url: "https://github.com/dockersamples/example-voting-app", expected: ["ECS", "RDS"], doNotInfer: ["EKS", "Lambda", "EC2", "Fargate"], expectedDbEngine: "(PostgreSQL)", expectedTerminalState: "OK" },
  { name: "microservices-demo", url: "https://github.com/GoogleCloudPlatform/microservices-demo", expected: ["EKS"], doNotInfer: ["ECS", "RDS", "Lambda", "EC2", "Fargate"], expectedDbEngine: null, expectedTerminalState: "OK" },
  { name: "spring-petclinic", url: "https://github.com/spring-projects/spring-petclinic", expected: ["ECS", "RDS"], doNotInfer: ["EKS", "Lambda", "EC2"], expectedDbEngine: "(MySQL)", expectedTerminalState: "OK" },
  { name: "realworld-node-express", url: "https://github.com/gothinkster/node-express-realworld-example-app", expected: ["ECS", "ALB", "RDS"], doNotInfer: ["EKS", "Lambda", "EC2"], expectedDbEngine: "(PostgreSQL)", expectedTerminalState: "OK" },
  { name: "realworld-django", url: "https://github.com/gothinkster/django-realworld-example-app", expected: ["ECS", "ALB", "RDS"], doNotInfer: ["EKS", "Lambda", "EC2"], expectedDbEngine: "(PostgreSQL)", expectedTerminalState: "OK" },
  { name: "realworld-golang", url: "https://github.com/gothinkster/golang-gin-realworld-example-app", expected: ["ECS", "ALB", "RDS"], doNotInfer: ["EKS", "Lambda", "EC2"], expectedDbEngine: "(PostgreSQL)", expectedTerminalState: "OK" },
  { name: "terraform-eks", url: "https://github.com/hashicorp/learn-terraform-provision-eks-cluster", expected: ["EKS", "EC2", "VPC", "IAM"], doNotInfer: ["ECS", "Lambda", "RDS"], expectedDbEngine: null, expectedTerminalState: "IAC_ONLY" },
  { name: "aws-serverless-workshops", url: "https://github.com/aws-samples/aws-serverless-workshops", expected: ["Lambda", "S3", "DynamoDB", "StepFunctions"], doNotInfer: ["ECS", "EKS", "EC2", "RDS", "Aurora", "Athena", "SageMaker"], expectedDbEngine: null, expectedTerminalState: "OK" },
  { name: "supabase", url: "https://github.com/supabase/supabase", expected: ["RDS", "S3", "ALB"], doNotInfer: ["EKS", "Lambda"], expectedDbEngine: null, expectedTerminalState: "MONOREPO_OK" },
  { name: "oak", url: "https://github.com/oakserver/oak", expected: [], doNotInfer: ["ECS", "EKS", "Lambda", "ALB", "APIGateway", "RDS"], expectedDbEngine: null, expectedTerminalState: "LIBRARY_REPO" },
  { name: "go-kit-examples", url: "https://github.com/go-kit/examples", expected: ["ECS", "ALB"], doNotInfer: ["EKS", "Lambda", "EC2"], expectedDbEngine: null, expectedTerminalState: "OK" },
  { name: "decentralized-voting-system", url: "https://github.com/Jaimin-chavda/Decentralized-Voting-System", expected: ["S3", "CloudFront"], doNotInfer: ["ECS", "EKS", "Lambda", "RDS", "DynamoDB"], expectedDbEngine: null, expectedTerminalState: "OK" },
];

const COMPUTE_EXCLUSIVITY_SET: ServiceId[] = ["ECS", "EKS", "Lambda", "EC2", "Fargate"];

async function runV2(githubToken?: string): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const fx of V2_FIXTURES) {
    console.log(`=== ${fx.name} ===`);
    let plan: ServicePlan;
    try {
      const { plan: p } = await runRulesOnly(fx.url, githubToken);
      plan = p;
    } catch (err) {
      console.log(`  Status : FAIL (fetch/rules error: ${(err as Error).message})`);
      fail++;
      continue;
    }
    const ids = planServiceIds(plan);
    const problems: string[] = [];

    // 1. Compute exclusivity (EKS + EC2 node-group pair is IaC-declared, allowed)
    const computeFound = COMPUTE_EXCLUSIVITY_SET.filter((s) => ids.has(s));
    const eksEc2PairOnly =
      computeFound.length === 2 && computeFound.includes("EKS") && computeFound.includes("EC2");
    if (computeFound.length > 1 && !eksEc2PairOnly) {
      problems.push(`compute exclusivity: ${computeFound.join(", ")}`);
    }

    // 2. Expected services
    for (const exp of fx.expected) {
      if (!ids.has(exp)) problems.push(`missing expected: ${exp}`);
    }

    // 3. Do Not Infer
    for (const ban of fx.doNotInfer) {
      if (ids.has(ban)) problems.push(`do-not-infer violation: ${ban}`);
    }

    // 4. Database engine label
    if (fx.expectedDbEngine) {
      const rds = plan.awsMappings.find((m) => m.serviceId === "RDS");
      if (!rds) problems.push("missing RDS for engine-label check");
      else if (!rds.evidence.includes(fx.expectedDbEngine)) {
        problems.push(`RDS evidence missing engine label ${fx.expectedDbEngine}: "${rds.evidence}"`);
      }
    }

    // 5. Provenance completeness
    for (const m of plan.awsMappings) {
      if (!m.category || !m.evidence) problems.push(`provenance gap: ${m.serviceId}`);
    }

    // 6. Terminal state
    const actualTerminal = (plan as ServicePlan).terminalState ?? "OK";
    if (actualTerminal !== fx.expectedTerminalState) {
      problems.push(`terminal state: expected ${fx.expectedTerminalState}, got ${actualTerminal}`);
    }

    console.log(`  Services: [${fmtIds(sortedIds(ids))}] terminal=${actualTerminal}`);
    if (problems.length > 0) {
      for (const p of problems) console.log(`    - ${p}`);
      console.log("  Status : FAIL");
      fail++;
    } else {
      console.log("  Status : PASS");
      pass++;
    }
    console.log();
  }
  console.log("=".repeat(72));
  console.log(`${pass}/${V2_FIXTURES.length} v2 repos passing`);
  console.log("=".repeat(72));
  if (fail > 0) process.exit(1);
}

async function main(): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (V2_MODE) {
    await runV2(githubToken);
    return;
  }
  const llmPresent = llmConfigured();

  console.log("=".repeat(72));
  console.log("  AWS Architecture Inference — Baseline Diagnostic Check");
  console.log("=".repeat(72));
  console.log(`  Mode           : ${RULES_ONLY_MODE ? "rules-only (--rules-only)" : "merged (rules + LLM)"}`);
  console.log(`  env files      : ${loadedEnvFiles.length > 0 ? loadedEnvFiles.join(", ") : "(none found)"}`);
  console.log(`  LLM configured : ${llmPresent ? "YES" : "NO"}`);
  console.log(`  GitHub token   : ${githubToken ? "YES (authenticated)" : "NO (60 req/hr)"}`);
  console.log("=".repeat(72));
  console.log();

  // Wave 0 gate: never let the merged column silently re-measure rules-only.
  if (!RULES_ONLY_MODE && !llmPresent) {
    throw new Error(
      "No LLM provider key found — the 'merged' column would silently re-run the " +
        "rules baseline, making both columns identical and the measurement invalid.\n" +
        `  Checked .env.local at: ${envCandidatePaths.join(", ")}\n` +
        "  Set DEEPSEEK_API_KEY, GOOGLE_API_KEY, or GROQ_API_KEY in .env.local,\n" +
        "  or pass --rules-only to measure the rules baseline deliberately."
    );
  }

  let totalPass = 0;
  let totalFail = 0;
  let rulesOnlyPass = 0;
  let rulesOnlyFail = 0;
  let mergedPass = 0;
  let mergedFail = 0;
  let skipped = 0;
  // How many merged runs genuinely used the LLM vs. silently fell back to rules.
  let llmPathUsed = 0;
  let llmPathFellBack = 0;

  for (const fixture of FIXTURES) {
    console.log(`=== ${fixture.name} ===`);

    if (fixture.url === NEEDS_URL) {
      console.log(`  URL    : *** NEEDS_URL — supply this repo's GitHub URL to enable ***`);
      console.log(`  Status : SKIPPED (no URL)\n`);
      skipped++;
      continue;
    }

    console.log(`  URL    : ${fixture.url}`);

    const expectedDisplay = fixture.expected
      .map((e) => (Array.isArray(e) ? e.join(" | ") : e))
      .join(", ");
    console.log(`  Expected: ${expectedDisplay}`);

    // ── Fetch once, reuse signals for both modes ──────────────────────────
    let rulesOnlyPlan: ServicePlan;
    let mergedPlan: ServicePlan;
    let signals!: RepoSignals;

    try {
      process.stdout.write("  [rules-only] fetching + running... ");
      const result = await runRulesOnly(fixture.url, githubToken);
      rulesOnlyPlan = result.plan;
      signals = result.signals;
      console.log("done");
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      console.log(`  Status : FAIL (fetch/rules error)\n`);
      totalFail++;
      rulesOnlyFail++;
      mergedFail++;
      continue;
    }

    // ── Rules-only report ─────────────────────────────────────────────────
    const rulesIds = planServiceIds(rulesOnlyPlan);
    const { missingEntries: rMissing, unmapped: rUnmapped } =
      compareExpected(fixture.expected, rulesIds);
    const { violations: rViolations, unmapped: rDNIUnmapped } =
      checkDoNotInfer(fixture.doNotInfer, rulesIds);

    console.log(`  Rules-only: [${fmtIds(sortedIds(rulesIds))}]`);
    if (rUnmapped.length > 0)
      console.log(`    UNMAPPED (expected): ${rUnmapped.map((u) => `UNMAPPED: "${u}" — skipped from comparison`).join("; ")}`);
    if (rDNIUnmapped.length > 0)
      console.log(`    UNMAPPED (do-not-infer): ${rDNIUnmapped.map((u) => `UNMAPPED: "${u}" — skipped from comparison`).join("; ")}`);
    if (rMissing.length > 0)
      console.log(`    MISSING: ${fmtStrings(rMissing)}`);
    if (rViolations.length > 0)
      console.log(`    DO-NOT-INFER violations: ${fmtIds(rViolations)}`);

    const rulesOk = rMissing.length === 0 && rViolations.length === 0;
    console.log(`    → ${rulesOk ? "PASS" : "FAIL"}`);
    if (rulesOk) rulesOnlyPass++; else rulesOnlyFail++;

    // ── Rules-only mode stops here: no LLM call, verdict from rules alone ──
    if (RULES_ONLY_MODE) {
      const rulesModeRepoPass = rulesOk;
      console.log(`  Status : ${rulesModeRepoPass ? "PASS" : "FAIL"}`);
      console.log();
      if (rulesModeRepoPass) totalPass++; else totalFail++;
      continue;
    }

    // ── Merged (rules+LLM) report ─────────────────────────────────────────
    try {
      process.stdout.write("  [merged]     running inference...   ");
      const merged = await runMerged(fixture.url, signals, githubToken);
      mergedPlan = merged.plan;
      if (merged.usedLlm) {
        llmPathUsed++;
        console.log("done (LLM)");
      } else {
        llmPathFellBack++;
        console.log("done (LLM UNAVAILABLE — rules fallback)");
      }
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      console.log(`  Status : FAIL (merged inference error)\n`);
      totalFail++;
      mergedFail++;
      continue;
    }

    const mergedIds = planServiceIds(mergedPlan);
    const { missingEntries: mMissing, unmapped: mUnmapped } =
      compareExpected(fixture.expected, mergedIds);
    const { violations: mViolations, unmapped: mDNIUnmapped } =
      checkDoNotInfer(fixture.doNotInfer, mergedIds);

    console.log(`  Merged:     [${fmtIds(sortedIds(mergedIds))}]`);
    if (mUnmapped.length > 0)
      console.log(`    UNMAPPED (expected): ${mUnmapped.map((u) => `UNMAPPED: "${u}" — skipped from comparison`).join("; ")}`);
    if (mDNIUnmapped.length > 0)
      console.log(`    UNMAPPED (do-not-infer): ${mDNIUnmapped.map((u) => `UNMAPPED: "${u}" — skipped from comparison`).join("; ")}`);
    if (mMissing.length > 0)
      console.log(`    MISSING: ${fmtStrings(mMissing)}`);
    if (mViolations.length > 0)
      console.log(`    DO-NOT-INFER violations: ${fmtIds(mViolations)}`);

    const mergedOk = mMissing.length === 0 && mViolations.length === 0;
    console.log(`    → ${mergedOk ? "PASS" : "FAIL"}`);
    if (mergedOk) mergedPass++; else mergedFail++;

    // ── Overall repo verdict ──────────────────────────────────────────────
    // FAIL if: any do-not-infer violation in EITHER mode, OR any expected service
    // missing from the MERGED output (rules-only missing is informational).
    const repoPass =
      mViolations.length === 0 &&
      rViolations.length === 0 &&
      mMissing.length === 0;

    console.log(`  Status : ${repoPass ? "PASS" : "FAIL"}`);
    console.log();

    if (repoPass) totalPass++; else totalFail++;
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  const total = FIXTURES.length;
  const ran = total - skipped;

  console.log("=".repeat(72));
  if (RULES_ONLY_MODE) {
    console.log(`${totalPass}/${ran} repos passing (rules-only mode; LLM path not exercised)`);
  } else {
    console.log(`${totalPass}/${ran} repos passing (rules-only: ${rulesOnlyPass}/${ran}, merged: ${mergedPass}/${ran})`);
    console.log(
      `merged column: ${llmPathUsed} run(s) used the LLM, ${llmPathFellBack} fell back to rules`
    );
  }
  if (!RULES_ONLY_MODE && llmPathUsed === 0 && ran > 0) {
    console.log(
      "WARNING: no merged run reached the LLM — the two columns above measure the " +
        "same pipeline and are not comparable."
    );
  }
  if (llmPathFellBack > 0 && llmPathUsed > 0) {
    console.log(
      `NOTE: ${llmPathFellBack} repo(s) fell back to rules mid-run (LLM error or ` +
        "all components rejected by evidence validation)."
    );
  }

  if (skipped > 0) {
    console.log();
    console.log(`${skipped} repo(s) skipped (NEEDS_URL). Supply GitHub URLs to enable:`);
    for (const f of FIXTURES) {
      if (f.url === NEEDS_URL) console.log(`  • ${f.name}`);
    }
  }

  console.log("=".repeat(72));

  if (totalFail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("baseline-check fatal error:", err);
  process.exit(2);
});
