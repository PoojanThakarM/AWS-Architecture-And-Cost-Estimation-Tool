"use client";

import React, { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw, Maximize2, Minimize2, Sparkles, FileCode, Info } from "lucide-react";
import type { ServicePlan } from "@/lib/schema";
import { generateCftYaml, generateCftFromDiagramXml } from "@/lib/cftExport";

export interface DiagramViewerProps {
  diagramXml: string;
  filename: string;
  patternTitle?: string;
  servicePlan?: ServicePlan;
}

const DRAWIO_EMBED_URL =
  "https://embed.diagrams.net/?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json&fit=1";

export function DiagramViewer({
  diagramXml,
  filename,
  patternTitle,
  servicePlan,
}: DiagramViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setReady(false);
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      try {
        const msg = JSON.parse(ev.data as string) as { event: string };
        if (msg.event === "init") {
          // draw.io iframe is ready — send the XML with autosize and center
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action: "load", xml: diagramXml, autosize: 1 }),
            "*"
          );
          setTimeout(() => {
            iframeRef.current?.contentWindow?.postMessage(
              JSON.stringify({ action: "center" }),
              "*"
            );
          }, 200);
          setReady(true);
        }
      } catch {
        // non-JSON messages from draw.io are expected
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [diagramXml]);

  useEffect(() => {
    function onResize() {
      if (ready && iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          JSON.stringify({ action: "center" }),
          "*"
        );
      }
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ready]);

  function handleDownload() {
    const blob = new Blob([diagramXml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadCft() {
    const yamlContent = servicePlan
      ? generateCftYaml(servicePlan, { patternOverride: patternTitle })
      : generateCftFromDiagramXml(diagramXml, patternTitle);

    const baseName = filename.replace(/\.drawio$/, "");
    const cftFilename = `${baseName}-template.yaml`;
    const blob = new Blob([yamlContent], { type: "application/x-yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cftFilename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenDrawio() {
    window.open("https://app.diagrams.net", "_blank");
  }

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background/95 p-4 sm:p-6 backdrop-blur-xl animate-fadeIn"
          : "flex flex-1 flex-col gap-3 w-full min-h-0"
      }
    >
      {/* Top Workspace Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-1">
        <div className="flex items-center gap-2.5">
          <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="text-xs font-semibold text-foreground">
              Architecture Workspace
            </span>
            <span className="hidden sm:inline text-xs text-muted/60">•</span>
            <p className="text-xs text-muted">
              Interactive AWS canvas. Drag nodes, adjust zoom, or click to edit relationships.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Maximize / Viewport expand button */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/80 px-3.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition-all hover:border-accent/40 hover:bg-surface-3 active:scale-95"
            title={isFullscreen ? "Exit fullscreen" : "Expand canvas to fullscreen"}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="h-3.5 w-3.5 text-accent" />
                <span>Exit Fullscreen</span>
              </>
            ) : (
              <>
                <Maximize2 className="h-3.5 w-3.5 text-accent" />
                <span className="hidden sm:inline">Fullscreen</span>
              </>
            )}
          </button>

          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light shadow-sm transition-all hover:border-accent/60 hover:bg-accent/20 active:scale-95"
            title="Download .drawio XML file to edit locally or import to Diagrams.net"
          >
            <Download className="h-3.5 w-3.5 text-accent" />
            <span>Download .drawio</span>
          </button>

          {/* Sibling Option: Download CloudFormation (.yaml) */}
          <button
            onClick={handleDownloadCft}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs font-medium text-amber-300 shadow-sm transition-all hover:border-amber-500/70 hover:bg-amber-500/20 active:scale-95"
            title="Download deployable CloudFormation YAML template (Starting template, not production-ready IaC)"
          >
            <FileCode className="h-3.5 w-3.5 text-amber-400" />
            <span>Download .yaml (CFT)</span>
          </button>

          <button
            onClick={handleOpenDrawio}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-3.5 py-1.5 text-xs font-medium text-muted transition-all hover:border-accent/40 hover:text-foreground active:scale-95"
            title="Open in draw.io web editor"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">draw.io</span>
          </button>
        </div>
      </div>

      {/* IaC Disclaimer Advisory (Decision 33) */}
      <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3.5 py-1.5 text-[11px] text-amber-300/80">
        <Info className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span>
          <strong>CloudFormation Advisory:</strong> Generated CFT is a starting architectural template, not production-ready IaC. Review security policies, roles, and sizing before deployment.
        </span>
      </div>

      {/* Frame Container — Responsive Full-Sized Workspace */}
      <div
        className={`relative flex flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface-2/70 shadow-2xl backdrop-blur-md transition-all ${
          isFullscreen
            ? "h-[calc(100vh-100px)] w-full"
            : "h-[74vh] min-h-[640px] max-h-[960px] w-full"
        }`}
      >
        {!ready && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface/90 backdrop-blur-sm">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 border border-accent/25 shadow-lg">
              <RefreshCw className="h-6 w-6 animate-spin text-accent" />
            </div>
            <div className="text-center">
              <p className="font-mono text-xs font-medium text-foreground">
                Rendering AWS Architecture Topology…
              </p>
              <p className="text-[11px] text-muted mt-1">
                Synthesizing VPC tiers, subnets, icons, and routing edges
              </p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={DRAWIO_EMBED_URL}
          className="h-full w-full flex-1 border-0"
          title="AWS Architecture Blueprint"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  );
}
