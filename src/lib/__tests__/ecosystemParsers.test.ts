import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePyprojectToml,
  parseCargoToml,
  parsePomXml,
  parseBuildGradle,
  parseGemfile,
  parseComposerJson,
  parseCsProj,
  mapParsedPackages,
  analyzeProject,
  CARGO_PACKAGE_MAP,
  MAVEN_ARTIFACT_MAP,
  RUBY_GEM_MAP,
  PHP_COMPOSER_MAP,
  DOTNET_PACKAGE_MAP,
  PYTHON_PACKAGE_MAP,
} from "../repoAnalyzer.ts";
import type { RepoSignals } from "../repoFetcher.ts";

describe("Fix 6 — Ecosystem Manifest Parsers", () => {
  it("parses pyproject.toml standard project.dependencies and poetry dependencies", () => {
    const content = `
[project]
name = "my-fastapi-app"
version = "0.1.0"
dependencies = [
    "fastapi>=0.100.0",
    "uvicorn[standard]",
    "psycopg2-binary==2.9.9",
    "boto3>=1.34.0"
]

[tool.poetry.dependencies]
python = "^3.11"
redis = "^5.0.0"
celery = { version = "^5.3.0", extras = ["redis"] }
`;
    const pkgs = parsePyprojectToml(content);
    const names = pkgs.map((p) => p.name);
    assert.ok(names.includes("fastapi"), "Should include fastapi");
    assert.ok(names.includes("uvicorn"), "Should include uvicorn");
    assert.ok(names.includes("psycopg2-binary"), "Should include psycopg2-binary");
    assert.ok(names.includes("boto3"), "Should include boto3");
    assert.ok(names.includes("redis"), "Should include redis");
    assert.ok(names.includes("celery"), "Should include celery");
    assert.ok(!names.includes("python"), "Should filter python runtime key");

    const mapped = mapParsedPackages(pkgs, "pyproject.toml", PYTHON_PACKAGE_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "FastAPI"));
    assert.ok(mapped.databases.some((d) => d.name === "PostgreSQL"));
    assert.ok(mapped.databases.some((d) => d.name === "Redis"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (boto3)"));
  });

  it("parses Cargo.toml dependencies and AWS Rusoto/SDK crates", () => {
    const content = `
[package]
name = "rust-api"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1.36", features = ["full"] }
axum = "0.7"
diesel = { version = "2.1", features = ["postgres"] }
aws-sdk-s3 = "1.15.0"
aws-sdk-dynamodb = "1.14.0"
redis = "0.24"
`;
    const pkgs = parseCargoToml(content);
    const names = pkgs.map((p) => p.name);
    assert.ok(names.includes("tokio"));
    assert.ok(names.includes("axum"));
    assert.ok(names.includes("diesel"));
    assert.ok(names.includes("aws-sdk-s3"));
    assert.ok(names.includes("aws-sdk-dynamodb"));
    assert.ok(names.includes("redis"));

    const mapped = mapParsedPackages(pkgs, "Cargo.toml", CARGO_PACKAGE_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "Axum"));
    assert.ok(mapped.databases.some((d) => d.name === "Diesel ORM"));
    assert.ok(mapped.databases.some((d) => d.name === "Redis"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (S3)"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (DynamoDB)"));
  });

  it("parses pom.xml Maven dependencies and maps Spring/AWS SDK", () => {
    const content = `
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>org.hibernate.orm</groupId>
      <artifactId>hibernate-core</artifactId>
      <version>6.4.0.Final</version>
    </dependency>
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>s3</artifactId>
      <version>2.20.0</version>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.7.0</version>
    </dependency>
  </dependencies>
</project>
`;
    const pkgs = parsePomXml(content);
    assert.strictEqual(pkgs.length, 4);

    const mapped = mapParsedPackages(pkgs, "pom.xml", MAVEN_ARTIFACT_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "Spring Boot"));
    assert.ok(mapped.databases.some((d) => d.name === "Hibernate ORM"));
    assert.ok(mapped.databases.some((d) => d.name === "PostgreSQL"));
    assert.ok(mapped.awsUsage.some((a) => a.name.includes("S3")));
  });

  it("parses build.gradle dependencies", () => {
    const content = `
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.1.5'
    implementation "software.amazon.awssdk:dynamodb:2.21.0"
    implementation('org.postgresql:postgresql:42.6.0')
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
}
`;
    const pkgs = parseBuildGradle(content);
    assert.ok(pkgs.some((p) => p.name.includes("spring-boot-starter-web")));
    assert.ok(pkgs.some((p) => p.name.includes("dynamodb")));
    assert.ok(pkgs.some((p) => p.name.includes("postgresql")));

    const mapped = mapParsedPackages(pkgs, "build.gradle", MAVEN_ARTIFACT_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "Spring Boot"));
    assert.ok(mapped.databases.some((d) => d.name === "PostgreSQL"));
    assert.ok(mapped.awsUsage.some((a) => a.name.includes("DynamoDB")));
  });

  it("parses Gemfile and maps Rails / pg / redis / aws-sdk", () => {
    const content = `
source 'https://rubygems.org'
gem 'rails', '~> 7.1.0'
gem 'pg', '~> 1.5'
gem 'redis', '~> 5.0'
gem 'sidekiq'
gem 'aws-sdk-s3'
`;
    const pkgs = parseGemfile(content);
    const names = pkgs.map((p) => p.name);
    assert.ok(names.includes("rails"));
    assert.ok(names.includes("pg"));
    assert.ok(names.includes("redis"));
    assert.ok(names.includes("sidekiq"));
    assert.ok(names.includes("aws-sdk-s3"));

    const mapped = mapParsedPackages(pkgs, "Gemfile", RUBY_GEM_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "Ruby on Rails"));
    assert.ok(mapped.frameworks.some((f) => f.name.includes("Sidekiq")));
    assert.ok(mapped.databases.some((d) => d.name === "PostgreSQL"));
    assert.ok(mapped.databases.some((d) => d.name === "Redis"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (S3)"));
  });

  it("parses composer.json and maps Laravel / Doctrine / AWS SDK", () => {
    const content = JSON.stringify({
      require: {
        "laravel/framework": "^10.0",
        "doctrine/orm": "^2.16",
        "aws/aws-sdk-php": "^3.280",
        "predis/predis": "^2.2",
      },
    });
    const pkgs = parseComposerJson(content);
    const mapped = mapParsedPackages(pkgs, "composer.json", PHP_COMPOSER_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "Laravel"));
    assert.ok(mapped.databases.some((d) => d.name === "Doctrine ORM"));
    assert.ok(mapped.databases.some((d) => d.name === "Redis"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (PHP)"));
  });

  it("parses *.csproj PackageReference and maps ASP.NET / EntityFramework / AWS SDK", () => {
    const content = `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.App" />
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />
    <PackageReference Include="AWSSDK.S3" Version="3.7.305" />
    <PackageReference Include="AWSSDK.SQS" Version="3.7.300" />
    <PackageReference Include="StackExchange.Redis" Version="2.7.4" />
  </ItemGroup>
</Project>
`;
    const pkgs = parseCsProj(content);
    const mapped = mapParsedPackages(pkgs, "MyApp.csproj", DOTNET_PACKAGE_MAP);
    assert.ok(mapped.frameworks.some((f) => f.name === "ASP.NET Core"));
    assert.ok(mapped.databases.some((d) => d.name === "PostgreSQL"));
    assert.ok(mapped.databases.some((d) => d.name === "Redis"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (S3)"));
    assert.ok(mapped.awsUsage.some((a) => a.name === "AWS SDK (SQS)"));
  });

  it("maps .NET wrapper/sibling package variants (cartservice shape)", () => {
    const content = `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Caching.StackExchangeRedis" Version="10.0.11" />
    <PackageReference Include="Npgsql" Version="10.0.3" />
    <PackageReference Include="Google.Cloud.Spanner.Data" Version="5.12.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.0.0" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.0" />
  </ItemGroup>
</Project>
`;
    const pkgs = parseCsProj(content);
    const mapped = mapParsedPackages(pkgs, "cartservice.csproj", DOTNET_PACKAGE_MAP);
    const dbNames = mapped.databases.map((d) => d.name);
    assert.ok(dbNames.includes("Redis"), `wrapper must map to Redis; got ${dbNames.join(", ")}`);
    assert.ok(dbNames.includes("PostgreSQL"), `bare Npgsql must map; got ${dbNames.join(", ")}`);
    assert.ok(dbNames.includes("Cloud Spanner"), `Spanner must surface; got ${dbNames.join(", ")}`);
    assert.ok(dbNames.includes("MongoDB"), `MongoDB.Driver must map; got ${dbNames.join(", ")}`);
    assert.ok(dbNames.includes("SQL Server"), `SqlClient must map; got ${dbNames.join(", ")}`);
  });

  it("analyzeProject logs parseFailures on corrupted manifest without throwing", () => {
    const signals: RepoSignals = {
      repoName: "test/corrupt-app",
      defaultBranch: "main",
      keyFiles: [
        { path: "composer.json", kind: "manifest", content: "{ bad json missing closing brace", sizeBytes: 100, truncated: false },
        { path: "pyproject.toml", kind: "manifest", content: "[project]\ndependencies = ['fastapi']", sizeBytes: 100, truncated: false },
      ],
      sdkEvidence: [],
      truncated: false,
      parseErrors: [],
      readmeLength: 0,
    };

    const profile = analyzeProject(signals);
    assert.ok(profile.parseFailures?.includes("composer.json"), "Should record composer.json parse failure");
    assert.ok(profile.frameworks.some((f) => f.name === "FastAPI"), "Should still parse valid pyproject.toml");
  });
});
