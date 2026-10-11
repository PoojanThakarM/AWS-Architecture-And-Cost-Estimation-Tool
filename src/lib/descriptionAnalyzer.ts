/**
 * descriptionAnalyzer.ts — deterministic evidence extraction for freeform
 * project descriptions.
 *
 * Why this exists: the rules engine reads technologies from a ProjectProfile,
 * which previously only existed for GitHub input. With no LLM key configured
 * (the zero-configuration default), a description such as
 *   "A React frontend with a Node.js Express backend connected to PostgreSQL"
 * produced ZERO services, because nothing translated the words into the
 * profile the rules consume.
 *
 * Contract:
 *  - Pure function, no network, no LLM.
 *  - Only technologies the user actually NAMED are recorded. Each one cites the
 *    exact phrase it came from ("description: 'connected to PostgreSQL'").
 *  - Generic words ("app", "data", "users", "login") never become services.
 *    Vague requirements are reported in `unresolved` so the UI can ask for
 *    them instead of the engine guessing.
 *  - Explicit AWS service names ("Lambda", "DynamoDB", "S3 bucket") are NOT
 *    handled here: the rules engine already matches them in the description
 *    text, and duplicating them would double-count.
 *
 * The resulting profile carries `origin: "description"`, so downstream code
 * can keep confidence capped at "low" (Decision 19) and skip repo-only rules.
 */

import type {
  DetectedTech,
  DiscoveredComponent,
  DiscoveredComponentType,
  ProjectProfile,
} from "./repoAnalyzer.ts";

interface TechRule {
  /** Case-insensitive pattern; must match a whole word/phrase. */
  re: RegExp;
  name: string;
}

// Frameworks whose names the rule engine already recognises (labels match
// repoAnalyzer's manifest tables so the same downstream rules fire).
const FRONTEND_FRAMEWORKS: TechRule[] = [
  { re: /\breact(?:\.?js)?\b(?!\s*native)/i, name: "React" },
  { re: /\bvue(?:\.?js)?\b/i, name: "Vue.js" },
  { re: /\bangular\b/i, name: "Angular" },
  { re: /\bsvelte\b(?!\s*kit)/i, name: "Svelte" },
  { re: /\bgatsby\b/i, name: "Gatsby" },
  { re: /\bhugo\b/i, name: "Hugo" },
  { re: /\bjekyll\b/i, name: "Jekyll" },
  { re: /\bastro\b/i, name: "Astro" },
];

/** Meta-frameworks that run a server unless told to export static files. */
const SSR_FRAMEWORKS: TechRule[] = [
  { re: /\bnext(?:\.js|js|\s+js)\b/i, name: "Next.js" },
  { re: /\bnuxt(?:\.js|js)?\b/i, name: "Nuxt.js" },
  { re: /\bremix\b/i, name: "Remix" },
  { re: /\bsvelte\s*kit\b/i, name: "SvelteKit" },
];

const BACKEND_FRAMEWORKS: TechRule[] = [
  { re: /\bexpress(?:\.js|js)?\b/i, name: "Express.js" },
  { re: /\bfastify\b/i, name: "Fastify" },
  { re: /\bnest(?:\.js|js)\b/i, name: "NestJS" },
  { re: /\bkoa\b/i, name: "Koa" },
  { re: /\bdjango\b/i, name: "Django" },
  { re: /\bflask\b/i, name: "Flask" },
  { re: /\bfast\s?api\b/i, name: "FastAPI" },
  { re: /\bspring\s*boot\b|\bspring\s+(?:mvc|webflux)\b/i, name: "Spring Boot" },
  { re: /\b(?:ruby on )?rails\b/i, name: "Ruby on Rails" },
  { re: /\blaravel\b/i, name: "Laravel" },
  { re: /\bgin\s+(?:framework|api|server|backend)\b|\bgo(?:lang)?\s+gin\b/i, name: "Gin" },
  { re: /\basp\.?net\b/i, name: "ASP.NET Core" },
];

interface DataRule extends TechRule {
  type: DiscoveredComponentType;
}

const DATA_STORES: DataRule[] = [
  { re: /\bpostgres(?:ql)?\b/i, name: "PostgreSQL", type: "database" },
  { re: /\bmysql\b/i, name: "MySQL", type: "database" },
  { re: /\bmariadb\b/i, name: "MariaDB", type: "database" },
  { re: /\bmongo(?:db)?\b|\bmongoose\b/i, name: "MongoDB", type: "database" },
  { re: /\bsql\s?server\b|\bmssql\b/i, name: "SQL Server", type: "database" },
  { re: /\bsqlite\b/i, name: "SQLite", type: "database" },
  { re: /\bredis\b|\bvalkey\b/i, name: "Redis", type: "cache" },
  { re: /\bmemcached\b/i, name: "Memcached", type: "cache" },
  { re: /\belastic\s?search\b|\bopen\s?search\b/i, name: "OpenSearch", type: "search" },
  { re: /\bkafka\b/i, name: "Kafka", type: "messaging" },
  { re: /\brabbit\s?mq\b/i, name: "RabbitMQ", type: "queue" },
];

