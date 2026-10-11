/**
 * /api/export/cft — POST
 *
 * CloudFormation Template (YAML) Export Endpoint
 *
 * Accepts either a ServicePlan or diagram XML string, generates a valid
 * deployable AWS CloudFormation YAML template, and returns the YAML payload
 * or triggers a direct download.
 */

import { NextRequest, NextResponse } from "next/server";
import { ServicePlanSchema } from "@/lib/schema";
import {
  ALLOWED_ENVIRONMENTS,
  MAX_DIAGRAM_XML_CHARS,
  cftCoverage,
  extractServicesFromDiagramXml,
  generateCftYaml,
  generateCftFromDiagramXml,
  sanitizeAppName,
  validateCloudFormationTemplate,
} from "@/lib/cftExport";

interface CftExportRequestBody {
  service_plan?: unknown;
  service_plans?: unknown[];
  diagram_xml?: string;
  pattern?: string;
  appName?: string;
  environment?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: CftExportRequestBody;
  try {
    body = (await req.json()) as CftExportRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  // AppName becomes part of S3/ALB names (lowercase, length-limited), so it is
  // normalised rather than passed through.
  const appName = sanitizeAppName(typeof body.appName === "string" ? body.appName : undefined);

  // Environment must be one of the template's AllowedValues; an arbitrary
  // value used to become a Default outside AllowedValues (an invalid template).
  let environment = "dev";
  if (body.environment !== undefined) {
    const env = typeof body.environment === "string" ? body.environment.trim().toLowerCase() : "";
    if (!(ALLOWED_ENVIRONMENTS as readonly string[]).includes(env)) {
      return NextResponse.json(
        { error: `environment must be one of: ${ALLOWED_ENVIRONMENTS.join(", ")}` },
        { status: 400 }
      );
    }
    environment = env;
  }

  let cftYaml: string;
  let pattern = typeof body.pattern === "string" && body.pattern ? body.pattern.slice(0, 64) : "generic";

  // Mode A: Multiple ServicePlans payload
  if (Array.isArray(body.service_plans) && body.service_plans.length > 0) {
    if (body.service_plans.length > 5) {
      return NextResponse.json({ error: "At most 5 service_plans per request" }, { status: 400 });
    }
    const plans = [];
    for (const [i, p] of body.service_plans.entries()) {
      const planResult = ServicePlanSchema.safeParse(p);
      if (!planResult.success) {
        // Silently skipping invalid plans hid errors; reject explicitly.
        return NextResponse.json({ error: `Invalid service_plans[${i}]` }, { status: 400 });
      }
      plans.push(planResult.data);
    }
    const yamls = generateCftYaml(plans, { appName, environment });
    // Mode A used to skip validation entirely.
    for (const [i, y] of yamls.entries()) {
      const v = validateCloudFormationTemplate(y);
      if (!v.valid) {
        console.error(`[export/cft] Generated template ${i} failed validation:`, v.errors);
        return NextResponse.json(
          { error: "Template generation failed validation", details: v.errors },
          { status: 500 }
        );
      }
    }
    return NextResponse.json({
      cft_yamls: yamls,
      cft_yaml: yamls[0],
      filename: `${(plans[0].detectedPattern || "generic").replace(/[^a-zA-Z0-9_-]/g, "-")}-template.yaml`,
      pattern: plans[0].detectedPattern || "generic",
      coverage: plans.map((p) => cftCoverage(p.awsMappings.map((m) => m.serviceId))),
      disclaimer: "Starting template, not production-ready IaC (Decision 33)",
    });
  }

  let coverage = null;

  // Mode B: Single ServicePlan payload
  if (body.service_plan) {
    const planResult = ServicePlanSchema.safeParse(body.service_plan);
    if (!planResult.success) {
      return NextResponse.json(
        { error: "Invalid service_plan", details: planResult.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) },
        { status: 400 }
      );
    }
    pattern = planResult.data.detectedPattern || pattern;
    cftYaml = generateCftYaml(planResult.data, { appName, environment });
    coverage = cftCoverage(planResult.data.awsMappings.map((m) => m.serviceId));
  }
  // Mode C: Diagram XML payload
  else if (typeof body.diagram_xml === "string" && body.diagram_xml.trim().length > 0) {
    if (body.diagram_xml.length > MAX_DIAGRAM_XML_CHARS) {
      return NextResponse.json({ error: "diagram_xml is too large" }, { status: 413 });
    }
    cftYaml = generateCftFromDiagramXml(body.diagram_xml, pattern);
    coverage = cftCoverage(extractServicesFromDiagramXml(body.diagram_xml).serviceIds);
  } else {
    return NextResponse.json(
      { error: "Must provide either service_plan or diagram_xml in request body" },
      { status: 400 }
    );
  }

  // Validate generated CloudFormation template
  const validation = validateCloudFormationTemplate(cftYaml);
  if (!validation.valid) {
    console.error("[export/cft] Generated template validation failed:", validation.errors);
    return NextResponse.json(
      { error: "Template generation failed validation", details: validation.errors },
      { status: 500 }
    );
  }

  const filename = `${pattern.replace(/[^a-zA-Z0-9_-]/g, "-")}-template.yaml`;

  // Direct download response if requested via ?download=true
  const isDownload = req.nextUrl.searchParams.get("download") === "true";
  if (isDownload) {
    return new NextResponse(cftYaml, {
      status: 200,
      headers: {
        "Content-Type": "application/x-yaml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({
    cft_yaml: cftYaml,
    filename,
    pattern,
    // Which plan services are in the template, which were added as
    // prerequisites, and which have no CloudFormation mapping yet.
    coverage,
    disclaimer: "Starting template, not production-ready IaC (Decision 33)",
  });
}
