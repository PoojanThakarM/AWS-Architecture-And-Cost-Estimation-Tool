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
  generateCftYaml,
  generateCftFromDiagramXml,
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

  const appName = typeof body.appName === "string" && body.appName.trim()
    ? body.appName.trim()
    : "aws-architect-app";

  const environment = typeof body.environment === "string" && body.environment.trim()
    ? body.environment.trim()
    : "dev";

  let cftYaml: string;
  let pattern = body.pattern || "generic";

  // Mode A: Multiple ServicePlans payload
  if (Array.isArray(body.service_plans) && body.service_plans.length > 0) {
    const plans = [];
    for (const p of body.service_plans) {
      const planResult = ServicePlanSchema.safeParse(p);
      if (planResult.success) {
        plans.push(planResult.data);
      }
    }
    if (plans.length > 0) {
      const yamls = generateCftYaml(plans, { appName, environment });
      return NextResponse.json({
        cft_yamls: yamls,
        cft_yaml: yamls[0],
        filename: `${(plans[0].detectedPattern || "generic").replace(/[^a-zA-Z0-9_-]/g, "-")}-template.yaml`,
        pattern: plans[0].detectedPattern || "generic",
        disclaimer: "Starting template, not production-ready IaC (Decision 33)",
      });
    }
  }

  // Mode B: Single ServicePlan payload
  if (body.service_plan) {
    const planResult = ServicePlanSchema.safeParse(body.service_plan);
    if (!planResult.success) {
      return NextResponse.json(
        { error: "Invalid service_plan: " + planResult.error.message },
        { status: 400 }
      );
    }
    pattern = planResult.data.detectedPattern || pattern;
    cftYaml = generateCftYaml(planResult.data, { appName, environment });
  }
  // Mode B: Diagram XML payload
  else if (typeof body.diagram_xml === "string" && body.diagram_xml.trim().length > 0) {
    cftYaml = generateCftFromDiagramXml(body.diagram_xml, pattern);
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
    disclaimer: "Starting template, not production-ready IaC (Decision 33)",
  });
}
