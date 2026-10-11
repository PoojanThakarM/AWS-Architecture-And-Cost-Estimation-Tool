/**
 * Writes CloudFormation templates for every offline regression fixture so
 * they can be checked with cfn-lint (schema validation, no AWS account):
 *
 *   npm run cfn:templates            # writes to ./out/cfn
 *   pip install cfn-lint && cfn-lint out/cfn/*.yaml
 *
 * Passing cfn-lint is NOT the same as a successful AWS deployment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { REPO_FIXTURES } from "../src/lib/__tests__/fixtures/repoFixtures.ts";
import { analyzeProject } from "../src/lib/repoAnalyzer.ts";
import { signalsToRuleInput } from "../src/lib/repoFetcher.ts";
import { runRuleEngine } from "../src/lib/ruleEngine.ts";
import { generateCftYaml } from "../src/lib/cftExport.ts";

const outDir = process.argv[2] ?? "out/cfn";
mkdirSync(outDir, { recursive: true });
for (const [name, signals] of Object.entries(REPO_FIXTURES)) {
  const profile = analyzeProject(signals);
  const plans = runRuleEngine({ ...signalsToRuleInput(signals, "github_url", "repoFiles"), profile }, { returnArray: true });
  plans.forEach((plan, i) => {
    const file = `${outDir}/${name.toLowerCase()}${i ? `-alt${i}` : ""}.yaml`;
    writeFileSync(file, generateCftYaml(plan));
    console.log(`${file}: ${plan.awsMappings.map((m) => m.serviceId).join(", ")}`);
  });
}
