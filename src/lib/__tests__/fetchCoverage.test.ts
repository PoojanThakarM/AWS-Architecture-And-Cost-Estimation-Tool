/**
 * fetchCoverage.test.ts — Fix 4
 *
 * Verifies that repoFetcher's allowlist covers every pattern recognized by
 * repoAnalyzer's recognition tables (Infra signals, deployment hints,
 * manifests, and entrypoints).
 *
 * Fails CI if any recognized pattern has no corresponding fetch rule in repoFetcher.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFile } from "../repoFetcher.ts";
import {
  INFRA_FILE_SIGNALS,
  DEPLOYMENT_HINT_SIGNALS,
  LANG_FROM_MANIFEST,
  ENTRY_POINT_PATTERNS,
} from "../repoAnalyzer.ts";

describe("Fix 4 — fetchCoverage: repoFetcher covers repoAnalyzer patterns", () => {
  // Representative sample filenames for each pattern
  const samplePaths: Record<string, string[]> = {
    "Deno runtime config": ["deno.json", "deno.jsonc"],
    "Docker (Dockerfile)": ["Dockerfile", "docker/Dockerfile", "build/Dockerfile"],
    "Docker Compose": ["docker-compose.yml", "docker-compose.yaml", "docker-compose.dev.yml"],
    "Serverless Framework": ["serverless.yml", "serverless.yaml", "services/serverless.yml"],
    "AWS SAM (template.yaml)": ["template.yaml", "sam.yaml"],
    "Terraform": ["main.tf", "terraform/main.tf", "infra/vpc.tf"],
    "GitHub Actions CI/CD": [".github/workflows/ci.yml", ".github/workflows/deploy.yaml"],
    "Kubernetes manifests": ["k8s/deployment.yaml", "kubernetes/service.yml", "helm/values.yaml", "helm-chart/Chart.yaml", "kubernetes-manifests/adservice.yaml"],
    "Vercel deployment config": ["vercel.json"],
    "Netlify deployment config": ["netlify.toml"],
    "AWS Amplify config": ["amplify.yml", "amplify.yaml", "amplify/backend.ts"],
    "Elastic Beanstalk config": [".ebextensions/options.config"],
    "AWS CodeDeploy config": ["appspec.yml", "appspec.yaml"],
    "AWS CodeBuild config": ["buildspec.yml", "buildspec.yaml"],
    "AWS CloudFormation": ["cloudformation/template.yaml", ".cloudformation/stack.yml"],
    "AWS CDK config": ["cdk.json"],
    "Vercel": ["vercel.json"],
    "Netlify": ["netlify.toml"],
    "AWS Amplify": ["amplify.yml"],
    "AWS Elastic Beanstalk": [".ebextensions/app.config"],
  };

  it("covers all INFRA_FILE_SIGNALS pattern branches", () => {
    // Multiple signals may share a label (e.g. Kubernetes manifests by
    // directory and by Chart.yaml). Each sample must match at least one
    // same-label signal, and each signal at least one sample.
    const byLabel = new Map<string, typeof INFRA_FILE_SIGNALS>();
    for (const signal of INFRA_FILE_SIGNALS) {
      const list = byLabel.get(signal.label) ?? [];
      list.push(signal);
      byLabel.set(signal.label, list);
    }
    for (const [label, signals] of byLabel) {
      const paths = samplePaths[label];
      assert.ok(
        paths && paths.length > 0,
        `Missing sample path definition for infra signal: "${label}"`
      );

      for (const samplePath of paths) {
        // Assert repoAnalyzer recognizes it via some same-label signal
        assert.ok(
          signals.some((s) => s.pattern.test(samplePath)),
          `repoAnalyzer patterns for "${label}" do not match sample path "${samplePath}"`
        );

        // Assert repoFetcher classifies / fetches it
        const classified = classifyFile(samplePath);
        assert.ok(
          classified !== null,
          `repoFetcher allowlist gap: does not fetch "${samplePath}" recognized by "${label}"`
        );
      }

      for (const signal of signals) {
        assert.ok(
          paths.some((p) => signal.pattern.test(p)),
          `repoAnalyzer infra pattern ${signal.pattern} ("${label}") matches no sample path`
        );
      }
    }
  });

  it("covers all DEPLOYMENT_HINT_SIGNALS pattern branches", () => {
    for (const hint of DEPLOYMENT_HINT_SIGNALS) {
      const paths = samplePaths[hint.label];
      assert.ok(
        paths && paths.length > 0,
        `Missing sample path definition for hint: "${hint.label}"`
      );

      for (const samplePath of paths) {
        assert.ok(
          hint.pattern.test(samplePath),
          `repoAnalyzer hint pattern for "${hint.label}" does not match "${samplePath}"`
        );

        const classified = classifyFile(samplePath);
        assert.ok(
          classified !== null,
          `repoFetcher allowlist gap: does not fetch "${samplePath}" recognized by hint "${hint.label}"`
        );
      }
    }
  });

  it("covers all LANG_FROM_MANIFEST pattern branches including monorepo manifests", () => {
    const manifestSamples = [
      "deno.json",
      "deno.jsonc",
      "mix.exs",
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "cargo.toml",
      "Cargo.toml",
      "gemfile",
      "Gemfile",
      "composer.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "App.csproj",
      "packages/server/package.json",
      "apps/web/package.json",
      "modules/api/pom.xml",
    ];

    for (const manifestPath of manifestSamples) {
      const classified = classifyFile(manifestPath);
      assert.ok(
        classified !== null,
        `repoFetcher allowlist gap: does not fetch manifest path "${manifestPath}"`
      );
      assert.strictEqual(classified!.kind, "manifest");
    }
  });

  it("covers all ENTRY_POINT_PATTERNS branches", () => {
    const entrySamples = [
      "index.ts",
      "src/index.js",
      "main.py",
      "src/main.ts",
      "app.py",
      "src/app.ts",
      "server.js",
      "src/server.ts",
      "handler.py",
      "src/handler.js",
      "cmd/main.go",
      "manage.py",
      "wsgi.py",
      "asgi.py",
    ];

    for (const entryPath of entrySamples) {
      const isRecognizedByAnalyzer = ENTRY_POINT_PATTERNS.some((p) => p.test(entryPath));
      assert.ok(
        isRecognizedByAnalyzer,
        `repoAnalyzer ENTRY_POINT_PATTERNS does not match "${entryPath}"`
      );

      const classified = classifyFile(entryPath);
      assert.ok(
        classified !== null,
        `repoFetcher allowlist gap: does not fetch entrypoint path "${entryPath}"`
      );
    }
  });
});