/** Things that are not AWS-hosted: recorded, never mapped to a service. */
const EXTERNAL_SERVICES: TechRule[] = [
  { re: /\bstripe\b/i, name: "Stripe (payments)" },
  { re: /\brazorpay\b/i, name: "Razorpay (payments)" },
  { re: /\bpaypal\b/i, name: "PayPal (payments)" },
  { re: /\bfirebase\b|\bfirestore\b/i, name: "Firebase (Google)" },
  { re: /\bsupabase\b/i, name: "Supabase" },
  { re: /\bauth0\b/i, name: "Auth0" },
  { re: /\bsendgrid\b|\bmailgun\b/i, name: "Email provider" },
  { re: /\bopenai\b|\bchatgpt\b|\bgpt-?\d/i, name: "OpenAI API" },
];

/** Returns the sentence-sized snippet around a match, for evidence citation. */
function citation(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf(" ", Math.max(0, index - 24)) + 1);
  const endSpace = text.indexOf(" ", Math.min(text.length, index + length + 24));
  const end = endSpace === -1 ? text.length : endSpace;
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `description: '${snippet.slice(0, 120)}'`;
}

function findAll<T extends TechRule>(text: string, rules: T[]): Array<T & { evidence: string }> {
  const out: Array<T & { evidence: string }> = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m && !seen.has(rule.name)) {
      seen.add(rule.name);
      out.push({ ...rule, evidence: citation(text, m.index, m[0].length) });
    }
  }
  return out;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? citation(text, m.index, m[0].length) : null;
}

/**
 * Builds a ProjectProfile from a freeform description. Never throws.
 * `unresolved` lists requirement areas the description left open.
 */
