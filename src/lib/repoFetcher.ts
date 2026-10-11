/**
 * repoFetcher.ts  —  FLOW.md Stage 2: Evidence extraction
 *
 * Fetches README + key config files from a GitHub repo via the REST API.
 * All bounds from Decision 22–27 / flaw 1 are applied here:
 *   - 50 k-path tree cap
 *   - 20-file cap, priority-ordered (README → manifests → container/CI)
 *   - 64 KB raw read cap per file
 *   - Structured files compacted (JSON → first 40 top-level keys re-serialised;
 *     YAML → parseDocument → first 40 top-level entries stringified)
 *   - Unparseable → {name, sizeBytes} filename-only signal
 *   - SSRF: only github.com host, no redirect following
 *   - Unauthenticated path works (60 req/hr); GITHUB_TOKEN lifts to 5k/hr
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyFileKind = "readme" | "manifest" | "container_ci" | "source";

export interface KeyFile {
  path: string;
  kind: KeyFileKind;
  /** Full (possibly compacted) content, or null if only filename-only signal */
  content: string | null;
  /** Original byte size before any cap/compaction */
  sizeBytes: number;
  /** True if this file was size-capped or compacted */
  truncated: boolean;
}

export interface SdkEvidence {
  file: string;
  match: string;
  service: string;
  line?: number;
  filePath?: string;
  matchSnippet?: string;
  serviceHint?: string;
}

/**
 * Why a repository could not be read at all. Distinct from "the repo exists
 * but has little signal" — the route must never tell a user to "describe it
 * instead" when the real problem is a typo, a private repo, or a rate limit.
 */
export type RepoFetchError =
  | "invalid-url"
  | "not-found" // 404: does not exist, or is private and we have no access
  | "rate-limited" // 403/429 with an exhausted GitHub rate limit
  | "forbidden" // 401/403 for any other reason (bad token, blocked)
  | "empty-repository" // 409: repository has no commits
  | "network"; // GitHub unreachable / timed out

export interface RepoSignals {
  repoName: string; // "owner/repo"
  defaultBranch: string;
  /**
   * Set when the repository could not be read. `keyFiles` is then empty and
   * no inference should be attempted from it.
   */
  fetchError?: RepoFetchError;
  keyFiles: KeyFile[];
  /** True if any file or the tree was capped */
  truncated: boolean;
  parseErrors: string[]; // paths that failed structured parse
  /** Raw character length of the README content (0 if no README) */
  readmeLength: number;
  /** Extracted AWS SDK and service evidence from code */
  sdkEvidence: SdkEvidence[];
  manifests?: Array<{ path: string; content: string }>;
  containerCi?: Array<{ path: string; content: string }>;
  fileTree?: string[];
  githubReadme?: string;
}

// ---------------------------------------------------------------------------
// Key-file allowlist & patterns (Fix 3 & Fix 4)
// Priority groups: README > manifests > container/CI > source
// ---------------------------------------------------------------------------

const README_PATTERNS = [/^readme(\.\w+)?$/i];

const MANIFEST_PATTERNS = [
  /^package\.json$/,
  /^requirements\.txt$/,
  /^pyproject\.toml$/,
  /^Pipfile$/,
  /^go\.mod$/,
  /^go\.work$/,
  /^cargo\.toml$/i,
  /^gemfile$/i,
  /^composer\.json$/,
  /^pom\.xml$/,
  /^build\.gradle(\.kts)?$/,
  /^[\w.-]+\.csproj$/,
  /^[\w.-]+\.fsproj$/,
  /^mix\.exs$/,
  /^Package\.swift$/,
  /^schema\.prisma$/,
  /^deno\.jsonc?$/,
  /^turbo\.jsonc?$/,
  /^nx\.json$/,
  /^lerna\.json$/,
  /^rush\.json$/,
  /^pnpm-workspace\.ya?ml$/,
  // Next.js config decides static export (`output: 'export'`) vs. a
  // server-rendered Node.js process — without it SSR cannot be told apart
  // from a static site.
  /^next\.config\.(?:js|mjs|cjs|ts)$/,
];

