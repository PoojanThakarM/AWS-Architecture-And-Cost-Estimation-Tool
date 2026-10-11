/**
 * scripts/e2e-test/run.ts — Standalone CLI e2e test runner.
 *
 * Isolated from app code: calls the existing pipeline as a library
 * (repoFetcher -> repoAnalyzer -> inference.runInference -> cost),
 * never through the HTTP API and never touches diagram.ts.
 *
 * Usage: npm run test:e2e-repos  (tsx scripts/e2e-test/run.ts)
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRepoSignals, isInsufficientSignal, signalsToRuleInput } from "../../src/lib/repoFetcher.ts";
import { analyzeProject } from "../../src/lib/repoAnalyzer.ts";
import { runInference, deriveGrounding } from "../../src/lib/inference.ts";
import { computeCostRows } from "../../src/lib/cost.ts";

const TEST_REPOS = [
  { name: "mern-student-mgmt", url: "https://github.com/elselif/MERN" },
  { name: "honours-project-system", url: "https://github.com/davidm03/honours-project-system" },
  { name: "campus-web-firebase", url: "https://github.com/gdsc-jssstu/campUS-Web" },
  { name: "yearbook-firebase", url: "https://github.com/m-ehab2/Yearbook" },
  { name: "springboot-student-backend", url: "https://github.com/PubuduJ/student-management-system-back-end" },
  { name: "springboot-student-mgmt", url: "https://github.com/ankitkumar2020/StudentManagementSystem" },
  { name: "php-library-mgmt", url: "https://github.com/freesourcecode/Library-Management-System-Project-in-PHP-with-Source-Code" },
  { name: "flask-placement-ml", url: "https://github.com/saravanaganesh7/Placement_Project" },
  { name: "flask-ml-deployment", url: "https://github.com/HemanthJoseph/ML-Projects-with-Deployment" },
  { name: "django-blog-sqlite", url: "https://github.com/drisskhattabi6/Django-Blog-Project" },
];

const REGION = "us-east-1";
const USER_COUNT = 1000;
const REQUEST_DEADLINE_MS = 90_000;

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}/month`;
}

async function runOneRepo(repo: { name: string; url: string }): Promise<string> {
  const lines: string[] = [];
  lines.push(`## ${repo.name}`);
  try {
    const signals = await fetchRepoSignals(repo.url, process.env.GITHUB_TOKEN);

    if (isInsufficientSignal(signals)) {
      lines.push(`[engine: n/a]`);
      lines.push(`[FAILED: insufficient signal — repo yielded no manifest/container/README evidence]`);
      return lines.join("\n");
    }

    const grounding = deriveGrounding({ description: "", fetchedFiles: signals.keyFiles });
    const profile = analyzeProject(signals);
    const ruleInput = signalsToRuleInput(signals, "github_url", grounding);
    const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    const { plan, engine } = await runInference({
      ruleInput,
      signals,
      description: "",
      profile,
      signal: deadline,
    });
    lines.push(`[engine: ${engine}]`);

    // Section 1: Detected Codebase Stack
    lines.push(`### Detected Codebase Stack`);
    const stackBullets: string[] = [];
    for (const l of profile.languages) stackBullets.push(`- Language/Runtime: ${l.name} (evidence: ${l.evidence})`);
    for (const f of profile.frameworks) stackBullets.push(`- Framework: ${f.name} (evidence: ${f.evidence})`);
    for (const d of profile.databases) stackBullets.push(`- Database: ${d.name} (evidence: ${d.evidence})`);
    for (const i of profile.infrastructure) stackBullets.push(`- Infrastructure: ${i.name} (evidence: ${i.evidence})`);
    for (const a of profile.awsUsage) stackBullets.push(`- AWS usage: ${a.name} (evidence: ${a.evidence})`);
    for (const h of profile.deploymentHints) stackBullets.push(`- Deployment: ${h.name} (evidence: ${h.evidence})`);
    if (stackBullets.length === 0) stackBullets.push(`- (no stack signals detected)`);
    lines.push(stackBullets.join("\n"));
    lines.push(``);

    // Section 2: Inferred AWS Cloud Services (with evidence + confidence)
    lines.push(`### Inferred AWS Cloud Services`);
    if (plan.awsMappings.length === 0) {
      lines.push(`- (none)`);
    } else {
      for (const m of plan.awsMappings) {
        lines.push(`- ${m.serviceId} (confidence: ${m.confidence}) — ${m.evidence}`);
      }
    }
    lines.push(``);

    // Section 3: Cost Estimation
    lines.push(`### Cost Estimation - Service Cost Breakdown`);
    const cost = await computeCostRows(plan, REGION, USER_COUNT);
    lines.push(`| Service | Monthly Cost | Pricing assumption used |`);
    lines.push(`| --- | --- | --- |`);
    for (const row of cost.rows) {
      lines.push(`| ${row.serviceId} | ${fmtUsd(row.monthlyUsd)} | ${row.annotation} (${row.quantity.toFixed(2)} × ${row.unitLabel} @ $${row.unitPrice}) |`);
    }
    for (const u of cost.unpricedRows) {
      lines.push(`| ${u.serviceId} | unpriced | ${u.note} |`);
    }
    lines.push(`Total: ${fmtUsd(cost.totalMonthlyUsd)}`);
    lines.push(``);

    // Section 4: short deduped summary list
    lines.push(`### Inferred AWS Cloud Services Required`);
    const deduped = [...new Set(plan.awsMappings.map((m) => m.serviceId))];
    if (deduped.length === 0) {
      lines.push(`- (none)`);
    } else {
      for (const id of deduped) lines.push(`- ${id}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    lines.push(`[FAILED: ${reason.slice(0, 300)}]`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "results");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(outDir, `${stamp}.md`);

  const parts: string[] = [
    `# e2e-test results (${stamp})`,
    `Region: ${REGION}, userCount: ${USER_COUNT}`,
    ``,
  ];
  for (const repo of TEST_REPOS) {
    console.log(`--- ${repo.name} ---`);
    const md = await runOneRepo(repo);
    console.log(md + "\n");
    parts.push(md, ``);
  }
  await writeFile(outFile, parts.join("\n"), "utf8");
  console.log(`Wrote ${outFile}`);
}

await main();