export function analyzeDescription(description: string): ProjectProfile & { unresolved: string[] } {
  // Bounded input: the route already caps at 100k chars; regex work stays linear.
  const text = description.slice(0, 20_000);

  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const infrastructure: DetectedTech[] = [];
  const languages: DetectedTech[] = [];
  const discoveredComponents: DiscoveredComponent[] = [];

  const addComponent = (
    type: DiscoveredComponentType,
    name: string,
    technology: string,
    evidence: string
  ) => {
    const id = `desc-${type}-${technology.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60);
    if (discoveredComponents.some((c) => c.id === id)) return;
    discoveredComponents.push({
      id,
      name,
      type,
      technology,
      evidence: [evidence],
      confidence: "low",
      source: "description",
    });
  };

  const frontends = findAll(text, FRONTEND_FRAMEWORKS);
  const ssr = findAll(text, SSR_FRAMEWORKS);
  const backends = findAll(text, BACKEND_FRAMEWORKS);

  for (const f of [...frontends, ...ssr, ...backends]) {
    frameworks.push({ name: f.name, evidence: f.evidence, confidence: "low" });
  }

  // "static export" / "static site" phrasing decides SSR vs static for Next.js etc.
  const staticExport = firstMatch(text, /\bstatic\s+(?:export|site|website|html|hosting)\b/i);
  if (ssr.length > 0 && staticExport) {
    infrastructure.push({ name: "Static export", evidence: staticExport, confidence: "low" });
  }

  for (const d of findAll(text, DATA_STORES)) {
    if (d.type === "database") {
      databases.push({ name: d.name, evidence: d.evidence, confidence: "low" });
    } else if (d.type === "cache") {
      databases.push({ name: d.name, evidence: d.evidence, confidence: "low" });
    }
    addComponent(d.type, d.name, d.name, d.evidence);
  }

  // Runtimes (informational; they do not select services on their own).
  for (const [re, name] of [
    [/\bnode(?:\.js|js)?\b/i, "Node.js"],
    [/\bpython\b/i, "Python"],
    [/\bjava\b(?!\s*script)/i, "Java"],
    [/\bgo(?:lang)?\b(?=\s+(?:api|service|backend|server))/i, "Go"],
    [/\btypescript\b/i, "TypeScript"],
  ] as Array<[RegExp, string]>) {
    const ev = firstMatch(text, re);
    if (ev) languages.push({ name, evidence: ev, confidence: "low" });
  }

  // A named runtime + "API/backend/server" with no framework is still a
  // server process the user explicitly asked for.
  const serverPhrase = firstMatch(
    text,
    /\b(?:rest(?:ful)?\s+api|api\s+server|backend(?:\s+(?:api|server|service))?|web\s+server|graphql\s+(?:api|server))\b/i
  );
  if (backends.length === 0 && serverPhrase && languages.length > 0) {
    addComponent("api", "API server", `${languages[0].name} API`, serverPhrase);
  }

  // Containers / orchestration the user named explicitly.
  const docker = firstMatch(text, /\bdocker(?:ized|ised)?\b|\bcontaineri[sz]ed\b|\bcontainers?\b/i);
  if (docker) infrastructure.push({ name: "Docker", evidence: docker, confidence: "low" });
  const k8s = firstMatch(text, /\bkubernetes\b|\bk8s\b/i);
  if (k8s) infrastructure.push({ name: "Kubernetes", evidence: k8s, confidence: "low" });

  // Background processing: only when the user says so.
  const celery = firstMatch(text, /\bcelery\b/i);
  const bull = firstMatch(text, /\bbull(?:mq)?\b/i);
  if (celery) frameworks.push({ name: "Celery (task queue)", evidence: celery, confidence: "low" });
  if (bull) frameworks.push({ name: "BullMQ (queue)", evidence: bull, confidence: "low" });
  const worker = firstMatch(text, /\bbackground\s+(?:jobs?|workers?|tasks?|processing)\b|\bjob\s+queue\b|\bworker\s+process(?:es)?\b/i);
  if (worker) addComponent("worker", "Background worker", "Background worker", worker);
  const scheduled = firstMatch(text, /\bcron\b|\bscheduled\s+(?:jobs?|tasks?)\b|\bnightly\s+(?:job|batch)\b/i);
  if (scheduled) addComponent("scheduler", "Scheduled job", "Scheduled job", scheduled);

  // User files / media → object storage. Deliberately does NOT fire on
  // "store data" or "database": a database is not file storage.
  const files = firstMatch(
    text,
    /\b(?:file|image|photo|video|media|document|attachment)s?\s+(?:upload|uploads|storage|store|hosting)\b|\bupload(?:s|ing|ed)?\b(?:\s+[a-z-]+){0,2}?\s+(?:files?|images?|photos?|videos?|documents?|attachments?|media)\b|\bobject\s+storage\b|\bblob\s+storage\b/i
  );
  if (files) addComponent("storage", "Object storage", "Object storage", files);

  // Managed identity named explicitly (a bare "login" is not enough — many
  // apps implement auth in-process).
  const idp = firstMatch(text, /\bkeycloak\b|\bokta\b|\bsingle\s+sign[- ]on\b|\bsso\b|\boauth\s?2?\b/i);
  if (idp) addComponent("auth", "Identity provider", "OAuth / SSO identity provider", idp);

  const external = findAll(text, EXTERNAL_SERVICES);

  // Requirement areas the description leaves open, for the UI to ask about.
  const unresolved: string[] = [];
  const hasCompute =
    frameworks.length > 0 ||
    discoveredComponents.some((c) => ["api", "worker", "scheduler", "backend"].includes(c.type)) ||
    /\blambda\b|\bserverless\b|\bec2\b|\becs\b|\bfargate\b|\bapp\s?runner\b/i.test(text);
  if (!hasCompute) {
    unresolved.push("application type / framework (e.g. React SPA, Express API, Django app, serverless functions)");
  }
  if (/\blog\s?in\b|\bsign\s?(?:in|up)\b|\bauthenticat/i.test(text) && !idp && !/\bcognito\b/i.test(text)) {
    unresolved.push("authentication approach (in-app sessions/JWT, Amazon Cognito, or an external identity provider)");
  }
  if (/\b(?:store|save|persist)s?\b.*\bdata\b|\bdatabase\b/i.test(text) && databases.length === 0 && !/\bdynamo\s?db\b|\brds\b|\baurora\b/i.test(text)) {
    unresolved.push("database engine (e.g. PostgreSQL, MySQL, MongoDB, DynamoDB)");
  }

  const summaryLines = [
    "Source: freeform project description (no repository code was inspected).",
    frameworks.length ? `Frameworks named: ${frameworks.map((f) => f.name).join(", ")}` : "Frameworks named: none",
    databases.length ? `Data stores named: ${databases.map((d) => d.name).join(", ")}` : "Data stores named: none",
    infrastructure.length ? `Infrastructure named: ${infrastructure.map((i) => i.name).join(", ")}` : "",
    external.length ? `External (non-AWS) services named: ${external.map((e) => e.name).join(", ")}` : "",
    unresolved.length ? `Not specified: ${unresolved.join("; ")}` : "",
  ].filter(Boolean);

  return {
    origin: "description",
    languages,
    frameworks,
    databases,
    infrastructure,
    entryPoints: [],
    awsUsage: [],
    deploymentHints: external.map((e) => ({ name: e.name, evidence: e.evidence, confidence: "low" as const })),
    discoveredComponents,
    summary: summaryLines.join("\n"),
    unresolved,
  };
}