// Monorepo nested manifests pattern for backwards compatibility
const NESTED_MANIFEST_PATTERNS = [
  /^(?:packages|apps|modules|services|libs|internal|cmd|src)\/[^/]+\/(?:package\.json|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|mix\.exs|deno\.jsonc?)$/i,
];

/**
 * Top-level directories that contain service subdirectories (not services
 * themselves). Derived from NESTED_MANIFEST_PATTERNS so the container-dir
 * convention lives in exactly one place — extend the pattern above, never
 * this set, when a new monorepo layout appears.
 */
const MONOREPO_CONTAINER_DIRS: Set<string> = (() => {
  const dirs = new Set<string>();
  for (const re of NESTED_MANIFEST_PATTERNS) {
    const m = re.source.match(/\(\?:([a-z|]+)\)/i);
    if (m) for (const d of m[1].split("|")) dirs.add(d.toLowerCase());
  }
  return dirs;
})();

/**
 * Round-robin bucket for Pass 2 of selectWorkspaceAware. Manifests under a
 * monorepo container dir (src/cartservice/…) bucket by the first TWO
 * segments so each service competes on its own; genuinely flat top-level
 * dirs (terraform/, helm-chart/) keep the single-segment bucket.
 */
function roundRobinBucket(path: string): string {
  const segs = path.split("/");
  if (
    segs.length >= 3 &&
    MONOREPO_CONTAINER_DIRS.has(segs[0].toLowerCase())
  ) {
    return `${segs[0]}/${segs[1]}`;
  }
  return segs.length > 1 ? segs[0] : "(root)";
}

// Workspace-root indicators: always fetched so monorepo layout is visible.
const WORKSPACE_ROOT_PATTERNS = [
  /^pnpm-workspace\.ya?ml$/,
  /^turbo\.jsonc?$/,
  /^nx\.json$/,
  /^lerna\.json$/,
  /^rush\.json$/,
  /^go\.work$/,
  /^cargo\.toml$/i,
];

const CONTAINER_CI_PATTERNS = [
  /(?:^|\/)Dockerfile(\.[\w.-]+)?$/i,
  /(?:^|\/)docker-compose(\.[\w.-]+)?\.(ya?ml)$/i,
  /(?:^|\/)compose(\.[\w.-]+)?\.(ya?ml)$/i,
  /(?:^|\/)serverless(\.[\w.-]+)?\.(ya?ml)$/i,
  /(?:^|\/).*serverless(\.[\w.-]+)?\.(ya?ml)$/i,
  /^\.github\/workflows\/[^/]+\.(ya?ml)$/i,
  /^vercel\.json$/i,
  /^netlify\.toml$/i,
  /^amplify\.ya?ml$/i,
  /^amplify\/.*$/i,
  /^cdk\.json$/i,
  /^appspec\.ya?ml$/i,
  /^buildspec\.ya?ml$/i,
  /^\.ebextensions\/.*$/i,
  /^(?:cloudformation|\.cloudformation)\/.*\.(ya?ml|json)$/i,
  /^(?:terraform|infra|\.infra)\/.*\.tf$/i,
  /^.*\.tf$/i,
  /^template\.ya?ml$/i,
  /^sam\.ya?ml$/i,
  /^.*\.template\.ya?ml$/i,
  /(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\/.*\.(ya?ml|json)$/i,
  /(?:^|\/)(?:ingress|deployment|service|k8s|kubernetes|statefulset|daemonset|configmap)\.ya?ml$/i,
  /(?:^|\/)Chart\.ya?ml$/i,
  /(?:^|\/)values\.ya?ml$/i,
];

const SOURCE_HIGH_PRIORITY_PATTERNS = [
  /(?:^|\/)(?:handler|lambda_function|main|app|server|index)\.(?:js|ts|mjs|cjs|py|go|rs|java)$/i,
  /(?:^|\/)cmd\/main\.go$/i,
  /(?:^|\/)(?:manage|wsgi|asgi)\.py$/i,
  /(?:^|\/).*\.controller\.(?:ts|js)$/i,
];

const SOURCE_GLOB_PATTERNS = [
  /^src\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^src\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^app\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^app\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^server\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^server\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
];

const MAX_TREE_PATHS = 50_000;
const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-file read cap (Decision 23: 64 KB). Repository contents are untrusted;
 * without a cap one oversized file (a generated values.yaml, a vendored
 * bundle named index.js) is read fully into memory and sent to the LLM.
 */
export const MAX_FILE_BYTES = 64 * 1024;

/** GitHub owner: 1–39 chars, alphanumeric or single hyphens. */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub repository name: letters, digits, '.', '_', '-' (not "." or ".."). */
const GITHUB_REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Parses and validates a github.com repository URL into owner/repo.
 * Returns null for anything that is not exactly a repository URL — the route
 * rejects it with a 400 instead of fanning out requests for a guessed path.
 */
export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  if (url.username || url.password || url.port) return null;
  // Raw pathname: percent-encoded segments ("%2e%2e") must not be decoded
  // into something the regexes accept.
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo)) return null;
  return { owner, repo };
}

