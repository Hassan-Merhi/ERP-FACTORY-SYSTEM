import { Button } from "@/components/ui/button";
import { Download, Loader2, ShieldCheck } from "lucide-react";
import type { MixIntegrityAudits } from "./useMixIntegrityAudits";

/** Header actions that run and download the read-only mix integrity audits. */
export function MixIntegrityAuditControls({ audits }: { audits: MixIntegrityAudits }) {
  const {
    canAuditHistoricalMixes,
    isAuditingMixes,
    auditExportLevel,
    isAuditingLifecycle,
    isExportingLifecycle,
    isAuditingDownstream,
    isExportingDownstream,
    isAuditingProvenance,
    provenanceExport,
    handleRunHistoricalAudit,
    handleDownloadHistoricalAudit,
    handleRunProvenanceAudit,
    handleDownloadProvenanceAudit,
    handleRunDownstreamAudit,
    handleExportDownstreamAudit,
    handleRunLifecycleAudit,
    handleExportLifecycleAudit,
  } = audits;
  return (
    <>
      {canAuditHistoricalMixes && (
        <div
          className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="mix-historical-audit-controls"
        >
          <div>
            <p className="text-sm font-semibold">Historical Mix Cost Integrity</p>
            <p className="text-xs text-muted-foreground">
              Read-only audit of every active and deleted batch; no automatic repricing.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAuditingMixes}
              onClick={handleRunHistoricalAudit}
              data-testid="button-run-mix-historical-audit"
              className="gap-2"
            >
              {isAuditingMixes ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isAuditingMixes ? "Auditing…" : "Audit All Batches"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={auditExportLevel !== null}
              onClick={() => handleDownloadHistoricalAudit("batches")}
              className="gap-2"
              data-testid="button-download-mix-batch-audit"
            >
              <Download className="h-4 w-4" /> Batch CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={auditExportLevel !== null}
              onClick={() => handleDownloadHistoricalAudit("sources")}
              className="gap-2"
              data-testid="button-download-mix-source-audit"
            >
              <Download className="h-4 w-4" /> Source CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAuditingDownstream}
              onClick={handleRunDownstreamAudit}
              className="gap-2"
              data-testid="button-audit-mix-bale-gl"
            >
              {isAuditingDownstream ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {isAuditingDownstream ? "Auditing…" : "Audit Bale & GL"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isExportingDownstream}
              onClick={handleExportDownstreamAudit}
              className="gap-2"
              data-testid="button-export-mix-bale-gl-audit"
            >
              <Download className="h-4 w-4" /> Bale/GL CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAuditingLifecycle}
              onClick={handleRunLifecycleAudit}
              className="gap-2"
              data-testid="button-audit-mix-lifecycle"
            >
              {isAuditingLifecycle ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isAuditingLifecycle ? "Auditing…" : "Audit Used KG"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isExportingLifecycle}
              onClick={handleExportLifecycleAudit}
              className="gap-2"
              data-testid="button-export-mix-lifecycle-audit"
            >
              <Download className="h-4 w-4" /> Lifecycle CSV
            </Button>
          </div>
        </div>
      )}

      {canAuditHistoricalMixes && (
        <div
          className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="mix-phase4-audit-controls"
        >
          <div>
            <p className="text-sm font-semibold">Raw Stock & Supplier Provenance</p>
            <p className="text-xs text-muted-foreground">
              Checks container ownership, adjustment-backed usage and historical valuation evidence.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAuditingProvenance}
              onClick={handleRunProvenanceAudit}
              data-testid="button-audit-mix-raw-provenance"
            >
              {isAuditingProvenance ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              {isAuditingProvenance ? "Auditing…" : "Audit Raw Stock"}
            </Button>
            {(["stock", "ownership", "adjustments"] as const).map((section) => (
              <Button
                key={section}
                type="button"
                variant="outline"
                size="sm"
                disabled={provenanceExport !== null}
                onClick={() => handleDownloadProvenanceAudit(section)}
                data-testid={`button-export-mix-${section}-audit`}
              >
                <Download className="mr-1 h-4 w-4" />{" "}
                {section === "stock" ? "Stock CSV" : section === "ownership" ? "Owner CSV" : "Adjustments CSV"}
              </Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
