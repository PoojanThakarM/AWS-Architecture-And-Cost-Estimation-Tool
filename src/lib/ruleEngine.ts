/**
 * ruleEngine.ts
 *
 * Deterministic signal-based service detection — produces a ServicePlan
 * baseline without any LLM call. No pattern scoring, no slot limits.
 * Patterns only used as sanity-check in final mapping (architecture.ts).
 */

import { ServicePlanSchema, SERVICE_IDS } from "./schema.ts";
import { isWorkspaceRootPath } from "./repoFetcher.ts";
import type {
  ServicePlan,
  ServiceId,
  ConfidenceTier,
  Grounding,
  DiscoveredComponent,
  ComponentRelationship,
  DeploymentModel,
  AwsServiceMapping,
  MappingCategory,
} from "./schema.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";
import { type PatternId, deduplicateAwsMappings } from "./architecture.ts";
import { buildAlternateProposal } from "./patternAlternates.ts";

// ---------------------------------------------------------------------------
// RuleInput — signals available to the rule engine
// ---------------------------------------------------------------------------

export interface RuleInput {
  description: string;
  fileContent: string;
  fileNames: string[];
  inputKind: "github_url" | "description";
  grounding: Grounding;
  truncated: boolean;
  parseErrors: string[];
  profile?: ProjectProfile;
}

// ---------------------------------------------------------------------------
// Service detection — keyword + profile-based
// ---------------------------------------------------------------------------

export interface DetectedService {
  serviceId: ServiceId;
  confidence: ConfidenceTier;
  evidence: string;
  category?: MappingCategory;
}

const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_RANK: Record<MappingCategory, number> = {
  "repository-evidence": 4,
  "deployment-requirement": 3,
  "inference": 2,
  "recommendation": 1,
};

function hasAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function hasWord(text: string, words: string[]): boolean {
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(text);
  });
}

/** Splits "### path\\ncontent" sections back into per-file blocks. */
function splitByFile(combined: string): Array<{ path: string; content: string }> {
  const sections: Array<{ path: string; content: string }> = [];
  const lines = combined.split("\n");
  let curPath: string | null = null;
  let curLines: string[] = [];
  const flush = () => {
    if (curPath !== null) sections.push({ path: curPath, content: curLines.join("\n") });
  };
  for (const line of lines) {
    const m = line.match(/^### (.+)$/);
    if (m) {
      flush();
      curPath = m[1].trim();
      curLines = [];
    } else if (curPath !== null) {
      curLines.push(line);
    }
  }
  flush();
  return sections;
}

function isReadmePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^readme(\.\w+)?$/i.test(base);
}

/**
 * Combined text minus README sections and minus "### path" header lines.
 * Headers duplicate fileNames (covered by fileHas); leaving them in lets
 * directory names (e.g. apigateway/main.go) fake keyword hits.
 */
