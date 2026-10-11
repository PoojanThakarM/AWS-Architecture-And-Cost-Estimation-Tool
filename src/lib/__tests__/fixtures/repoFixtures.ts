/**
 * repoFixtures.ts — controlled, offline repository fixtures for the
 * regression matrix (Phase K). Each fixture is a RepoSignals object exactly
 * as repoFetcher would produce it, so tests exercise the real
 * analyzeProject → ruleEngine → diagram → cost → CFN pipeline with no network.
 */
import type { RepoSignals, KeyFile } from "../../repoFetcher.ts";
import { extractSdkEvidence } from "../../repoFetcher.ts";

function kf(path: string, kind: KeyFile["kind"], content: string | null): KeyFile {
  return { path, kind, content, sizeBytes: content?.length ?? 0, truncated: false };
}

function signals(repoName: string, keyFiles: KeyFile[]): RepoSignals {
  const readme = keyFiles.find((f) => f.kind === "readme");
  return {
    repoName,
    defaultBranch: "main",
    keyFiles,
    truncated: false,
    parseErrors: [],
    readmeLength: readme?.content?.length ?? 0,
    sdkEvidence: extractSdkEvidence(keyFiles),
  };
}

const pkg = (o: object) => JSON.stringify(o, null, 2);

/** A. Static React (Vite) site — no server, no database. */
export const STATIC_REACT = signals("fixture/static-react", [
  kf("README.md", "readme", "# Portfolio\nA personal portfolio built with React and Vite. Deployed as static files."),
  kf("package.json", "manifest", pkg({
    name: "portfolio", private: true,
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.0" },
  })),
  kf("src/main.jsx", "source", "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nReactDOM.createRoot(document.getElementById('root')).render(<App/>);"),
]);

/** B. Next.js app with server-side rendering and an API route. */
export const NEXT_SSR = signals("fixture/next-ssr", [
  kf("README.md", "readme", "# Shop\nA Next.js storefront with server-side rendering and API routes."),
  kf("package.json", "manifest", pkg({
    name: "shop", private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
  })),
  kf("app/api/products/route.ts", "source", "export async function GET() { return Response.json([]); }"),
]);

/** B2. Next.js configured for static export (output: 'export'). */
export const NEXT_STATIC_EXPORT = signals("fixture/next-export", [
  kf("README.md", "readme", "# Docs\nStatic documentation site built with Next.js static export."),
  kf("package.json", "manifest", pkg({
    name: "docs", private: true,
    scripts: { dev: "next dev", build: "next build" },
    dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
  })),
  kf("next.config.mjs", "manifest", "/** @type {import('next').NextConfig} */\nconst nextConfig = { output: 'export' };\nexport default nextConfig;\n"),
]);

/** C. MERN application (React client + Express/Mongoose server). */
export const MERN = signals("fixture/mern", [
  kf("README.md", "readme", "# Task Manager\nMERN stack task manager."),
  kf("client/package.json", "manifest", pkg({
    name: "client", private: true,
    scripts: { start: "react-scripts start", build: "react-scripts build" },
    dependencies: { react: "^18.2.0", "react-dom": "^18.2.0", axios: "^1.6.0" },
  })),
  kf("server/package.json", "manifest", pkg({
    name: "server",
    scripts: { start: "node server.js" },
    dependencies: { express: "^4.19.0", mongoose: "^8.0.0", cors: "^2.8.5", dotenv: "^16.0.0" },
  })),
  kf("server/server.js", "source", "const express = require('express');\nconst mongoose = require('mongoose');\nmongoose.connect(process.env.MONGO_URI);\nconst app = express();\napp.listen(5000);"),
]);