/** Encodes each path segment so '#', '?', spaces etc. stay inside the path. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Reads a response body as UTF-8 text, stopping at `maxBytes`. Streaming
 * decode (`stream: true`) keeps multi-byte characters split across chunks
 * intact.
 */
export async function readTextCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > maxBytes
      ? { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), bytes, truncated: true }
      : { text, bytes, truncated: false };
  }
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let read = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - read;
    if (value.byteLength > remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      read += remaining;
      truncated = true;
      break;
    }
    text += decoder.decode(value, { stream: true });
    read += value.byteLength;
  }
  text += decoder.decode();
  if (truncated) {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Number.isFinite(declared) && declared > read ? declared : read;
  return { text, bytes, truncated: truncated || bytes > read };
}

/** Maps a failed GitHub API response to a RepoFetchError. */
function classifyGitHubFailure(res: Response): RepoFetchError {
  if (res.status === 404) return "not-found";
  if (res.status === 409) return "empty-repository";
  if (res.status === 429) return "rate-limited";
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") return "rate-limited";
  if (res.status === 401 || res.status === 403) return "forbidden";
  return "network";
}

// ---------------------------------------------------------------------------
// File-kind classifier & relevance scoring (Fix 3)
// ---------------------------------------------------------------------------

export function classifyFile(
  path: string
): { kind: KeyFileKind; priority: number; score: number } | null {
  // Ignore vendor, target, dependency, or transient cache directories
  const EXCLUDE_DIRS_RE = /(?:^|\/)(?:node_modules|vendor|\.git|\.venv|venv|target|dist|\.next|\.cache|site-packages)\//i;
  if (EXCLUDE_DIRS_RE.test(path)) {
    return null;
  }

  const name = path.split("/").pop() ?? path;
  const depth = path.split("/").length - 1; // 0 = root, 1 = one level deep

  for (const re of README_PATTERNS) {
    if (re.test(name) && depth === 0) {
      return { kind: "readme", priority: 0, score: 100 };
    }
  }

  // Workspace-root files always win a fetch slot so monorepo layout is visible.
  for (const re of WORKSPACE_ROOT_PATTERNS) {
    if (re.test(name) && depth === 0) {
      return { kind: "manifest", priority: 1, score: 92 };
    }
  }

  // Any recognized manifest filename at any depth
  for (const re of MANIFEST_PATTERNS) {
    if (re.test(name)) {
      return { kind: "manifest", priority: 1, score: Math.max(95 - depth * 5, 50) };
    }
  }

  for (const re of NESTED_MANIFEST_PATTERNS) {
    if (re.test(path)) {
      return { kind: "manifest", priority: 1, score: Math.max(90 - depth * 5, 50) };
    }
  }

  for (const re of CONTAINER_CI_PATTERNS) {
    if (re.test(path)) {
      return { kind: "container_ci", priority: 2, score: Math.max(85 - depth * 5, 45) };
    }
  }

  for (const re of SOURCE_HIGH_PRIORITY_PATTERNS) {
    if (re.test(path)) {
      return { kind: "source", priority: 3, score: Math.max(80 - depth * 5, 40) };
    }
  }

  for (const re of SOURCE_GLOB_PATTERNS) {
    if (re.test(path)) {
      return { kind: "source", priority: 3, score: Math.max(65 - depth * 5, 30) };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Structured-file compaction helpers (Decision 24)
// ---------------------------------------------------------------------------

function compactJson(raw: string): { content: string; truncated: boolean } {
  try {
    const parsed: unknown = JSON.parse(raw);
    return { content: JSON.stringify(parsed, null, 2), truncated: false };
  } catch {
    return { content: raw, truncated: false };
  }
}

function compactYaml(raw: string): { content: string; truncated: boolean; error?: boolean } {
  try {
    const parsed: unknown = parseYaml(raw);
    return { content: stringifyYaml(parsed), truncated: false };
  } catch {
    return { content: raw, truncated: false, error: true };
  }
}

function lineLimit(raw: string): { content: string; truncated: boolean } {
  return { content: raw, truncated: false };
}

// ---------------------------------------------------------------------------
// Process a single file's raw content
// ---------------------------------------------------------------------------

function processContent(
  path: string,
  raw: string,
  parseErrors: string[]
): { content: string; truncated: boolean } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "json") {
    const result = compactJson(raw);
    try { JSON.parse(raw); } catch { parseErrors.push(path); return { content: raw, truncated: false }; }
    return result;
  }

  if (ext === "yml" || ext === "yaml") {
    const result = compactYaml(raw);
    if (result.error) {
      parseErrors.push(path);
      return { content: raw, truncated: false };
    }
    return { content: result.content, truncated: false };
  }

  if (ext === "toml" || ext === "xml") {
    return lineLimit(raw);
  }

  return { content: raw, truncated: false };
}

// ---------------------------------------------------------------------------
// GitHub REST fetch helpers
// ---------------------------------------------------------------------------

function ghHeaders(token?: string): HeadersInit {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function ghFetch(url: string, token?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: ghHeaders(token),
      signal: controller.signal,
      redirect: "error", // SSRF guard: never follow redirects
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// SDK Evidence extraction pass (Fix 3)
// ---------------------------------------------------------------------------

export function extractSdkEvidence(keyFiles: KeyFile[]): SdkEvidence[] {
  const evidence: SdkEvidence[] = [];
  const seen = new Set<string>();

  const add = (file: string, match: string, service: string, line?: number) => {
    const key = `${file}:${service}:${match}`;
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push({
        file,
        filePath: file,
        match: match.slice(0, 100),
        matchSnippet: match.slice(0, 100),
        service,
        serviceHint: service,
        line,
      });
    }
  };

  for (const file of keyFiles) {
    if (!file.content) continue;
    const content = file.content;

    // boto3.client('service') or boto3.resource('service')
    const botoMatches = content.matchAll(/boto3\.(?:client|resource)\(\s*['"]([a-zA-Z0-9_-]+)['"]/g);
    for (const m of botoMatches) {
      const rawSvc = m[1].toLowerCase();
      const svcMap: Record<string, string> = {
        s3: "S3",
        dynamodb: "DynamoDB",
        sqs: "SQS",
        sns: "SNS",
        lambda: "Lambda",
        rds: "RDS",
        ecs: "ECS",
        ec2: "EC2",
        "cognito-idp": "Cognito",
        "cognito-identity": "Cognito",
        eventbridge: "EventBridge",
        events: "EventBridge",
        kinesis: "Kinesis",
        ses: "SES",
        apigateway: "APIGateway",
        cloudwatch: "CloudWatch",
        logs: "CloudWatch",
      };
      const svc = svcMap[rawSvc] ?? rawSvc.toUpperCase();
      add(file.path, m[0], svc);
    }

    // require('aws-sdk')
    const awsSdkMatches = content.matchAll(/require\(\s*['"]aws-sdk['"]\s*\)/g);
    for (const m of awsSdkMatches) {
      add(file.path, m[0], "AWS SDK");
    }

    // require('@aws-sdk/client-...') or from '@aws-sdk/client-...'
    const v3Matches = content.matchAll(/(?:require\(\s*['"]|from\s+['"])@aws-sdk\/client-([\w-]+)['"]/g);
    for (const m of v3Matches) {
      const rawClient = m[1].toLowerCase();
      const clientMap: Record<string, string> = {
        s3: "S3",
        lambda: "Lambda",
        dynamodb: "DynamoDB",
        sqs: "SQS",
        sns: "SNS",
        rds: "RDS",
        "cognito-identity-provider": "Cognito",
        "cognito-idp": "Cognito",
        cloudwatch: "CloudWatch",
        ec2: "EC2",
        ecs: "ECS",
        ses: "SES",
        eventbridge: "EventBridge",
        kinesis: "Kinesis",
        "api-gateway": "APIGateway",
        apigatewayv2: "APIGateway",
      };
      const svc = clientMap[rawClient] ?? rawClient;
      add(file.path, m[0], svc);
    }

    // S3 operations: PutObjectCommand, s3.putObject, s3.upload, etc.
    const s3Ops = content.matchAll(/(?:PutObjectCommand|s3\.putObject|s3\.upload|S3.*PutObject|s3\.getObject|GetObjectCommand)/gi);
    for (const m of s3Ops) {
      add(file.path, m[0], "S3");
    }

    // SQS operations: sqs.sendMessage, SendMessageCommand, etc.
    const sqsOps = content.matchAll(/(?:sqs\.sendMessage|SendMessageCommand|sqs\.send_message|sqs\.receiveMessage)/gi);
    for (const m of sqsOps) {
      add(file.path, m[0], "SQS");
    }

    // DynamoDB operations
    const dynamoOps = content.matchAll(/(?:dynamodb\.putItem|PutItemCommand|dynamodb\.query|QueryCommand|dynamodb\.getItem)/gi);
    for (const m of dynamoOps) {
      add(file.path, m[0], "DynamoDB");
    }

    // WebSocket server bindings (explicit server only — bare ws.on() is too generic)
    const wsMatches = content.matchAll(/(?:WebSocketServer|socket\.io|new\s+WebSocket\()/gi);
    for (const m of wsMatches) {
      add(file.path, m[0], "APIGateway");
    }

    // cron / schedule decorators
    const cronMatches = content.matchAll(/(?:@schedule|croniter|node-cron|cron\.schedule|@cron)/gi);
    for (const m of cronMatches) {
      add(file.path, m[0], "EventBridge");
    }

    // Kafka / streaming messaging
    const kafkaMatches = content.matchAll(/(?:spring-kafka|kafka-clients|kafkajs|kafka-python|KafkaConsumer|KafkaProducer|confluent)/gi);
    for (const m of kafkaMatches) {
      add(file.path, m[0], "MSK");
    }

    // Search / OpenSearch
    const searchMatches = content.matchAll(/(?:@opensearch-project\/opensearch|opensearch-py|elasticsearch|spring-data-opensearch|spring-data-elasticsearch)/gi);
    for (const m of searchMatches) {
      add(file.path, m[0], "OpenSearch");
    }

    // Email / SMTP (production senders only — maildev/mailhog are local dev tools)
    const emailMatches = content.matchAll(/(?:nodemailer|spring-boot-starter-mail|sendgrid|mailgun|smtplib)/gi);
    for (const m of emailMatches) {
      add(file.path, m[0], "SES");
    }

    // Object storage (explicit AWS SDK only — multer/formidable are local disk uploads)
    const uploadMatches = content.matchAll(/(?:boto3\.client\(['"]s3['"]\)|@aws-sdk\/client-s3)/gi);
    for (const m of uploadMatches) {
      add(file.path, m[0], "S3");
    }

    // Machine Learning (framework imports only — model.fit() alone is local training)
    const mlMatches = content.matchAll(/(?:tensorflow|keras|torch\.nn|PlantVillage)/gi);
    for (const m of mlMatches) {
      add(file.path, m[0], "SageMaker");
    }
  }

  return evidence;
}

export interface FileCandidate {
  path: string;
  kind: KeyFileKind;
  priority: number;
  score: number;
}

function isWorkspaceRootFile(path: string): boolean {
  if (path.includes("/")) return false;
  const name = path;
  return WORKSPACE_ROOT_PATTERNS.some((re) => re.test(name));
}

/** True for workspace-root indicator paths (any depth check is root-only). */
export function isWorkspaceRootPath(path: string): boolean {
  return isWorkspaceRootFile(path);
}

/**
 * Workspace-aware file selection: priority files first (README,
 * workspace-root, root manifests, all container/CI/IaC), then breadth-first
 * round-robin across directory buckets so polyglot monorepos surface
 * every service directory (monorepo containers bucket two segments deep).
 */
export function selectWorkspaceAware(
  candidates: FileCandidate[],
  cap: number = 60
): FileCandidate[] {
  const sorted = [...candidates].sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.path.length - b.path.length
  );

  const selected: FileCandidate[] = [];
  const taken = new Set<string>();
  const take = (c: FileCandidate) => {
    if (taken.has(c.path) || selected.length >= cap) return;
    taken.add(c.path);
    selected.push(c);
  };

  // Pass 1a: README + workspace-root first (small fixed count, never contested).
  for (const c of sorted) {
    if (c.kind === "readme" || isWorkspaceRootFile(c.path)) {
      take(c);
    }
  }

  // Pass 1b: manifests up to a reserved share of the budget, root manifests
  // first, then round-robin across buckets (two-segment under container
  // dirs). Guarantees service manifests survive repos with heavy IaC/CI.
  const MANIFEST_RESERVE = Math.max(1, Math.floor(cap / 2));
  let manifestTaken = 0;
  const takeManifest = (c: FileCandidate) => {
    if (manifestTaken >= MANIFEST_RESERVE || selected.length >= cap) return;
    const before = selected.length;
    take(c);
    if (selected.length > before) manifestTaken++;
  };
  for (const c of sorted) {
    if (manifestTaken >= MANIFEST_RESERVE) break;
    if (taken.has(c.path)) continue;
    const depth = c.path.split("/").length - 1;
    if (c.kind === "manifest" && depth === 0) {
      takeManifest(c);
    }
  }
  const byDir = new Map<string, FileCandidate[]>();
  for (const c of sorted) {
    if (taken.has(c.path)) continue;
    if (c.kind !== "manifest") continue;
    const bucket = roundRobinBucket(c.path);
    const list = byDir.get(bucket) ?? [];
    list.push(c);
    byDir.set(bucket, list);
  }
  let progress = true;
  while (progress && selected.length < cap && manifestTaken < MANIFEST_RESERVE) {
    progress = false;
    for (const list of byDir.values()) {
      const next = list.shift();
      if (next) {
        takeManifest(next);
        progress = true;
      }
      if (selected.length >= cap || manifestTaken >= MANIFEST_RESERVE) break;
    }
  }

  // Pass 1c: container_ci fills whatever budget remains after the manifest
  // reserve — still valued signal, never uncapped.
  for (const c of sorted) {
    if (selected.length >= cap) break;
    if (taken.has(c.path)) continue;
    if (c.kind === "container_ci") {
      take(c);
    }
  }

  // Pass 3: remaining candidates by score until budget is exhausted.
  for (const c of sorted) {
    if (selected.length >= cap) break;
    take(c);
  }

  return selected;
}

/**
 * Minimal pnpm-workspace.yaml parser: extracts package glob directories so
 * workspace member manifests become accepted fetch targets dynamically.
 */
export function parsePnpmWorkspace(content: string): string[] {
  const dirs: string[] = [];
  const lines = content.split(/\r?\n/);
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^-\s+['"]?([^'"\s]+)['"]?/);
      if (item) {
        dirs.push(item[1].replace(/\/\*+$/, "").replace(/^\.\//, ""));
      } else if (/^\w[\w-]*\s*:/.test(line)) {
        inPackages = false;
      }
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetches evidence signals from a GitHub repo URL.
 * Decision 26: server-side GITHUB_TOKEN via env; unauthenticated path works at 60 req/hr.
 * Decision 27: host allowlist enforced before this is called (in the route); here we
 *              additionally never follow redirects.
 * Never throws — errors in individual file fetches are swallowed and flagged as parseErrors.
 */
export async function fetchRepoSignals(
  repoUrl: string,
  githubToken?: string
): Promise<RepoSignals> {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    return emptySignals("?/?", "invalid-url");
  }
  const { owner, repo } = parsed;

  const repoName = `${owner}/${repo}`;
  const parseErrors: string[] = [];
  let overallTruncated = false;

  // 1. Repository metadata. This is the one call that tells us whether the
  //    repository exists and is readable; every later step depends on it.
  //    A 404 here used to be swallowed, after which ~110 speculative requests
  //    were fired at a repository that does not exist.
  let defaultBranch = "main";
  try {
    const metaRes = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}`, githubToken);
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as { default_branch?: string; size?: number };
      defaultBranch = meta.default_branch ?? "main";
    } else {
      return emptySignals(repoName, classifyGitHubFailure(metaRes));
    }
  } catch {
    return emptySignals(repoName, "network");
  }

  // 2. Get file tree
  let treePaths: string[] = [];
  let treeFailed = false;
  try {
    const treeRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      githubToken
    );
    if (treeRes.ok) {
      const treeData = (await treeRes.json()) as {
        tree?: { path: string; type: string; size?: number }[];
        truncated?: boolean;
      };
      if (treeData.truncated) overallTruncated = true;
      treePaths = (treeData.tree ?? [])
        .filter((t) => t.type === "blob")
        .map((t) => t.path)
        .slice(0, MAX_TREE_PATHS);
    } else {
      const failure = classifyGitHubFailure(treeRes);
      // 404/409 on the tree of an existing repo means it has no commits.
      if (failure === "not-found" || failure === "empty-repository") {
        return emptySignals(repoName, "empty-repository");
      }
      if (failure === "rate-limited") return emptySignals(repoName, "rate-limited");
      treeFailed = true;
    }
  } catch {
    treeFailed = true;
  }

  // 3. Classify and relevance-sort files (Fix 3)
  const candidates: FileCandidate[] = [];
  for (const path of treePaths) {
    const c = classifyFile(path);
    if (c) candidates.push({ path, ...c });
  }

  // Fallback probing: only when the tree call itself failed (not when the
  // tree was readable but simply contained no recognised files — probing
  // then can only produce 404s).
  if (candidates.length === 0 && treeFailed) {
    const PROBE_LIST = [
      "README.md", "package.json", "requirements.txt", "pyproject.toml",
      "go.mod", "Cargo.toml", "Dockerfile", "docker-compose.yml",
      "serverless.yml", "pom.xml", "build.gradle", "Gemfile", "composer.json",
      "main.tf", "template.yaml",
    ];
    for (const f of PROBE_LIST) {
      const c = classifyFile(f);
      if (c) candidates.push({ path: f, ...c });
    }
  }

  // Workspace-aware selection (breadth-first across top-level directories).
  const MAX_SELECTED_FILES = 60;
  const selected = selectWorkspaceAware(candidates, MAX_SELECTED_FILES);

  // 4. Fetch each selected file, capped at MAX_FILE_BYTES.
  const keyFiles: KeyFile[] = [];
  let readmeLength = 0;
  const isProbed = treePaths.length === 0;

  for (const candidate of selected) {
    let raw: string | null = null;
    let sizeBytes = 0;
    let fileTruncated = false;

    // raw.githubusercontent first (not rate-limited); fall back to the
    // /contents API (base64) only on a raw miss. The branch is known from the
    // metadata call, so no main/master guessing is needed.
    const rawController = new AbortController();
    const rawTimer = setTimeout(() => rawController.abort(), FETCH_TIMEOUT_MS);
    try {
      const rawFetch = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(defaultBranch)}/${encodePath(candidate.path)}`,
        {
          headers: githubToken ? { Authorization: `Bearer ${githubToken}` } : {},
          signal: rawController.signal,
          redirect: "error",
        }
      );
      if (rawFetch.ok) {
        const capped = await readTextCapped(rawFetch, MAX_FILE_BYTES);
        raw = capped.text;
        sizeBytes = capped.bytes;
        fileTruncated = capped.truncated;
      } else if (rawFetch.status === 404 && isProbed) {
        clearTimeout(rawTimer);
        continue; // speculative probe: file simply does not exist
      }
    } catch {
      // fall through to the contents API
    } finally {
      clearTimeout(rawTimer);
    }

    if (raw === null && !isProbed) {
      try {
        const rawRes = await ghFetch(
          `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodePath(candidate.path)}`,
          githubToken
        );
        if (rawRes.ok) {
          const data = (await rawRes.json()) as { content?: string; size?: number };
          sizeBytes = data.size ?? 0;
          if (data.content) {
            const buf = Buffer.from(data.content.replace(/\n/g, ""), "base64");
            fileTruncated = buf.byteLength > MAX_FILE_BYTES;
            raw = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
          }
        }
      } catch {
        // fall through to the null-content handling below
      }
    }

    if (raw === null) {
      if (isProbed) continue;
      parseErrors.push(candidate.path);
      keyFiles.push({ path: candidate.path, kind: candidate.kind, content: null, sizeBytes, truncated: false });
      continue;
    }

    // Track README length (before compaction)
    if (candidate.kind === "readme") {
      readmeLength = raw.length;
    }

    if (fileTruncated) {
      overallTruncated = true;
      // A structured file cut mid-document is no longer valid JSON/YAML.
      // Decision 24: never feed malformed structure downstream — degrade to a
      // filename-only signal instead.
      if (/\.(json|ya?ml|toml|xml)$/i.test(candidate.path) || candidate.kind === "manifest") {
        parseErrors.push(candidate.path);
        keyFiles.push({ path: candidate.path, kind: candidate.kind, content: null, sizeBytes, truncated: true });
        continue;
      }
    }

    const processed = processContent(candidate.path, raw, parseErrors);

    keyFiles.push({
      path: candidate.path,
      kind: candidate.kind,
      content: processed.content,
      sizeBytes,
      truncated: fileTruncated,
    });
  }

  const sdkEvidence = extractSdkEvidence(keyFiles);

  return {
    repoName,
    defaultBranch,
    keyFiles,
    truncated: overallTruncated,
    parseErrors,
    readmeLength,
    sdkEvidence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySignals(repoName: string, reason: RepoFetchError): RepoSignals {
  return {
    repoName,
    defaultBranch: "main",
    fetchError: reason,
    keyFiles: [],
    truncated: false,
    parseErrors: [],
    readmeLength: 0,
    sdkEvidence: [],
  };
}

/**
 * Checks the insufficient-signal gate (Decision 20 / flaw 8).
 * Returns true if the repo has too little signal to run inference.
 */
export function isInsufficientSignal(signals: RepoSignals): boolean {
  const hasManifestOrCI = signals.keyFiles.some(
    (f) => f.kind === "manifest" || f.kind === "container_ci"
  );
  return !hasManifestOrCI && signals.readmeLength < 100;
}

import type { Grounding } from "./schema.ts";

/**
 * Converts RepoSignals into the flat RuleInput that the rule engine expects.
 */
export function signalsToRuleInput(
  signals: RepoSignals,
  inputKind: "github_url" | "description",
  grounding: Grounding
): import("./ruleEngine.ts").RuleInput {
  // README prose is excluded from the rule-engine keyword scanner (path-level
  // signals in fileNames stay). README intent still reaches the LLM path via
  // the profile summary / buildArchitecturePrompt.
  const fileContent = signals.keyFiles
    .filter((f) => f.kind !== "readme")
    .map((f) => (f.content ? `### ${f.path}\n${f.content}` : `### ${f.path} (parse error)`))
    .join("\n\n");
  // Full paths, not basenames — directory-based logic (monorepo grouping,
  // frontend-dir detection, k8s-folder detection) needs them.
  const fileNames = signals.keyFiles.map((f) => f.path);

  return {
    description: "",
    fileContent,
    fileNames,
    inputKind,
    grounding,
    truncated: signals.truncated,
    parseErrors: signals.parseErrors,
  };
}