function codeOnlyText(combined: string): string {
  const sections = splitByFile(combined);
  if (sections.length === 0) return combined;
  const kept = sections.filter((s) => !isReadmePath(s.path));
  const head = combined.split(/^### /m)[0] ?? "";
  return [head, ...kept.map((s) => s.content)].join("\n");
}

/** Primary IaC/serverless templates whose Resources/functions blocks rule. */
function hasPrimaryIacTemplates(fileNames: string[]): boolean {
  return fileNames.some((f) => {
    const base = f.split("/").pop() ?? f;
    return (
      /^(template|sam)\.(ya?ml)$/i.test(base) ||
      /^serverless(\.[^.]*)?\.(ya?ml)$/i.test(base) ||
      /^cdk\.json$/i.test(base) ||
      /\.tf$/i.test(f)
    );
  });
}

/**
 * Compute exclusivity: exactly one service from the compute hierarchy wins.
 * Ordered by specificity — serverless first, then orchestrators, then hosts.
 */
const COMPUTE_HIERARCHY: ServiceId[] = [
  "Lambda", "EKS", "ECS", "Fargate", "AppRunner", "ElasticBeanstalk",
  "EC2", "Lightsail", "Batch", "SageMaker",
];

function k8sWeight(fileNames: string[]): number {
  let w = 0;
  for (const f of fileNames) {
    const lower = f.toLowerCase();
    if (/(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\//.test(lower)) w++;
    else if (/chart\.yaml$/i.test(f)) w++;
    else if (/(?:^|\/)(?:ingress|deployment|service|statefulset|daemonset|configmap)\.ya?ml$/i.test(lower)) w++;
    else if (/\.github\/workflows\/.+\.(ya?ml)$/i.test(lower)) w += 0;
  }
  return w;
}

function containerWeight(fileNames: string[]): number {
  let w = 0;
  for (const f of fileNames) {
    const lower = f.toLowerCase();
    if (/(?:^|\/)dockerfile(\.[\w.-]+)?$/i.test(f)) w++;
    else if (/docker-compose(\.[\w.-]+)?\.(ya?ml)$/i.test(lower)) w++;
    else if (/\.tf$/i.test(lower)) w++;
  }
  return w;
}

/**
 * Resolves compute exclusivity in place: drops every compute sibling of the
 * winner from `detected`. Never promotes a service that was not detected.
 */
function resolveComputeExclusivity(
  detected: DetectedService[],
  fileNames: string[],
  protectedIds: Set<ServiceId> = new Set()
): void {
  // Fargate is a launch type of ECS — fold in, do not double-count.
  const hasEcs = detected.some((d) => d.serviceId === "ECS");
  if (hasEcs) {
    for (let i = detected.length - 1; i >= 0; i--) {
      if (detected[i].serviceId === "Fargate") detected.splice(i, 1);
    }
  }

  const compute = detected.filter((d) =>
    (COMPUTE_HIERARCHY as string[]).includes(d.serviceId)
  );
  if (compute.length <= 1) return;

  const rankOf = (d: DetectedService): [number, number, number] => [
    COMPUTE_HIERARCHY.indexOf(d.serviceId),
    CONFIDENCE_RANK[d.confidence],
    CATEGORY_RANK[d.category ?? "inference"],
  ];

  let winner: DetectedService;
  const lambdaHigh = compute.find(
    (d) =>
      d.serviceId === "Lambda" &&
      d.confidence === "high" &&
      d.category === "repository-evidence"
  );
  if (lambdaHigh) {
    winner = lambdaHigh;
  } else {
    const kw = k8sWeight(fileNames);
    const cw = containerWeight(fileNames);
    const eks = compute.find((d) => d.serviceId === "EKS");
    const ecs = compute.find((d) => d.serviceId === "ECS");
    const hasCompose = fileNames.some((f) =>
      /docker-compose(\.[\w.-]+)?\.(ya?ml)$/i.test(f)
    );
    if (eks && kw >= 2 && (!hasCompose || kw >= 3)) {
      winner = eks;
    } else if (ecs && cw > 0 && (kw === 0 || (hasCompose && kw < 3))) {
      winner = ecs;
    } else {
      winner = [...compute].sort((a, b) => {
        const [ai, ac, ag] = rankOf(a);
        const [bi, bc, bg] = rankOf(b);
        return ai - bi || bg - ag || bc - ac;
      })[0];
    }
  }

  const losers = new Set(
    compute.filter((d) => d !== winner).map((d) => d.serviceId)
  );
  // IaC-declared compute pairs (e.g. EKS + EC2 node groups) survive together.
  for (const kept of protectedIds) losers.delete(kept);
  for (let i = detected.length - 1; i >= 0; i--) {
    if (losers.has(detected[i].serviceId)) detected.splice(i, 1);
  }
}

/**
 * Backend web frameworks: a source-only repo using one of these with no
 * compute detected gets the default web/backend archetype (ECS + ALB).
 * Frontend-only frameworks are excluded — they fall through to the
 * static-hosting branch instead.
 */
const BACKEND_FRAMEWORKS = [
  "Express", "Fastify", "Koa", "NestJS", "Hono",
  "Django", "Flask", "FastAPI", "Starlette", "Gunicorn", "Uvicorn",
  "Spring Boot", "Spring WebFlux", "Quarkus", "Micronaut",
  "Rails", "Sinatra", "Laravel", "Symfony",
  "Gin", "Echo", "Fiber", "Chi", "Gorilla Mux",
  "Axum", "Actix", "Rocket", "ASP.NET",
];

function profileHasBackendFramework(profile: ProjectProfile | undefined): boolean {
  if (!profile) return false;
  return profile.frameworks.some((f) =>
    BACKEND_FRAMEWORKS.some((b) => f.name.toLowerCase().includes(b.toLowerCase()))
  );
}

/** Frontend-only frameworks: static-hosting archetype, never a backend host. */
const FRONTEND_ONLY_FRAMEWORKS = [
  "React", "Vue", "Svelte", "SolidJS", "Angular", "Astro", "Gatsby", "Hugo", "Jekyll",
];

function profileHasFrontendOnlyFramework(profile: ProjectProfile | undefined): boolean {
  if (!profile) return false;
  return profile.frameworks.some((f) =>
    FRONTEND_ONLY_FRAMEWORKS.some((b) => f.name.toLowerCase().includes(b.toLowerCase()))
  );
}

function profileHasAnyDatabase(profile: ProjectProfile | undefined): boolean {
  return Boolean(profile && profile.databases.length > 0);
}

export type RdsEngine = "postgres" | "mysql" | "none";

/**
 * Resolves the relational engine from code evidence. A connection-string
 * scheme wins outright; Spring Boot + MySQL-specific artifacts wins MySQL
 * when both drivers are present; otherwise Postgres is the default.
 */
export function detectRdsEngine(
  combined: string,
  profile?: ProjectProfile
): RdsEngine {
  if (/postgres(ql)?:\/\//i.test(combined)) return "postgres";
  if (/mysqldb|mysql|mariadb:\/\//i.test(combined)) return "mysql";

  const postgresEv = dbEvidence(profile, "postgresql") || dbEvidence(profile, "postgres");
  const mysqlEv = dbEvidence(profile, "mysql") || dbEvidence(profile, "mariadb");
  const textHasPostgres = Boolean(postgresEv) || /postgres|postgresql/i.test(combined);
  const textHasMysql = Boolean(mysqlEv) || /mysql|mariadb/i.test(combined);

  if (textHasPostgres && textHasMysql) {
    const springMysql =
      /spring/i.test(combined) &&
      (/mysql-connector|mysql:mysql/i.test(combined) ||
        (/spring\.datasource\.url/i.test(combined) && /mysql/i.test(combined)) ||
        Boolean(mysqlEv));
    return springMysql ? "mysql" : "postgres";
  }
  if (textHasMysql) return "mysql";
  if (textHasPostgres) return "postgres";
  // No driver string, but a corroborated ORM framework implies a relational
  // store — default to PostgreSQL (MySQL needs MySQL-specific evidence).
  if (familyOrmCorroborated(combined, profile, [])) return "postgres";
  return "none";
}

interface NegativeRule {
  /** Stable reason recorded when the rule fires. */
  reason: string;
  when: (ctx: {
    combined: string;
    fileNames: string[];
    profile?: ProjectProfile;
  }) => boolean;
  forbid: ServiceId[];
}

/** Baseline "Do Not Infer" cases: splice forbidden IDs out of detected. */
const NEGATIVE_RULES: NegativeRule[] = [
  {
    reason: "serverless-first repo: no persistent-server services beyond IaC",
    when: ({ combined, fileNames }) => {
      const hasServerless =
        fileNames.some((f) => {
          const base = f.split("/").pop() ?? f;
          return (
            /^serverless(\.[^.]*)?\.(ya?ml)$/i.test(base) ||
            /^(template|sam)\.(ya?ml)$/i.test(base)
          );
        }) || /AWS::Lambda::Function/i.test(combined);
      const hasContainerIac =
        /aws_ecs|aws_eks|AWS::ECS|AWS::EKS/i.test(combined) ||
        fileNames.some((f) => /(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\//i.test(f));
      return hasServerless && !hasContainerIac;
    },
    forbid: ["ECS", "EKS", "EC2", "RDS", "ElastiCache"],
  },
  {
    reason: "ML training pipeline: no serving ingress",
    when: ({ profile }) =>
      profile?.workloadClassification?.primaryWorkload === "ml-training" ||
      profile?.workloadClassification?.type === "ml-training",
    forbid: ["ALB", "CloudFront", "Route53", "APIGateway"],
  },
  {
    reason: "admin/monitoring stack: no app tiers",
    when: ({ profile }) =>
      profile?.workloadClassification?.primaryWorkload === "admin-monitoring-tool" ||
      profile?.workloadClassification?.type === "admin-monitoring-tool",
    forbid: ["CloudFront", "ALB", "APIGateway", "RDS", "DynamoDB", "OpenSearch"],
  },
  {
    reason: "pure library: no deployable runtime",
    when: ({ profile, fileNames }) => {
      if (!profile) return false;
      if (profile.isLibraryOrFramework) return true;
      if (profile.entryPoints.length > 0) return false;
      if (profileHasBackendFramework(profile) || profileHasFrontendOnlyFramework(profile)) return false;
      // Container / orchestrator / IaC config means a deployable exists.
      if (
        fileNames.some((f) =>
          /(?:^|\/)dockerfile(\.[\w.-]+)?$/i.test(f) ||
          /docker-compose(\.[\w.-]+)?\.(ya?ml)$/i.test(f) ||
          /(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\//i.test(f) ||
          /chart\.yaml$/i.test(f) ||
          /\.(tf)$/i.test(f) ||
          /^(template|sam)\.(ya?ml)$/i.test(f.split("/").pop() ?? f) ||
          /^serverless(\.[^.]*)?\.(ya?ml)$/i.test(f.split("/").pop() ?? f)
        )
      ) {
        return false;
      }
      const comps = profile.discoveredComponents ?? [];
      return comps.every((c) => (c.type as string) === "other" || (c.type as string) === "object-storage" || (c.type as string) === "storage");
    },
    forbid: ["ECS", "EKS", "Lambda", "ALB", "APIGateway", "RDS"],
  },
];

function applyNegativeRules(
  detected: DetectedService[],
  ctx: { combined: string; fileNames: string[]; profile?: ProjectProfile }
): void {
  // Manifest-confirmed libraries map to an empty service set, full stop.
  if (ctx.profile?.isLibraryOrFramework) {
    detected.length = 0;
    return;
  }
  for (const rule of NEGATIVE_RULES) {
    if (!rule.when(ctx)) continue;
    const banned = new Set<string>(rule.forbid);
    for (let i = detected.length - 1; i >= 0; i--) {
      if (banned.has(detected[i].serviceId)) detected.splice(i, 1);
    }
  }
}

/** Primary language families for ORM corroboration (cross-language ORM mentions do not count). */
function primaryLanguageFamilies(profile?: ProjectProfile): Set<string> {
  const fams = new Set<string>();
  if (!profile) return fams;
  for (const l of profile.languages) {
    const n = l.name.toLowerCase();
    if (/python/.test(n)) fams.add("python");
    else if (/node|typescript|javascript/.test(n)) fams.add("js");
    else if (/java|jvm/.test(n)) fams.add("java");
    else if (/\bgo\b/.test(n)) fams.add("go");
    else if (/ruby/.test(n)) fams.add("ruby");
    else if (/c#|dotnet|net/.test(n)) fams.add("dotnet");
    else if (/php/.test(n)) fams.add("php");
  }
  return fams;
}

const FAMILY_ORMS: Record<string, RegExp[]> = {
  python: [/sqlalchemy/i, /django\.db/i, /\bdjango\b.*orm/i, /django/i],
  js: [/prisma/i, /typeorm/i, /sequelize/i, /\bknex\b/i],
  java: [/hibernate/i, /spring[\s_-]*data/i, /\bjpa\b/i],
  go: [/gorm/i, /sqlx/i],
  ruby: [/activerecord/i, /active_record/i],
  dotnet: [/entityframework/i, /efcore/i, /entity framework/i],
  php: [/eloquent/i, /doctrine/i],
};

function dirOfEvidence(evidence: string | null): string | null {
  if (!evidence) return null;
  const path = evidence.split(" → ")[0] ?? evidence;
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "(root)";
}

function driverEvidenceDirs(profile?: ProjectProfile): string[] {
  if (!profile) return [];
  const dirs: string[] = [];
  for (const d of profile.databases) {
    if (/postgres|mysql|mariadb/i.test(d.name)) {
      dirs.push(dirOfEvidence(d.evidence));
    }
  }
  return dirs;
}

/**
 * Same-family ORM corroboration. A cross-language ORM mention does not count,
 * and the ORM must share a top-level directory with a relational driver —
 * except when no driver string exists at all, in which case a corroborated
 * full-stack ORM framework (Django/Rails/Laravel/Spring-Data-style) implies a
 * relational store on its own.
 */
function familyOrmCorroborated(
  combined: string,
  profile?: ProjectProfile,
  driverDirs: string[] = []
): boolean {
  const fams = primaryLanguageFamilies(profile);
  const ormMatched =
    fams.size === 0
      ? Object.values(FAMILY_ORMS).some((res) => res.some((re) => re.test(combined)))
      : [...fams].some((fam) => (FAMILY_ORMS[fam] ?? []).some((re) => re.test(combined)));
  if (!ormMatched) {
    if (profile) {
      const fw = profile.frameworks.map((f) => f.name.toLowerCase()).join(" ");
      if (/django|rails|laravel|spring data|spring boot/.test(fw)) return true;
    }
    return false;
  }
  // ORM matched: co-locate with a driver, or no driver anywhere (implied store).
  if (driverDirs.length === 0 && !/postgres|mysql|mariadb/i.test(combined)) return true;
  const ormDirs = new Set<string>();
  if (profile) {
    for (const f of [...profile.frameworks, ...profile.databases]) {
      if (Object.values(FAMILY_ORMS).some((res) => res.some((re) => re.test(f.name)))) {
        ormDirs.add(dirOfEvidence(f.evidence));
      }
    }
  }
  if (ormDirs.size === 0) {
    // ORM seen only in raw text: accept only when the driver is equally
    // unlocated (both bare mentions, same file blob).
    return driverDirs.length === 0;
  }
  return driverDirs.some((d) => ormDirs.has(d));
}

/**
 * Corroboration gate: true when a DB connection URL, a same-family ORM, a
 * migrations directory, a database discoveredComponent, or a compose DB
 * service block is present.
 */
export function isDbCorroborated(
  combined: string,
  profile?: ProjectProfile,
  fileNames: string[] = []
): boolean {
  if (/(?:postgres|postgresql|mysql|mariadb):\/\/|DATABASE_URL|DB_HOST|DB_PASSWORD|POSTGRES_USER|MYSQL_DATABASE|RDS_ENDPOINT/i.test(combined)) {
    return true;
  }
  if (familyOrmCorroborated(combined, profile, driverEvidenceDirs(profile))) return true;
  if (fileNames.some((f) => /(?:^|\/)migrations?\/|db\/migrate|alembic|flyway|liquibase/i.test(f))) {
    return true;
  }
  if (profile?.discoveredComponents?.some((c) => c.type === "database")) {
    return true;
  }
  if (/image:\s*(postgres|mysql|mariadb)/i.test(combined)) {
    return true;
  }
  return false;
}

/** Service-specific IaC resource tokens for corroborating SDK-only matches. */
const IAC_TOKENS: Record<string, RegExp> = {
  Lambda: /aws::lambda|aws_lambda|serverless::function|aws::serverless::function/i,
  S3: /aws::s3|aws_s3|s3::bucket/i,
  DynamoDB: /dynamo|aws::dynamodb/i,
  APIGateway: /apigateway|httpapi|aws_api_gateway|aws::apigateway/i,
  SQS: /sqs|aws::sqs/i,
  SNS: /sns|aws::sns/i,
  EventBridge: /eventbridge|aws::events|aws_cloudwatch_event/i,
  Kinesis: /kinesis|aws::kinesis/i,
  Cognito: /cognito|aws::cognito/i,
  RDS: /aws::rds|aws_db_instance|aws_rds/i,
  Aurora: /aws_rds_cluster|aurora/i,
  StepFunctions: /step.?function|aws::stepfunctions/i,
};

function iacCorroborated(serviceId: string, codeText: string): boolean {
  const re = IAC_TOKENS[serviceId];
  return re ? re.test(codeText) : true;
}

function profileHasFramework(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.frameworks.some((f) => lower.some((n) => f.name.toLowerCase().includes(n)));
}

function profileHasDatabase(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.databases.some((d) => lower.some((n) => d.name.toLowerCase().includes(n)));
}

function profileHasInfra(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.infrastructure.some((i) => lower.some((n) => i.name.toLowerCase().includes(n)));
}

function profileHasAwsUsage(profile: ProjectProfile, ...services: string[]): boolean {
  const lower = services.map((s) => s.toLowerCase());
  return profile.awsUsage.some((a) => lower.some((s) => a.name.toLowerCase().includes(s)));
}

function awsEvidence(profile: ProjectProfile | undefined, service: string): string | null {
  if (!profile) return null;
  const hit = profile.awsUsage.find((a) => a.name.toLowerCase().includes(service.toLowerCase()));
  return hit ? hit.evidence : null;
}

function dbEvidence(profile: ProjectProfile | undefined, db: string): string | null {
  if (!profile) return null;
  const hit = profile.databases.find((d) => d.name.toLowerCase().includes(db.toLowerCase()));
  return hit ? hit.evidence : null;
}

function infraEvidence(profile: ProjectProfile | undefined, name: string): string | null {
  if (!profile) return null;
  const hit = profile.infrastructure.find((i) => i.name.toLowerCase().includes(name.toLowerCase()));
  return hit ? hit.evidence : null;
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

function detectServices(
  combined: string,
  fileNames: string[],
  profile?: ProjectProfile
): DetectedService[] {
  const detected: DetectedService[] = [];
  // Bare-keyword service patterns run against non-README code text only.
  // The head (description, if any) is preserved; README sections are cut.
  combined = codeOnlyText(combined);
  const code = combined;
  const lower = code.toLowerCase();
  const fileHas = (re: RegExp) => fileNames.some((f) => re.test(f));

  const hasDocker = Boolean(
    infraEvidence(profile, "docker") ||
    infraEvidence(profile, "dockerfile") ||
    infraEvidence(profile, "docker-compose") ||
    fileHas(/Dockerfile/i) ||
    fileHas(/docker-compose/i)
  );

  const hasDbConnectionString = /(?:postgres|postgresql|mysql|mariadb):\/\/|DATABASE_URL|DB_HOST|DB_PASSWORD|POSTGRES_USER|MYSQL_DATABASE|RDS_ENDPOINT/i.test(combined);
  const hasRedisConnectionString = /(?:redis|rediss):\/\/|REDIS_URL|REDIS_HOST|REDIS_PORT|CACHE_HOST/i.test(combined);

  const add = (
    serviceId: ServiceId,
    confidence: ConfidenceTier,
    evidence: string,
    category?: MappingCategory
  ) => {
    const existing = detected.find((d) => d.serviceId === serviceId);
    if (existing) {
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
        existing.confidence = confidence;
      }
      if (category && (!existing.category || CATEGORY_RANK[category] > CATEGORY_RANK[existing.category])) {
        existing.category = category;
      }
      if (!existing.evidence.includes(evidence)) {
        existing.evidence = `${existing.evidence}; ${evidence}`.slice(0, 200);
      }
      return;
    }

    const defaultCategory: MappingCategory =
      category ?? (confidence === "high" ? "repository-evidence" : "inference");

    detected.push({
      serviceId,
      confidence,
      evidence: evidence.slice(0, 200),
      category: defaultCategory,
    });
  };

  // --- Compute ---
  const lambdaEv = awsEvidence(profile, "lambda");
  const hasLambdaHandler =
    hasAny(combined, ["aws lambda", "lambda function", "handler.js", "handler.ts", "handler.py", "aws-lambda", "lambda_function.py", "exports.handler", "lambda_handler"]) ||
    fileNames.some((f) => /(?:^|\/)(?:handler|lambda_function|lambda)\.(?:js|ts|mjs|cjs|py|go|java)$/i.test(f));
  if (lambdaEv) add("Lambda", "high", `AWS SDK Lambda client imported — ${lambdaEv}`);
  else if (hasLambdaHandler || hasAny(combined, ["aws::lambda::function", "aws::serverless::function", "aws_lambda_function"])) {
    add("Lambda", "high", "Lambda handler or function definition in repository files");
  }

  const dockerfileEv = infraEvidence(profile, "dockerfile") || infraEvidence(profile, "docker");
  if (dockerfileEv || hasDocker || hasWord(combined, ["fargate", "ecs", "ecr"])) {
    const fargateEv = awsEvidence(profile, "fargate");
    if (fargateEv || hasAny(combined, ["fargate", "aws_ecs_task_definition", "aws::ecs::taskdefinition"])) {
      add("Fargate", "high", fargateEv ? `ECS Fargate SDK usage — ${fargateEv}` : "Fargate reference in repository files");
    } else if (awsEvidence(profile, "ecs") || hasAny(combined, ["elastic container service", "aws_ecs_cluster", "aws::ecs::cluster"]) || hasWord(combined, ["ecs"])) {
      add("ECS", "high", awsEvidence(profile, "ecs") ? `ECS SDK usage — ${awsEvidence(profile, "ecs")}` : "ECS reference in repository files");
    } else if (dockerfileEv || hasDocker) {
      add("ECS", "medium", "Dockerfile/container config present → ECS as standard container host on AWS");
    }
  }

  const ec2Ev = awsEvidence(profile, "ec2");
  if (ec2Ev) add("EC2", "high", `EC2 SDK client imported — ${ec2Ev}`);
  else if (hasAny(combined, ["ec2 instance", "elastic compute cloud", "aws_instance", "aws::ec2::instance"]) || hasWord(combined, ["ami"]) || /t2\.micro|t3\.micro|t3\.small|t3\.medium/i.test(combined)) {
    add("EC2", "high", "EC2 instance reference in repository files");
  }

  const k8sEv = infraEvidence(profile, "kubernetes");
  if (k8sEv || hasAny(combined, ["kubernetes", "k8s", "kubectl", "aws_eks_cluster", "aws::eks::cluster"]) || hasWord(combined, ["eks"])) {
    add("EKS", "high", k8sEv ? `Kubernetes manifests detected — ${k8sEv}` : "EKS/Kubernetes reference in repository files");
  }

  if (hasAny(combined, ["elastic container registry", "ecr.aws", "aws_ecr_repository", "aws::ecr::repository"]) || hasWord(combined, ["ecr"])) {
    add("ECR", "high", "ECR reference detected");
  } else if ((detected.some((s) => s.serviceId === "ECS" || s.serviceId === "EKS")) && (dockerfileEv || k8sEv || infraEvidence(profile, "kubernetes") || infraEvidence(profile, "github actions") || infraEvidence(profile, "codebuild"))) {
    add("ECR", "medium", "Container deployment on AWS (ECS/EKS) → ECR for container image storage");
  }

  // --- Storage ---
  const s3Ev = awsEvidence(profile, "s3");
  if (s3Ev) add("S3", "high", `AWS S3 SDK client imported — ${s3Ev}`);
  else if (hasAny(combined, ["s3 bucket", "aws s3", "s3.amazonaws", "s3://", "aws_s3_bucket", "aws::s3::bucket"]) || hasWord(combined, ["s3"])) {
    add("S3", "high", "S3 bucket reference in repository files");
  }

  // DynamoDB
  const dynamoEv = awsEvidence(profile, "dynamodb");
  if (dynamoEv) add("DynamoDB", "high", `DynamoDB SDK client imported — ${dynamoEv}`);
  else if (hasAny(combined, ["dynamodb", "dynamo db", "aws_dynamodb_table", "aws::dynamodb::table", "aws::serverless::simpletable"])) {
    add("DynamoDB", "high", "DynamoDB reference in repository files");
  }

  // --- Database (RDS / Aurora / ElastiCache) ---
  // Engine resolution + corroboration gate: a driver string alone never earns
  // RDS without corroboration, and the evidence names the engine explicitly.
  const rdsSdkEv = awsEvidence(profile, "rds");
  const auroraEv = awsEvidence(profile, "aurora") || (
    /engine\s*=\s*["']aurora/i.test(combined) ||
    /aws_rds_cluster/i.test(combined) ||
    /rds-data|data\s*api/i.test(combined) ||
    /@aws-sdk\/client-rds/i.test(combined) ||
    /boto3\.client\(\s*["']rds["']/i.test(combined)
      ? "Aurora engine declaration or RDS Data API reference detected"
      : null
  );

  const dbEngine = detectRdsEngine(combined, profile);
  const dbCorroborated = isDbCorroborated(combined, profile, fileNames);

  if (auroraEv) {
    add("Aurora", "high", typeof auroraEv === "string" ? auroraEv : "Aurora reference in repository files");
  } else if (rdsSdkEv || hasAny(combined, ["aws::rds::dbinstance", "aws_db_instance"])) {
    add("RDS", "high", rdsSdkEv ? `RDS SDK client imported — ${rdsSdkEv}` : "Explicit RDS declaration in IaC/config");
  } else if (dbEngine !== "none" && dbCorroborated) {
    const label = dbEngine === "postgres" ? "RDS (PostgreSQL)" : "RDS (MySQL)";
    add("RDS", "medium", `${label} dependency detected — corroborated by connection/ORM/migration evidence → RDS`);
  } else if (dbEngine !== "none" && hasDocker && !hasDbConnectionString && k8sWeight(fileNames) === 0) {
    const label = dbEngine === "postgres" ? "RDS (PostgreSQL)" : "RDS (MySQL)";
    add("RDS", "low", `${label} driver seen without corroboration — suggested RDS`);
  }

  // SQL Server preserves the pre-existing RDS mapping when corroborated
  // (family ORM / connection config). The engine label stays unset.
  if (dbEngine === "none" && /sqlserver|mssql/i.test(combined) && dbCorroborated) {
    add("RDS", "medium", "Relational database (SQL Server) detected — corroborated by ORM/configuration → RDS");
  }
  // NOTE: SQLite never maps to RDS (no path allows it). MongoDB →
  // DocumentDB stays as-is in the discoveredComponents switch below.

  // ElastiCache / Redis
  const elastiCacheSdkEv = awsEvidence(profile, "elasticache");
  const redisEv = dbEvidence(profile, "redis") || (hasAny(combined, ["redis", "ioredis", "memcached", "predis"]) ? "redis keyword" : null);
  if (elastiCacheSdkEv || hasAny(combined, ["aws::elasticache::cachecluster", "aws_elasticache_cluster"])) {
    add("ElastiCache", "high", elastiCacheSdkEv ? `ElastiCache SDK imported — ${elastiCacheSdkEv}` : "Explicit ElastiCache declaration in IaC");
  } else if (redisEv) {
    const hasRedisWorkload = hasRedisConnectionString || hasAny(combined, ["sidekiq", "celery", "bull", "cache", "session"]);
    if (hasRedisWorkload) {
      add("ElastiCache", "medium", `Redis dependency detected — corroborated by caching/worker configuration → ElastiCache Redis`);
    } else if (!hasDocker) {
      add("ElastiCache", "low", "Redis reference detected without connection config — suggested ElastiCache");
    }
  }

  // --- Networking ---
  const apigwEv = awsEvidence(profile, "api gateway") || awsEvidence(profile, "apigateway");
  if (apigwEv) add("APIGateway", "high", `API Gateway SDK usage — ${apigwEv}`, "repository-evidence");
  else if (hasAny(combined, ["api gateway", "apigateway", "aws_api_gateway", "aws::apigateway::restapi", "httpapi"])) {
    add("APIGateway", "high", "API Gateway reference in repository files", "repository-evidence");
  }

  if (hasAny(combined, ["cloudfront", "aws_cloudfront_distribution", "aws::cloudfront::distribution"]) || hasWord(combined, ["cdn"])) {
    add("CloudFront", "high", "CloudFront/CDN reference in repository files");
  }

  if (hasAny(combined, ["application load balancer", "load balancer", "aws_lb", "aws::elasticloadbalancingv2::loadbalancer", "kind: ingress", "ingress.yaml", "ingress.yml"]) || hasWord(combined, ["alb", "elb"])) {
    add("ALB", "medium", "Load balancer / Ingress reference in repository files");
  } else if (profile && profileHasInfra(profile, "docker") && !hasAny(combined, ["serverless", "lambda"])) {
    add("ALB", "low", "Containerised app pattern — ALB typically fronts ECS services");
  }

  if (/route\s?53|hosted zone|aws_route53/i.test(combined)) {
    add("Route53", "medium", "Route53/DNS reference in repository files");
  }

  // --- Messaging ---
  const kafkaEv = awsEvidence(profile, "msk") || (hasAny(combined, ["kafka", "confluent", "spring-kafka"]) ? "Apache Kafka event streaming detected" : null);
  if (kafkaEv) {
    add("MSK", "high", typeof kafkaEv === "string" ? kafkaEv : "Kafka reference in repository files");
  }

  const sqsEv = awsEvidence(profile, "sqs");
  if (sqsEv) add("SQS", "high", `SQS SDK client imported — ${sqsEv}`);
  else if (hasAny(combined, ["simple queue", "aws sqs", "aws_sqs_queue", "aws::sqs::queue"]) || hasWord(combined, ["sqs"])) {
    add("SQS", "high", "SQS reference in repository files");
  } else if (profile && (profileHasFramework(profile, "celery") || profileHasFramework(profile, "bull"))) {
    const workerEv = profile.frameworks.find((f) => /celery|bull/i.test(f.name));
    if (hasDocker || hasAny(combined, ["worker", "queue"])) {
      add("SQS", "medium", `Task queue library detected (${workerEv?.evidence}) → SQS as backing queue on AWS`);
    } else {
      add("SQS", "low", `Task queue library detected (${workerEv?.evidence}) — suggested SQS`);
    }
  }

  const snsEv = awsEvidence(profile, "sns");
  if (snsEv) add("SNS", "high", `SNS SDK client imported — ${snsEv}`);
  else if (hasAny(combined, ["simple notification", "aws sns", "aws_sns_topic", "aws::sns::topic"]) || hasWord(combined, ["sns"])) {
    add("SNS", "high", "SNS reference in repository files");
  }

  const ebEv = awsEvidence(profile, "eventbridge");
  if (ebEv) add("EventBridge", "high", `EventBridge SDK client imported — ${ebEv}`);
  else if (hasAny(combined, ["eventbridge", "event bus", "aws_cloudwatch_event_rule", "aws::events::rule"])) {
    add("EventBridge", "high", "EventBridge reference in repository files");
  }

  const kinesisEv = awsEvidence(profile, "kinesis");
  if (kinesisEv) add("Kinesis", "high", `Kinesis SDK client imported — ${kinesisEv}`);
  else if (hasAny(combined, ["kinesis", "kinesis stream", "kinesis firehose", "aws_kinesis_stream", "aws::kinesis::stream"])) {
    add("Kinesis", "high", "Kinesis reference in repository files");
  }

  // --- Search ---
  const searchEv = awsEvidence(profile, "opensearch") || (hasAny(combined, ["opensearch", "elasticsearch"]) ? "OpenSearch/Elasticsearch search engine detected" : null);
  if (searchEv) {
    add("OpenSearch", "high", typeof searchEv === "string" ? searchEv : "OpenSearch reference in repository files");
  }

  // --- Auth ---
  const cognitoEv = awsEvidence(profile, "cognito");
  if (cognitoEv) add("Cognito", "high", `Cognito SDK client imported — ${cognitoEv}`);
  else if (hasAny(combined, ["cognito", "user pool", "identity pool", "aws_cognito_user_pool", "aws::cognito::userpool"])) {
    add("Cognito", "high", "Cognito reference in repository files");
  } else if (hasAny(combined, ["keycloak"])) {
    add("Cognito", "medium", "Managed service substitution: Keycloak identity provider → Amazon Cognito");
  }

  // --- ML ---
  if (profile?.workloadClassification?.type === "ml-inference") {
    add("SageMaker", "high", "Machine learning inference endpoint detected → Amazon SageMaker Endpoint");
    if (!detected.some((s) => s.serviceId === "ALB")) {
      add("ALB", "medium", "Load balancer for inference API traffic → ALB");
    }
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Model weights and serialized artifact storage → S3");
    }
  } else if (profile?.workloadClassification?.type === "ml-training" || hasAny(combined, ["tensorflow", "pytorch", "keras", "model training", "training job", "train.py"]) || hasWord(combined, ["cnn"])) {
    add("SageMaker", "high", "Machine learning model training detected → Amazon SageMaker");
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Dataset and model artifact storage → S3");
    }
  } else if (hasAny(combined, ["sagemaker", "training job", "inference endpoint", "aws_sagemaker_model"])) {
    add("SageMaker", "high", "SageMaker reference in repository files");
  }
  if (hasAny(combined, ["rekognition"])) add("Rekognition", "high", "Rekognition reference in repository files");
  if (hasAny(combined, ["comprehend"])) add("Comprehend", "high", "Comprehend reference in repository files");

  const bedrockEv = awsEvidence(profile, "bedrock");
  if (bedrockEv) add("Bedrock", "high", `AWS Bedrock client imported — ${bedrockEv}`);
  else if (hasAny(combined, ["bedrock", "aws-bedrock", "aws::bedrock", "bedrock-runtime"])) {
    add("Bedrock", "high", "Amazon Bedrock foundation model reference detected");
  }

  // --- Analytics & ETL ---
  const athenaEv = awsEvidence(profile, "athena");
  if (athenaEv) add("Athena", "high", `AWS Athena client imported — ${athenaEv}`);
  else if (/aws_athena|aws::athena|@aws-sdk\/client-athena/i.test(combined) || /boto3\.client\(\s*["']athena["']/i.test(combined)) {
    add("Athena", "high", "Amazon Athena serverless analytics query engine reference detected");
  }

  const glueEv = awsEvidence(profile, "glue");
  if (glueEv) add("Glue", "high", `AWS Glue client imported — ${glueEv}`);
  else if (hasAny(combined, ["aws glue", "glue job", "glue etl", "aws_glue", "aws::glue::job"]) || hasWord(combined, ["glue"])) {
    add("Glue", "high", "AWS Glue ETL service reference detected in repository files");
  }

  const emrEv = awsEvidence(profile, "emr");
  if (emrEv) add("EMR", "high", `AWS EMR client imported — ${emrEv}`);
  else if (hasAny(combined, ["elastic mapreduce", "aws::emr", "aws_emr_cluster", "pyspark"]) || hasWord(combined, ["emr"])) {
    add("EMR", "high", "Amazon EMR cluster reference detected in repository files");
  }

  // --- Step Functions ---
  const sfnEv = awsEvidence(profile, "stepfunctions") || awsEvidence(profile, "states");
  if (sfnEv) add("StepFunctions", "high", `AWS Step Functions client imported — ${sfnEv}`);
  else if (hasAny(combined, ["step functions", "stepfunctions", "aws-stepfunctions", "aws::stepfunctions", "states:::"])) {
    add("StepFunctions", "high", "AWS Step Functions state machine workflow reference detected");
  } else if (/parallelresult|startexecution|sendtasksuccess|statemachine/i.test(combined)) {
    add("StepFunctions", "medium", "Step Functions execution pattern in code (Parallel result / state machine API)");
  }

  // --- Security & Encryption ---
  const kmsEv = awsEvidence(profile, "kms");
  if (kmsEv) add("KMS", "high", `AWS KMS client imported — ${kmsEv}`);
  else if (hasAny(combined, ["aws-kms", "aws_kms_key", "aws::kms::key", "kms:encrypt", "kms:decrypt"]) || hasWord(combined, ["kms"])) {
    add("KMS", "high", "AWS Key Management Service (KMS) reference detected");
  }

  // --- App Runner ---
  const apprunnerEv = awsEvidence(profile, "apprunner");
  if (apprunnerEv) add("AppRunner", "high", `AWS App Runner client imported — ${apprunnerEv}`);
  else if (hasAny(combined, ["app runner", "apprunner", "aws_apprunner", "aws::apprunner"])) {
    add("AppRunner", "high", "AWS App Runner container service reference detected");
  }

  // --- Static site / frontend hosting ---
  const isStaticSite =
    hasAny(combined, ["static site", "static website", "gatsby", "hugo", "jekyll", "astro"]) ||
    fileHas(/vercel\.json|netlify\.toml|amplify\.yml/i) ||
    (hasAny(combined, ["vite", "static"]) && !hasAny(combined, ["express", "fastify", "koa", "nestjs", "django", "flask", "spring", "docker", "serverless"]));

  if (isStaticSite) {
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Static site generator or hosting config present → S3 for static hosting");
    }
    if (!detected.some((s) => s.serviceId === "CloudFront")) {
      add("CloudFront", "medium", "Static site generator or hosting config present → CloudFront CDN in front of S3");
    }
    if (!detected.some((s) => s.serviceId === "Route53")) {
      add("Route53", "medium", "DNS routing for custom domain → Route 53");
    }
  }

  // --- Serverless Framework / SAM files ---
  const hasServerlessFile = fileHas(/serverless\.(yml|yaml)/i) || fileHas(/(template|sam)\.(yml|yaml)/i);
  if (hasServerlessFile) {
    if (!detected.some((s) => s.serviceId === "Lambda")) {
      add("Lambda", "high", "Serverless framework / SAM template in repository files");
    }
    if (!detected.some((s) => s.serviceId === "APIGateway")) {
      add("APIGateway", "high", "Serverless API entry point");
    }
  }

  // --- Discovered components from repoAnalyzer (structural evidence) ---
  if (profile?.discoveredComponents?.length) {
    for (const dc of profile.discoveredComponents) {
      const dcEv = `${dc.source}: ${dc.evidence[0] ?? dc.name} (${dc.confidence} confidence)`;
      switch (dc.type) {
        case "database": {
          const tech = dc.technology.toLowerCase();
          if (/dynamo/.test(tech)) { if (!detected.some((s) => s.serviceId === "DynamoDB")) add("DynamoDB", dc.confidence, dcEv); }
          else if (/mongo/.test(tech)) { if (!detected.some((s) => s.serviceId === "DocumentDB")) add("DocumentDB", dc.confidence, dcEv); }
          else if (/aurora/.test(tech)) { if (!detected.some((s) => s.serviceId === "Aurora")) add("Aurora", dc.confidence, dcEv); }
          else if (/athena/.test(tech)) { if (!detected.some((s) => s.serviceId === "Athena")) add("Athena", dc.confidence, dcEv); }
          else { if (!detected.some((s) => s.serviceId === "RDS" || s.serviceId === "Aurora")) add("RDS", dc.confidence, dcEv); }
          break;
        }
        case "cache": { if (!detected.some((s) => s.serviceId === "ElastiCache")) add("ElastiCache", dc.confidence, dcEv); break; }
        case "queue": {
          const tech = dc.technology.toLowerCase();
          if (/kafka|confluent/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "MSK")) add("MSK", dc.confidence, dcEv);
          } else {
            if (!detected.some((s) => s.serviceId === "SQS")) add("SQS", dc.confidence, dcEv);
          }
          break;
        }
        case "messaging": {
          const tech = dc.technology.toLowerCase();
          if (/kafka|confluent/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "MSK")) add("MSK", dc.confidence, dcEv);
          } else if (/kinesis/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "Kinesis")) add("Kinesis", dc.confidence, dcEv);
          } else if (/sns/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "SNS")) add("SNS", dc.confidence, dcEv);
          } else if (/step.?function/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "StepFunctions")) add("StepFunctions", dc.confidence, dcEv);
          } else {
            if (!detected.some((s) => s.serviceId === "SQS")) add("SQS", dc.confidence, dcEv);
          }
          break;
        }
        case "search": {
          if (!detected.some((s) => s.serviceId === "OpenSearch")) add("OpenSearch", dc.confidence, dcEv);
          break;
        }
        case "api": {
          if (dc.source === "serverless-yml" && !detected.some((s) => s.serviceId === "Lambda")) {
            add("Lambda", dc.confidence, dcEv, "deployment-requirement");
          }
          if (dc.source === "serverless-yml" || /serverless|lambda/.test(dc.technology.toLowerCase())) {
            if (!detected.some((s) => s.serviceId === "APIGateway")) {
              add("APIGateway", dc.confidence, `${dcEv} → Serverless HTTP entry`, "deployment-requirement");
            }
          } else if (/apigateway|api gateway|httpapi|aws_api_gateway/.test(dc.technology.toLowerCase())) {
            if (!detected.some((s) => s.serviceId === "APIGateway")) {
              add("APIGateway", dc.confidence, dcEv, "repository-evidence");
            }
          } else {
            // Framework or generic API alone does not prove APIGateway. Recommend ALB for ingress.
            if (!detected.some((s) => s.serviceId === "ALB")) {
              add("ALB", "medium", `${dcEv} → Ingress load balancer recommendation`, "recommendation");
            }
            if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Lambda")) {
              add("ECS", "low", `${dcEv} → possible container host, no container evidence`, "inference");
            }
          }
          break;
        }
        case "backend": {
          const tech = dc.technology.toLowerCase();
          if (/bedrock/.test(tech)) { if (!detected.some((s) => s.serviceId === "Bedrock")) add("Bedrock", dc.confidence, dcEv); }
          else if (/app.?runner/.test(tech)) { if (!detected.some((s) => s.serviceId === "AppRunner")) add("AppRunner", dc.confidence, dcEv); }
          break;
        }
        case "worker": {
          const tech = dc.technology.toLowerCase();
          if (dc.source === "serverless-yml") { if (!detected.some((s) => s.serviceId === "Lambda")) add("Lambda", dc.confidence, dcEv); }
          else if (/glue/.test(tech)) { if (!detected.some((s) => s.serviceId === "Glue")) add("Glue", dc.confidence, dcEv); }
          else if (/emr|spark/.test(tech)) { if (!detected.some((s) => s.serviceId === "EMR")) add("EMR", dc.confidence, dcEv); }
          else if (/step.?function/.test(tech)) { if (!detected.some((s) => s.serviceId === "StepFunctions")) add("StepFunctions", dc.confidence, dcEv); }
          else if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Fargate") && !detected.some((s) => s.serviceId === "Lambda")) {
            add("ECS", dc.confidence, dcEv);
          }
          break;
        }
        case "scheduler": {
          if (dc.source === "serverless-yml") { if (!detected.some((s) => s.serviceId === "Lambda")) add("Lambda", dc.confidence, dcEv); }
          else if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Fargate") && !detected.some((s) => s.serviceId === "Lambda")) {
            add("ECS", dc.confidence, dcEv);
          }
          if (!detected.some((s) => s.serviceId === "EventBridge")) add("EventBridge", dc.confidence, dcEv);
          break;
        }
        case "storage": { if (!detected.some((s) => s.serviceId === "S3")) add("S3", dc.confidence, dcEv); break; }
        case "auth": {
          const tech = dc.technology.toLowerCase();
          if (/kms/.test(tech)) { if (!detected.some((s) => s.serviceId === "KMS")) add("KMS", dc.confidence, dcEv); }
          else { if (!detected.some((s) => s.serviceId === "Cognito")) add("Cognito", dc.confidence, dcEv); }
          break;
        }
        case "frontend": { if (!detected.some((s) => s.serviceId === "CloudFront")) add("CloudFront", "medium", `${dcEv} → CloudFront CDN`, "deployment-requirement"); break; }
      }
    }
  }

  // --- Terraform resource promotion ---
  // `.tf` resource blocks are ground truth: promote each declared service at
  // high confidence, and gate weak keyword-based ECS/EKS guesses off when real
  // resources were found.
  const tfDeclared = new Set<ServiceId>();
  if (profile?.infrastructure) {
    for (const infra of profile.infrastructure) {
      const m = infra.name.match(/^Terraform resource \(([A-Za-z0-9]+)\)$/);
      if (!m) continue;
      const svc = m[1] as ServiceId;
      if (!(SERVICE_IDS as readonly string[]).includes(svc)) continue;
      tfDeclared.add(svc);
      const existing = detected.find((d) => d.serviceId === svc);
      if (!existing) {
        detected.push({
          serviceId: svc,
          confidence: "high",
          evidence: infra.evidence.slice(0, 200),
          category: "repository-evidence",
        });
      } else if (!/\.tf\b/i.test(existing.evidence)) {
        // Prefer ground-truth .tf evidence over an earlier keyword guess.
        existing.evidence = infra.evidence.slice(0, 200);
        existing.confidence = "high";
        existing.category = "repository-evidence";
      }
    }
  }
  if (tfDeclared.size > 0) {
    for (let i = detected.length - 1; i >= 0; i--) {
      const d = detected[i];
      if (
        d.serviceId === "ECS" &&
        /Dockerfile\/container config present → ECS as standard container host/i.test(d.evidence)
      ) {
        detected.splice(i, 1);
      } else if (
        d.serviceId === "EKS" &&
        d.evidence === "EKS/Kubernetes reference in repository files" &&
        !tfDeclared.has("EKS")
      ) {
        detected.splice(i, 1);
      }
    }
    // IaC-only repos: suppress application-tier services not declared as
    // .tf resources (their evidence never references a .tf file). Ingress
    // (ALB/APIGateway) from bare "elb"/"api" words in tags is noise here too.
    if (profile?.isIacOnly) {
      const appTier: ServiceId[] = ["RDS", "S3", "ElastiCache", "Lambda", "ECS", "ALB", "APIGateway"];
      for (let i = detected.length - 1; i >= 0; i--) {
        const d = detected[i];
        if (appTier.includes(d.serviceId) && !/\.tf\b/i.test(d.evidence)) {
          detected.splice(i, 1);
        }
      }
    }
  }

  // --- IaC-primary repos: SDK-grep matches need resource-block corroboration ---
  // When template.yaml/sam.yaml/serverless.yml/cdk.json/*.tf exist, their
  // Resources/functions blocks rule. Raw SDK-grep matches without an IaC
  // resource token for that service are dropped from the primary plan.
  if (hasPrimaryIacTemplates(fileNames)) {
    for (let i = detected.length - 1; i >= 0; i--) {
      const d = detected[i];
      const sdkOnly = /SDK (client imported|usage)/i.test(d.evidence);
      if (sdkOnly && !iacCorroborated(d.serviceId, code)) {
        detected.splice(i, 1);
      }
    }
  }

  // --- Default web/backend archetype for source-only repos ---
  // A backend framework with no compute detected implies a containerised web
  // service on AWS. Runs before exclusivity resolves so ECS enters the
  // candidate set normally.
  if (
    profileHasBackendFramework(profile) &&
    !detected.some((s) =>
      (COMPUTE_HIERARCHY as string[]).includes(s.serviceId)
    )
  ) {
    add("ECS", "medium", "Backend web framework with no container config → ECS as default host", "inference");
    if (!detected.some((s) => s.serviceId === "ALB")) {
      add("ALB", "medium", "Backend web framework ingress → ALB", "recommendation");
    }
  }

  // --- Static-hosting archetype for frontend-only repos ---
  // A frontend-only framework with no backend framework, no database, and no
  // compute implies static hosting. A frontend/client subdirectory package.json
  // is sufficient corroboration even when a sibling backend exists elsewhere.
  if (
    profileHasFrontendOnlyFramework(profile) &&
    !profileHasBackendFramework(profile) &&
    !profileHasAnyDatabase(profile) &&
    !detected.some((s) => (COMPUTE_HIERARCHY as string[]).includes(s.serviceId))
  ) {
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Frontend-only framework with no backend → S3 static hosting", "inference");
    }
    if (!detected.some((s) => s.serviceId === "CloudFront")) {
      add("CloudFront", "medium", "Frontend-only framework with no backend → CloudFront CDN", "recommendation");
    }
  }

  // Blockchain dapps deploy as static frontends: chain tooling means no
  // managed backends. (No ManagedBlockchain service exists in the catalog.)
  if (/solidity|hardhat|foundry|ethers\.js|web3\.js|truffle/i.test(combined)) {
    const banned: ServiceId[] = [
      "ECS", "EKS", "Fargate", "Lambda", "EC2", "ALB", "APIGateway",
      "RDS", "Aurora", "DynamoDB", "DocumentDB", "ElastiCache", "Neptune",
      "CloudWatch",
    ];
    for (let i = detected.length - 1; i >= 0; i--) {
      if (
        banned.includes(detected[i].serviceId) ||
        (detected[i].serviceId as string) === "ManagedBlockchain"
      ) {
        detected.splice(i, 1);
      }
    }
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Blockchain dapp frontend → S3 static hosting", "inference");
    }
    if (!detected.some((s) => s.serviceId === "CloudFront")) {
      add("CloudFront", "medium", "Blockchain dapp frontend → CloudFront CDN", "recommendation");
    }
  }

  // --- Observability (gated behind active compute) ---
  // IaC-only repos earn CloudWatch only from an actual log-group declaration.
  const COMPUTE_SERVICES: ServiceId[] = ["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "SageMaker"];
  const hasActiveCompute = detected.some((s) => COMPUTE_SERVICES.includes(s.serviceId));
  const iacCloudWatchOk =
    !profile?.isIacOnly ||
    /aws_cloudwatch_log_group|enabled_cluster_log_types/i.test(combined) ||
    tfDeclared.has("CloudWatch");
  if (hasActiveCompute && iacCloudWatchOk && !detected.some((s) => s.serviceId === "CloudWatch")) {
    add("CloudWatch", "medium", "CloudWatch monitoring for active compute services", "recommendation");
  }

  // --- Compute exclusivity (exactly one compute service wins) ---
  // IaC-declared services (Fix 7 promotion) are protected: co-declared pairs
  // such as EKS + EC2 node groups survive together.
  resolveComputeExclusivity(detected, fileNames, tfDeclared);

  // --- Negative "Do Not Infer" rules (run last, immediately before return) ---
  applyNegativeRules(detected, { combined: code, fileNames, profile });

  return detected;
}

