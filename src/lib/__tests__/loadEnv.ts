/**
 * loadEnv.ts — side-effect module that loads .env.local for CLI-run diagnostics.
 *
 * Next.js loads .env.local for `next dev` / `next build`, but NOT for a bare
 * `node --experimental-strip-types` run. Without this, llmConfigured() returns
 * false and any harness that exercises the LLM path silently falls back to the
 * rules baseline — which is why an earlier baseline reported identical
 * rules-only and merged numbers.
 *
 * Import this FIRST, before any pipeline module:
 *
 *     import { loadedEnvFiles } from "./loadEnv.ts";
 *     import { runInference } from "../inference.ts";
 *
 * ESM evaluates imports in source order, so importing this module first
 * guarantees process.env is populated before the pipeline modules initialise.
 * Inline top-of-file statements would NOT achieve that — import declarations
 * are hoisted above them.
 *
 * Node 22+ ships process.loadEnvFile(); no dependency needed.
 * Paths resolve from THIS FILE, not cwd, so behaviour is invocation-independent.
 * Earlier files win: process.loadEnvFile does not overwrite an already-set var.
 */

import { resolve } from "node:path";

const ENV_CANDIDATES = [
  resolve(import.meta.dirname, "../../../.env.local"), // aws-architect/.env.local
  resolve(import.meta.dirname, "../../../../.env.local"), // repo-root/.env.local
];

const loaded: string[] = [];

for (const envPath of ENV_CANDIDATES) {
  try {
    process.loadEnvFile(envPath);
    loaded.push(envPath);
  } catch {
    // Missing or unreadable file is fine — a later candidate may supply the keys.
  }
}

/** Absolute paths of the .env.local files that were successfully loaded. */
export const loadedEnvFiles: readonly string[] = loaded;

/** Every path that was tried, for error messages when nothing was found. */
export const envCandidatePaths: readonly string[] = ENV_CANDIDATES;