/** D. Node.js/Express API with PostgreSQL (docker-compose dev stack). */
export const NODE_PG = signals("fixture/node-pg", [
  kf("README.md", "readme", "# Orders API\nREST API for orders."),
  kf("package.json", "manifest", pkg({
    name: "orders-api",
    scripts: { start: "node src/index.js" },
    dependencies: { express: "^4.19.0", pg: "^8.11.0" },
  })),
  kf("docker-compose.yml", "container_ci", "services:\n  api:\n    build: .\n    ports:\n    - 3000:3000\n    environment:\n      DATABASE_URL: postgres://app:app@db:5432/orders\n    depends_on:\n    - db\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n"),
  kf("Dockerfile", "container_ci", "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD [\"node\", \"src/index.js\"]\n"),
  kf("src/index.js", "source", "const express = require('express');\nconst { Pool } = require('pg');\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\nconst app = express();\napp.listen(3000);"),
]);

/** E. Python (Django) application with a relational database. */
export const DJANGO_PG = signals("fixture/django-pg", [
  kf("README.md", "readme", "# Blog\nA Django blog."),
  kf("requirements.txt", "manifest", "Django==5.0.6\npsycopg2-binary==2.9.9\ngunicorn==22.0.0\n"),
  kf("manage.py", "source", "#!/usr/bin/env python\nimport os, sys\nif __name__ == '__main__':\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'blog.settings')\n"),
]);

/** F. Containerised app with Redis worker via docker-compose. */
export const COMPOSE_WORKER = signals("fixture/compose-worker", [
  kf("README.md", "readme", "# Thumbnailer\nWeb API plus background worker."),
  kf("requirements.txt", "manifest", "fastapi==0.111.0\nuvicorn==0.30.0\ncelery==5.4.0\nredis==5.0.4\n"),
  kf("docker-compose.yml", "container_ci", "services:\n  web:\n    build: .\n    environment:\n      REDIS_URL: redis://redis:6379/0\n  worker:\n    build: .\n    command: celery -A tasks worker\n    environment:\n      REDIS_URL: redis://redis:6379/0\n  redis:\n    image: redis:7\n"),
  kf("Dockerfile", "container_ci", "FROM python:3.12-slim\nCOPY . .\nRUN pip install -r requirements.txt\nCMD [\"uvicorn\", \"main:app\"]\n"),
]);

/** G. Existing AWS serverless application (Serverless Framework). */
export const SERVERLESS_AWS = signals("fixture/serverless", [
  kf("README.md", "readme", "# Notes API\nServerless notes API."),
  kf("package.json", "manifest", pkg({
    name: "notes-api",
    dependencies: { "@aws-sdk/client-dynamodb": "^3.600.0" },
    devDependencies: { serverless: "^3.38.0" },
  })),
  kf("serverless.yml", "container_ci", "service: notes\nprovider:\n  name: aws\n  runtime: nodejs20.x\nfunctions:\n  create:\n    handler: handler.create\n    events:\n    - httpApi:\n        path: /notes\n        method: post\nresources:\n  Resources:\n    NotesTable:\n      Type: AWS::DynamoDB::Table\n"),
  kf("handler.js", "source", "const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');\nexports.create = async (event) => ({ statusCode: 201 });"),
]);

/** H. Conflicting evidence: README claims MongoDB, manifests prove PostgreSQL. */
export const CONTRADICTORY = signals("fixture/contradictory", [
  kf("README.md", "readme", "# Inventory\nUses MongoDB and Kafka for everything. Deployed on Kubernetes."),
  kf("package.json", "manifest", pkg({
    name: "inventory",
    scripts: { start: "node index.js" },
    dependencies: { express: "^4.19.0", pg: "^8.11.0" },
  })),
  kf("index.js", "source", "const express = require('express');\nconst { Pool } = require('pg');\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });"),
]);

/** Plain Java CLI app: "public static void main" must not imply a static website. */
export const JAVA_CLI = signals("fixture/java-cli", [
  kf("README.md", "readme", "# Calc\nA command line calculator."),
  kf("pom.xml", "manifest", "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>calc</artifactId><version>1.0</version></project>"),
  kf("src/Main.java", "source", "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"static helper\");\n  }\n}\n"),
]);

export const REPO_FIXTURES = {
  STATIC_REACT, NEXT_SSR, NEXT_STATIC_EXPORT, MERN, NODE_PG, DJANGO_PG,
  COMPOSE_WORKER, SERVERLESS_AWS, CONTRADICTORY, JAVA_CLI,
} as const;