// ---------------------------------------------------------------------------
// Pattern classifier
// ---------------------------------------------------------------------------

export function classifyPattern(services: DetectedService[]): PatternId {
  if (!services || services.length === 0) return "generic";

  const has = (id: ServiceId) => services.some((s) => s.serviceId === id);
  const hasAnyId = (ids: ServiceId[]) => services.some((s) => ids.includes(s.serviceId));
  const hasEvidence = (re: RegExp) => services.some((s) => re.test(s.evidence));

  // 1. ML Pipeline (highest specificity — SageMaker, Rekognition, Comprehend)
  if (hasAnyId(["SageMaker", "Rekognition", "Comprehend"]) || hasEvidence(/sagemaker|machine learning|ml model/i)) {
    return "ml-pipeline";
  }

  // 2. Data Pipeline (ETL / Warehouse / Kinesis + S3)
  if (
    has("Redshift") ||
    (has("Kinesis") && has("S3")) ||
    hasEvidence(/data pipeline|etl|data warehouse|glue|athena/i)
  ) {
    return "data-pipeline";
  }

  // 3. Containerised App (ECS, Fargate, EKS, ECR)
  const hasContainers = hasAnyId(["ECS", "Fargate", "EKS", "ECR"]) || hasEvidence(/docker|container|fargate|ecs|eks/i);
  if (hasContainers) {
    return "containerised-app";
  }

  // 4. Serverless API (SAM / serverless.yml / Lambda without container orchestrators)
  if (has("Lambda") || hasEvidence(/serverless|sam|template\.yaml|aws-lambda/i)) {
    return "serverless-api";
  }

  // 5. Event-Driven (Messaging / Queues without compute)
  if (hasAnyId(["SQS", "SNS", "EventBridge", "Kinesis"])) {
    return "event-driven";
  }

  // 6. Full-Stack Web (Compute + Relational Database)
  if ((has("EC2") || has("ALB")) && (has("RDS") || has("Aurora"))) {
    return "full-stack-web";
  }

  // 6. Static Site (S3 + CloudFront / CDN without compute or databases)
  const hasCompute = hasAnyId(["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "SageMaker"]);
  const hasDatabase = hasAnyId(["RDS", "Aurora", "DynamoDB", "Redshift", "DocumentDB"]);
  const hasMessaging = hasAnyId(["SQS", "SNS", "EventBridge", "Kinesis"]);

  if (!hasCompute && !hasDatabase && !hasMessaging) {
    if ((has("S3") && has("CloudFront")) || hasEvidence(/static site|static asset|s3 for hosting|cloudfront cdn/i)) {
      return "static-site";
    }
  }

  return "generic";
}

// ---------------------------------------------------------------------------
// Build ServicePlan from detected services (no pattern constraints)
// ---------------------------------------------------------------------------

export function buildServicePlan(
  input: RuleInput,
  services: DetectedService[]
): ServicePlan {
  // Retain all detected services (hard 12-cap removed; soft ceiling handled by schema warnings)
  const planServices = services;

  // Convert detected services to DiscoveredComponent format
  const components: DiscoveredComponent[] = planServices.map((s) => ({
    id: `svc-${s.serviceId.toLowerCase()}`,
    type: serviceTypeFromId(s.serviceId),
    technology: s.serviceId,
    evidence: [s.evidence],
    confidence: s.confidence,
    status: s.confidence === "high" ? "detected" : "inferred",
  }));

  // Build basic relationships (compute → database, compute → cache, etc.)
  const relationships: ComponentRelationship[] = buildBasicRelationships(components);

  // Build deployment model (inferred)
  const deploymentModel: DeploymentModel[] = components.map((c) => {
    const isCompute = ["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "AppRunner", "ElasticBeanstalk"].includes(c.technology);
    const isDatabase = c.type === "database";
    const isCache = c.type === "cache";

    return {
      componentId: c.id,
      public: c.type === "frontend" || c.type === "api",
      needsVpc: isCompute || isDatabase || isCache,
      needsMultiAz: isDatabase || isCache,
      needsAutoscaling: isCompute && ["ECS", "EC2", "EKS", "AppRunner"].includes(c.technology),
      source: "recommended" as const,
      notes: isDatabase ? "Production DB → recommend Multi-AZ" : undefined,
    };
  });

  // Build AWS mappings (1:1 with components)
  const rawAwsMappings: AwsServiceMapping[] = planServices.map((s) => ({
    componentId: `svc-${s.serviceId.toLowerCase()}`,
    serviceId: s.serviceId,
    confidence: s.confidence,
    evidence: s.evidence,
    fromPattern: false,
    category: s.category ?? (s.confidence === "high" ? "repository-evidence" : "inference"),
  }));
  const awsMappings = deduplicateAwsMappings(rawAwsMappings);

  const dbEngine = detectRdsEngine(
    [input.description, input.fileContent].join("\n"),
    input.profile
  );

  // --- Terminal state: distinguish "correctly minimal" from "parse failure" ---
  const noCompute = !planServices.some((s) =>
    (COMPUTE_HIERARCHY as string[]).includes(s.serviceId)
  );
  const hasAppFramework =
    profileHasBackendFramework(input.profile) ||
    profileHasFrontendOnlyFramework(input.profile);
  let terminalState: "OK" | "INSUFFICIENT_SIGNAL" | "LIBRARY_REPO" | "IAC_ONLY" | "MONOREPO_OK" = "OK";
  if (input.profile?.isIacOnly) {
    terminalState = "IAC_ONLY";
  } else if (input.profile?.isLibraryOrFramework) {
    terminalState = "LIBRARY_REPO";
  } else if (planServices.length === 0 || (noCompute && !hasAppFramework)) {
    const infraCount = input.profile?.infrastructure.length ?? 0;
    const fwCount = input.profile?.frameworks.length ?? 0;
    terminalState = infraCount > 0 && fwCount === 0 ? "IAC_ONLY" : "LIBRARY_REPO";
  } else {
    const backendCount = components.filter((c) =>
      ["backend", "api"].includes(c.type)
    ).length;
    const topDirs = new Set(
      input.fileNames.filter((f) => f.includes("/")).map((f) => f.split("/")[0])
    );
    const hasWorkspaceRoot = input.fileNames.some((f) => isWorkspaceRootPath(f));
    if (backendCount >= 2 && topDirs.size >= 2 && hasWorkspaceRoot) {
      terminalState = "MONOREPO_OK";
    }
  }

  const plan = {
    inputKind: input.inputKind,
    components,
    relationships,
    deploymentModel,
    awsMappings,
    detectedPattern: classifyPattern(services),
    terminalState,
    metadata: {
      grounding: input.grounding,
      truncated: input.truncated,
      parseErrors: input.parseErrors,
      dbEngine,
    },
    warnings: [],
  };

  const check = ServicePlanSchema.safeParse(plan);
  if (!check.success) {
    console.warn("[ruleEngine] plan failed validation:", check.error.issues.map((i) => i.message).join("; "));
    const floor: ServicePlan = {
      inputKind: input.inputKind,
      components: [{ id: "fallback", type: "object-storage", technology: "S3", evidence: [], confidence: "low", status: "inferred" }],
      relationships: [],
      deploymentModel: [],
      awsMappings: [{ componentId: "fallback", serviceId: "S3", confidence: "low", evidence: "fallback", fromPattern: false }],
      detectedPattern: "generic",
      terminalState: "LIBRARY_REPO",
      metadata: { grounding: input.grounding, truncated: input.truncated, parseErrors: [...input.parseErrors, "rule-engine-validation-failed"] },
      warnings: ["Rule engine output failed validation — showing minimal S3 placeholder, not an inference."],
    };
    return floor;
  }

  return check.data;
}

const buildPlan = buildServicePlan;

export function serviceTypeFromId(serviceId: ServiceId): DiscoveredComponent["type"] {
  const map: Partial<Record<ServiceId, DiscoveredComponent["type"]>> = {
    EC2: "backend", Lambda: "backend", ECS: "backend", EKS: "backend", Fargate: "backend", Lightsail: "backend", Batch: "worker",
    AppRunner: "backend", ElasticBeanstalk: "backend", Outposts: "backend", Wavelength: "backend", LocalZones: "backend",
    ServerlessApplicationRepository: "backend", EC2ImageBuilder: "worker", SimSpaceWeaver: "backend",
    S3: "object-storage", EBS: "object-storage", EFS: "object-storage", Glacier: "object-storage", FSx: "object-storage",
    StorageGateway: "object-storage", Backup: "object-storage", Snowball: "object-storage", Snowcone: "object-storage",
    S3GlacierDeepArchive: "object-storage",
    RDS: "database", DynamoDB: "database", ElastiCache: "cache", Aurora: "database", Redshift: "database", DocumentDB: "database",
    Neptune: "database", Keyspaces: "database", Timestream: "database", MemoryDB: "cache", QLDB: "database",
    CloudFront: "frontend", APIGateway: "api", ALB: "api", NLB: "api", GLB: "api", Route53: "api", VPC: "proxy", NATGateway: "proxy",
    DirectConnect: "proxy", TransitGateway: "proxy", GlobalAccelerator: "proxy", PrivateLink: "proxy", AppMesh: "proxy",
    CloudMap: "proxy", VPCEndpoints: "proxy", SiteToSiteVPN: "proxy", ClientVPN: "proxy",
    SQS: "queue", SNS: "messaging", EventBridge: "messaging", Kinesis: "messaging", KinesisDataFirehose: "messaging",
    KinesisDataStreams: "messaging", KinesisDataAnalytics: "messaging", MSK: "messaging", MQ: "messaging", AppSync: "api",
    StepFunctions: "worker", ManagedAirflow: "worker", EventBridgePipes: "messaging", EventBridgeScheduler: "scheduler",
    Cognito: "auth", SecretsManager: "auth", WAF: "proxy", Shield: "proxy", IAM: "auth", KMS: "auth", GuardDuty: "proxy",
    Inspector: "proxy", Macie: "proxy", SecurityHub: "proxy", CertificateManager: "proxy", DirectoryService: "auth",
    IAMIdentityCenter: "auth", NetworkFirewall: "proxy", Artifact: "proxy", AuditManager: "proxy", Detective: "proxy",
    CloudHSM: "auth", SystemsManager: "proxy", ParameterStore: "auth",
    CloudWatch: "proxy", CloudWatchLogs: "proxy", CloudWatchSynthetics: "proxy", CloudWatchEvidently: "proxy",
    CloudWatchRUM: "proxy", CloudTrail: "proxy", XRay: "proxy", Config: "proxy", ServiceCatalog: "proxy",
    ComputeOptimizer: "proxy", TrustedAdvisor: "proxy", HealthDashboard: "proxy", Organizations: "proxy",
    ControlTower: "proxy", LicenseManager: "proxy", WellArchitectedTool: "proxy",
    CodePipeline: "proxy", CodeBuild: "worker", CodeDeploy: "worker", CodeCommit: "proxy", CodeArtifact: "proxy",
    CodeCatalyst: "proxy", CloudFormation: "proxy", CDK: "proxy", ECR: "proxy", Cloud9: "backend",
    FaultInjectionSimulator: "proxy",
    SageMaker: "backend", Rekognition: "backend", Comprehend: "backend", Transcribe: "backend", Translate: "backend",
    Polly: "backend", Textract: "backend", Kendra: "search", Lex: "backend", Personalize: "backend", Forecast: "backend",
    Bedrock: "backend", Q: "backend", CodeWhisperer: "backend",
    OpenSearch: "search", EMR: "worker", Athena: "database", Glue: "worker", QuickSight: "frontend",
    LakeFormation: "database", DataPipeline: "worker", CleanRooms: "database", MSKConnect: "messaging",
    SES: "messaging", Amplify: "frontend", AppFlow: "proxy", DeviceFarm: "worker", LocationService: "proxy",
    Pinpoint: "messaging", Connect: "backend", WorkSpaces: "backend", AppStream: "backend",
    DMS: "worker", DataSync: "worker", TransferFamily: "proxy", ApplicationDiscoveryService: "proxy", MigrationHub: "proxy",
    IoTCore: "messaging", Greengrass: "backend", IoTEvents: "messaging", IoTAnalytics: "messaging",
  };
  return map[serviceId] ?? "external-service";
}

function buildBasicRelationships(components: DiscoveredComponent[]): ComponentRelationship[] {
  const relationships: ComponentRelationship[] = [];
  const computeComponents = components.filter((c) => ["backend", "worker", "scheduler", "api"].includes(c.type));
  const dbComponents = components.filter((c) => c.type === "database");
  const cacheComponents = components.filter((c) => c.type === "cache");
  const queueComponents = components.filter((c) => c.type === "queue" || c.type === "messaging");
  const storageComponents = components.filter((c) => c.type === "object-storage");

  for (const compute of computeComponents) {
    for (const db of dbComponents) {
      relationships.push({ from: compute.id, to: db.id, type: "reads/writes", evidence: "compute → database" });
    }
    for (const cache of cacheComponents) {
      relationships.push({ from: compute.id, to: cache.id, type: "reads/writes", evidence: "compute → cache" });
    }
    for (const queue of queueComponents) {
      relationships.push({ from: compute.id, to: queue.id, type: "sends/receives", evidence: "compute → queue" });
    }
    for (const storage of storageComponents) {
      relationships.push({ from: compute.id, to: storage.id, type: "reads/writes", evidence: "compute → storage" });
    }
  }

  // Worker → queue
  for (const worker of components.filter((c) => c.type === "worker")) {
    for (const queue of queueComponents) {
      relationships.push({ from: worker.id, to: queue.id, type: "consumes", evidence: "worker → queue" });
    }
  }

  // Scheduler → compute
  for (const scheduler of components.filter((c) => c.type === "scheduler")) {
    for (const compute of computeComponents) {
      relationships.push({ from: scheduler.id, to: compute.id, type: "triggers", evidence: "scheduler → compute" });
    }
  }

  // Frontend → API
  for (const frontend of components.filter((c) => c.type === "frontend")) {
    for (const api of components.filter((c) => c.type === "api" || c.type === "backend")) {
      relationships.push({ from: frontend.id, to: api.id, type: "calls", evidence: "frontend → API" });
    }
  }

  return relationships.slice(0, 50);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export function runRuleEngine(
  input: RuleInput,
  options: { returnArray: true }
): ServicePlan[];
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: false }
): ServicePlan;
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: boolean }
): ServicePlan | ServicePlan[];
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: boolean }
): ServicePlan | ServicePlan[] {
  const combined = [input.description, input.fileContent].join("\n");
  const services = detectServices(combined, input.fileNames, input.profile);
  const primaryPlan = buildPlan(input, services);

  // Check for curated alternate architecture pair
  const alternatePlan = buildAlternateProposal(primaryPlan, input);
  if (alternatePlan) {
    const p1 = { ...primaryPlan };
    delete p1.proposals;
    const p2 = { ...alternatePlan };
    delete p2.proposals;
    primaryPlan.proposals = [p1, p2];
    alternatePlan.proposals = [p1, p2];
  } else {
    const p1 = { ...primaryPlan };
    delete p1.proposals;
    primaryPlan.proposals = [p1];
  }

  if (options?.returnArray) {
    return primaryPlan.proposals;
  }

  return primaryPlan;
}

/**
 * Convenience helper returning all available proposals (1 or 2) as an array.
 */
export function runRuleEngineProposals(input: RuleInput): ServicePlan[] {
  const res = runRuleEngine(input, { returnArray: true });
  return Array.isArray(res) ? res : [res];
}