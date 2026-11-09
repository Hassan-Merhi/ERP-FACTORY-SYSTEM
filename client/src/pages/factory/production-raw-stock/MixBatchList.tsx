import { useState, useMemo } from "react";
import { formatNumber } from "@/lib/formatNumber";
import { summarizeRecordedMixBatches, recordedMixBatchCost } from "@/lib/recordedMixBatchCost";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useOptionalCompany } from "@/contexts/CompanyContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers, Pencil, Trash2, MessageCircle, Loader2, FileSpreadsheet, ShieldCheck, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { MixBatchWhatsAppPreview } from "./MixBatchWhatsAppPreview";
import type { MixBatchSupplierCategory, MixBatchSupplierCategoryLink } from "./mixBatchCategoryTargets";

export interface MixBatchRow {
  id: number;
  batchCode: string;
  name: string | null;
  totalWeightKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  totalCost: string;
  status: string;
  operatorUser: string | null;
  batchDate: string | null;
  carryForwardFromId: number | null;
  createdAt: string;
  displayTotalWeightKg?: string;
  displayTotalCost?: string;
  displayCostPerKg?: string;
}

export interface MixBatchSourceRow {
  id: number;
  sourceName: string;
  containerNumber: string | null;
  categoryId?: number | null;
  categoryName?: string | null;
  supplierId?: number | null;
  sourceBatchId?: number | null;
  weightKg: number;
  costPerKg: string | number;
  totalCost: number;
}

export interface MixBatchPrintRow {
  id: number;
  batchCode: string;
  name: string | null;
  status: string;
  totalWeightKg: number;
  totalCost: number;
  costPerKg: string;
  displayTotalCost?: number;
  displayCostPerKg?: string;
  sources?: MixBatchSourceRow[];
}

interface MixHistoricalAuditPreview {
  generatedAt: string;
  readOnly: true;
  summary: {
    batches: number;
    activeBatches: number;
    deletedBatches: number;
    sources: number;
    headerMismatchBatches: number;
    sourceLineMismatchBatches: number;
    historicalZeroSourceBatches: number;
    inventoryOwnerReviewBatches: number;
    missingCurrentRateBatches: number;
    currentRateEstimateDifferenceBatches: number;
    overusedBatches: number;
    arithmeticErrorBatches: number;
    evidenceReviewBatches: number;
  };
  batches: Array<{
    batchId: number;
    batchCode: string;
    deleted: boolean;
    classification: string;
    issues: Array<{ code: string; severity: string; detail: string }>;
  }>;
}

interface MixPhase4Audit {
  readOnly: true;
  generatedAt: string;
  summary: {
    rawStockRows: number;
    rawStockOverdrawRows: number;
    totalRawRowOverdrawKg: string;
    supplierOverdrawReviewCount: number;
    unbackedShortageSupplierCount: number;
    ownershipSourceExceptions: number;
    ownershipAffectedBatches: number;
    unclassifiedValuedAdds: number;
    unclassifiedNonUsdAdds: number;
    supplierOnlySourceRows: number;
  };
  rawStockExceptions: Array<{
    rawStockId: number; containerNumber: string | null;
    excessUsedKg: string; supplierCoverage: string;
  }>;
  ownershipExceptions: Array<{
    sourceId: number; batchCode: string; pricingSupplierId: number | null;
    recordedInventorySupplierId: number | null;
    currentContainerSupplierId: number | null;
  }>;
  adjustmentEvidence: Array<{
    adjustmentId: number; supplierName: string | null; date: string;
    kg: string; currency: string; classification: string;
  }>;
}

interface MixPhase5Audit {
  readOnly: true;
  generatedAt: string;
  summary: {
    activeMixBatches: number;
    consumedMixesWithoutLineage: number;
    totalUsedMixKgWithoutLineage: string;
    activeBaleRows: number;
    unlinkedBaleRows: number;
    balesLinkedDirectlyToMix: number;
    balesLinkedViaPressing: number;
    soldBales: number;
    inStockBales: number;
    finishedGoodsSavedValueUsd: string;
    baleCostMismatchRows: number;
    orderLinkedBales: number;
    historicalBaleRecostRuns: number;
    inventoryCutoverActive: boolean;
  };
  batches: Array<{ batchId: number; batchCode: string; classification: string; usedKg: string }>;
}

interface MixBatchListProps {
  mixBatches: MixBatchRow[];
  isLoading: boolean;
  onEdit: (batch: MixBatchRow) => void;
  onDelete: (id: number) => void;
  onViewDetail: (batch: MixBatchRow) => void;
  onSendWhatsApp: () => void;
  isSendingWhatsApp: boolean;
  mixBatchDate: string;
  setMixBatchDate: (date: string) => void;
  mixBatchesByDate: MixBatchPrintRow[];
  mixBatchesByDateLoading: boolean;
  mixBatchPrintRef: React.RefObject<HTMLDivElement | null>;
  reportCategories: MixBatchSupplierCategory[];
  reportSuppliers: MixBatchSupplierCategoryLink[];
  reportAllocations: Record<string, number> | null;
  reportLoading: boolean;
  formatDisplayDate: (date: string) => string;
}

export function MixBatchList({
  mixBatches,
  isLoading,
  onEdit,
  onDelete,
  onViewDetail,
  onSendWhatsApp,
  isSendingWhatsApp,
  mixBatchDate,
  setMixBatchDate,
  mixBatchesByDate,
  mixBatchPrintRef,
  reportCategories,
  reportSuppliers,
  reportAllocations,
  reportLoading,
  formatDisplayDate,
}: MixBatchListProps) {
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
  const selectedRole = String(useOptionalCompany()?.selectedCompany?.role ?? "").trim().toLowerCase();
  const canAuditHistoricalMixes = ["admin", "owner", "developer", "dev"].includes(selectedRole);
  const [showAllMixBatches, setShowAllMixBatches] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isAuditingMixes, setIsAuditingMixes] = useState(false);
  const [auditExportLevel, setAuditExportLevel] = useState<"batches" | "sources" | null>(null);
  const [historicalAudit, setHistoricalAudit] = useState<MixHistoricalAuditPreview | null>(null);
  const [phase4Audit, setPhase4Audit] = useState<MixPhase4Audit | null>(null);
  const [phase5Audit, setPhase5Audit] = useState<MixPhase5Audit | null>(null);
  const [isAuditingDownstream, setIsAuditingDownstream] = useState(false);
  const [isExportingDownstream, setIsExportingDownstream] = useState(false);
  const [isAuditingProvenance, setIsAuditingProvenance] = useState(false);
  const [provenanceExport, setProvenanceExport] = useState<"stock" | "ownership" | "adjustments" | null>(null);
  const [exportPeriod, setExportPeriod] = useState<"month" | "all-time">("month");
  const [exportMonth, setExportMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const { toast } = useToast();

  const handleExportExcel = async () => {
    setIsExportingExcel(true);
    try {
      const response = await fetch("/api/factory/mix-batches/cost-sources", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load historical supplier costs. Please try again.");
      const supplierSources = (await response.json()) as import("./mixBatchCostExport").MixBatchCostSourceRow[];
      const { exportMixBatchCostAnalysis } = await import("./mixBatchCostExport");
      await exportMixBatchCostAnalysis(
        mixBatches,
        exportPeriod === "all-time" ? "all-time" : exportMonth,
        supplierSources
      );
      toast({
        title: "Excel exported",
        description: "Supplier-by-day costs, daily totals, monthly averages and source details downloaded.",
      });
    } catch (error) {
      toast({
        title: "Excel export failed",
        description: error instanceof Error ? error.message : "Could not generate the Excel workbook.",
        variant: "destructive",
      });
    } finally {
      setIsExportingExcel(false);
    }
  };
  const handleRunHistoricalAudit = async () => {
    setIsAuditingMixes(true);
    try {
      const res = await fetch("/api/factory/mix-batches?profile=historical-audit&includeSources=false", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!res.ok) throw new Error("Could not load the historical audit.");
      setHistoricalAudit((await res.json()) as MixHistoricalAuditPreview);
      toast({ title: "Historical audit ready", description: "All active and deleted mix batches were checked without changing any records." });
    } catch (error) {
      toast({
        title: "Historical audit failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAuditingMixes(false);
    }
  };

  const handleDownloadHistoricalAudit = async (level: "batches" | "sources") => {
    setAuditExportLevel(level);
    try {
      const res = await fetch(
        "/api/factory/mix-batches?profile=historical-audit&format=csv&level=" + level,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!res.ok) throw new Error("Historical audit export could not be generated.");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "factory-mix-historical-" + level + "-audit.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (error) {
      toast({ title: "Audit export failed", description: error instanceof Error ? error.message : "Please retry.", variant: "destructive" });
    } finally {
      setAuditExportLevel(null);
    }
  };

  const handleRunProvenanceAudit = async () => {
    setIsAuditingProvenance(true);
    try {
      const res = await fetch("/api/factory/mix-batches?profile=raw-provenance-audit", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!res.ok) throw new Error("Unable to load the raw-material provenance report.");
      setPhase4Audit((await res.json()) as MixPhase4Audit);
      toast({ title: "Raw stock and supplier audit ready", description: "No inventory, pricing or accounting values were changed." });
    } catch (error) {
      toast({ title: "Provenance audit failed", description: error instanceof Error ? error.message : "Please retry.", variant: "destructive" });
    } finally { setIsAuditingProvenance(false); }
  };

  const handleDownloadProvenanceAudit = async (section: "stock" | "ownership" | "adjustments") => {
    setProvenanceExport(section);
    try {
      const res = await fetch(
        "/api/factory/mix-batches?profile=raw-provenance-audit&format=csv&section=" + section,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!res.ok) throw new Error("Could not generate raw-material audit export.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "factory-mix-" + section + "-audit.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : "Please retry.", variant: "destructive" });
    } finally { setProvenanceExport(null); }
  };

  const handleRunDownstreamAudit = async () => {
    setIsAuditingDownstream(true);
    try {
      const response = await fetch("/api/factory/mix-batches?profile=downstream-audit", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load production/bale/GL reconciliation.");
      setPhase5Audit((await response.json()) as MixPhase5Audit);
      toast({ title: "Bale & GL audit ready", description: "All mixes were checked without changing costs, sales or accounting." });
    } catch (error) {
      toast({ title: "Bale & GL audit failed", description: error instanceof Error ? error.message : "Please retry.", variant: "destructive" });
    } finally { setIsAuditingDownstream(false); }
  };

  const handleExportDownstreamAudit = async () => {
    setIsExportingDownstream(true);
    try {
      const response = await fetch("/api/factory/mix-batches?profile=downstream-audit&format=csv", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not generate the downstream reconciliation export.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "factory-mix-downstream-audit.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : "Please retry.", variant: "destructive" });
    } finally { setIsExportingDownstream(false); }
  };

  const BATCH_PREVIEW_COUNT = 15;

  const visibleMixBatches = useMemo(
    () => (showAllMixBatches ? mixBatches : mixBatches.slice(0, BATCH_PREVIEW_COUNT)),
    [mixBatches, showAllMixBatches]
  );

  const fmtKg = (n: number) => formatNumber(n, 3);
  const { totalWeightKg: sumTotal, costPerKg: blendedCost } = summarizeRecordedMixBatches(mixBatches);
  const sumUsed = mixBatches.reduce((sum, batch) => sum + (parseFloat(batch.usedKg) || 0), 0);
  const sumRemaining = mixBatches.reduce((sum, batch) => sum + (parseFloat(batch.remainingKg) || 0), 0);


  return (
    <Card
      className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      data-testid="mix-batch-list"
    >
      <CardHeader className="flex flex-col gap-4 border-b border-border/50 bg-linear-to-r from-amber-50/55 via-card to-card p-4 dark:from-amber-500/5 dark:via-card dark:to-card sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:p-5">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2.5 text-lg font-bold tracking-tight sm:text-xl">
            <Layers className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            Recent Mix Batches
          </CardTitle>
          <p className="text-xs text-muted-foreground">Historical list of blends and their cost origins</p>
        </div>

        <div className="grid w-full grid-cols-1 gap-2 rounded-xl border border-border/70 bg-muted/30 p-2 shadow-sm min-[420px]:grid-cols-[minmax(0,1fr)_auto] sm:w-auto sm:p-1.5">
          <input
            type="date"
            value={mixBatchDate}
            onChange={(e) => setMixBatchDate(e.target.value)}
            className="min-h-11 min-w-0 w-full rounded-lg border border-input bg-background px-3 py-1 text-base font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:w-auto sm:text-sm"
            data-testid="input-mix-batch-date"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onSendWhatsApp}
            disabled={isSendingWhatsApp || reportLoading || reportAllocations === null || mixBatchesByDate.length === 0}
            data-testid="button-send-mix-batch-whatsapp"
            className="h-11 w-full gap-2 rounded-lg border-border/80 bg-card font-medium shadow-sm sm:h-9 sm:w-auto"
          >
            {isSendingWhatsApp ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            Send WhatsApp
          </Button>
        </div>

        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={exportPeriod}
              onChange={(event) => setExportPeriod(event.target.value as "month" | "all-time")}
              aria-label="Excel cost report period"
              className="h-10 min-w-0 rounded-xl border border-input bg-background px-3 text-sm font-semibold shadow-sm"
              data-testid="select-mix-batch-export-period"
            >
              <option value="month">Selected Month</option>
              <option value="all-time">All Time</option>
            </select>
            {exportPeriod === "month" && (
              <input
                type="month"
                value={exportMonth}
                onChange={(event) => setExportMonth(event.target.value)}
                aria-label="Excel dashboard month"
                className="h-10 min-w-0 rounded-xl border border-input bg-background px-3 text-sm font-semibold shadow-sm sm:w-40"
                data-testid="input-mix-batch-export-month"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportExcel}
              disabled={
                isLoading || isExportingExcel || mixBatches.length === 0 || (exportPeriod === "month" && !exportMonth)
              }
              className="h-10 gap-2 rounded-xl border-emerald-500/40 bg-emerald-500/5 font-bold text-emerald-700 shadow-sm hover:bg-emerald-500/10 dark:text-emerald-300"
              data-testid="button-export-mix-batch-cost-excel"
            >
              {isExportingExcel ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
              Export Cost Excel
            </Button>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {exportPeriod === "all-time"
              ? "All-time dashboard · all suppliers and production dates"
              : "Selected month dashboard · full historical supplier detail included"}
          </span>
        </div>

        {canAuditHistoricalMixes && (
        <div className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="mix-historical-audit-controls">
          <div>
            <p className="text-sm font-semibold">Historical Mix Cost Integrity</p>
            <p className="text-xs text-muted-foreground">Read-only audit of every active and deleted batch; no automatic repricing.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isAuditingMixes} onClick={handleRunHistoricalAudit}
              data-testid="button-run-mix-historical-audit" className="gap-2">
              {isAuditingMixes ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isAuditingMixes ? "Auditing…" : "Audit All Batches"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={auditExportLevel !== null}
              onClick={() => handleDownloadHistoricalAudit("batches")} className="gap-2"
              data-testid="button-download-mix-batch-audit">
              <Download className="h-4 w-4" /> Batch CSV
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={auditExportLevel !== null}
              onClick={() => handleDownloadHistoricalAudit("sources")} className="gap-2"
              data-testid="button-download-mix-source-audit">
              <Download className="h-4 w-4" /> Source CSV
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={isAuditingDownstream}
              onClick={handleRunDownstreamAudit} className="gap-2"
              data-testid="button-audit-mix-bale-gl">
              {isAuditingDownstream ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isAuditingDownstream ? "Auditing…" : "Audit Bale & GL"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={isExportingDownstream}
              onClick={handleExportDownstreamAudit} className="gap-2"
              data-testid="button-export-mix-bale-gl-audit">
              <Download className="h-4 w-4" /> Bale/GL CSV
            </Button>
          </div>
        </div>
        )}

        {canAuditHistoricalMixes && (
          <div className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="mix-phase4-audit-controls">
            <div>
              <p className="text-sm font-semibold">Raw Stock & Supplier Provenance</p>
              <p className="text-xs text-muted-foreground">Checks container ownership, adjustment-backed usage and historical valuation evidence.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={isAuditingProvenance}
                onClick={handleRunProvenanceAudit} data-testid="button-audit-mix-raw-provenance">
                {isAuditingProvenance ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                {isAuditingProvenance ? "Auditing…" : "Audit Raw Stock"}
              </Button>
              {(["stock", "ownership", "adjustments"] as const).map((section) => (
                <Button key={section} type="button" variant="outline" size="sm"
                  disabled={provenanceExport !== null}
                  onClick={() => handleDownloadProvenanceAudit(section)}
                  data-testid={`button-export-mix-${section}-audit`}>
                  <Download className="mr-1 h-4 w-4" /> {section === "stock" ? "Stock CSV" : section === "ownership" ? "Owner CSV" : "Adjustments CSV"}
                </Button>
              ))}
            </div>
          </div>
        )}

        <MixBatchWhatsAppPreview
          reportRef={mixBatchPrintRef}
          date={mixBatchDate}
          batches={mixBatchesByDate}
          categories={reportCategories}
          suppliers={reportSuppliers}
          allocations={reportAllocations}
        />
      </CardHeader>

      <CardContent className="min-w-0 p-4 sm:p-5">
        {phase5Audit && (
          <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-phase5-audit-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Phase 5 · Production, Bale & GL Reconciliation</p>
              <span className="text-xs text-muted-foreground">Read-only · {phase5Audit.generatedAt.slice(0, 10)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Consumed mixes without output links</p>
                <p className="font-mono font-bold">{phase5Audit.summary.consumedMixesWithoutLineage}</p></div>
              <div><p className="text-xs text-muted-foreground">Bales without mix link</p>
                <p className="font-mono font-bold">{formatNumber(phase5Audit.summary.unlinkedBaleRows, 0)}</p></div>
              <div><p className="text-xs text-muted-foreground">Bales marked sold</p>
                <p className="font-mono font-bold">{formatNumber(phase5Audit.summary.soldBales, 0)}</p></div>
              <div><p className="text-xs text-muted-foreground">Historical recost runs</p>
                <p className="font-mono font-bold">{phase5Audit.summary.historicalBaleRecostRuns}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">
              Direct mix links: {phase5Audit.summary.balesLinkedDirectlyToMix};
              through pressing: {phase5Audit.summary.balesLinkedViaPressing}.
              No linked mismatch means no comparable evidence, not proof that unlinked bale costs are accurate.
              {phase5Audit.summary.inventoryCutoverActive
                ? " A perpetual-inventory cutover is active; atomic GL journal approval is required."
                : " No active perpetual-inventory cutover was found in this snapshot."}
            </p>
            {phase5Audit.summary.consumedMixesWithoutLineage > 0 && (
              <div className="space-y-1 text-xs">
                <p className="font-semibold">Historical recost blocked pending production evidence</p>
                {phase5Audit.batches
                  .filter((batch) => batch.classification === "NO_RECORDED_PRODUCTION_LINEAGE")
                  .slice(0, 10).map((batch) => (
                    <p key={batch.batchId} className="font-mono text-muted-foreground">
                      {batch.batchCode} · {formatNumber(Number(batch.usedKg), 3)} kg used · no linked output
                    </p>
                  ))}
                <p className="text-muted-foreground">Export Bale/GL CSV for the full batch list and exception classification.</p>
              </div>
            )}
          </div>
        )}
        {phase4Audit && (
          <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-phase4-audit-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Phase 4 · Raw Material & Ownership Reconciliation</p>
              <span className="text-xs text-muted-foreground">Read-only · {phase4Audit.generatedAt.slice(0, 10)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Receipt-row overdraws</p><p className="font-mono font-bold">{phase4Audit.summary.rawStockOverdrawRows}</p></div>
              <div><p className="text-xs text-muted-foreground">Overdrawn kg</p><p className="font-mono font-bold">{formatNumber(Number(phase4Audit.summary.totalRawRowOverdrawKg))}</p></div>
              <div><p className="text-xs text-muted-foreground">Source ownership reviews</p><p className="font-mono font-bold">{phase4Audit.summary.ownershipSourceExceptions}</p></div>
              <div><p className="text-xs text-muted-foreground">Unclassified valued ADDs</p><p className="font-mono font-bold">{phase4Audit.summary.unclassifiedValuedAdds}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">
              Receipt-row negative balances can be covered by recorded supplier ADD adjustments.
              Historical ownership and currency corrections require original supporting evidence; no automatic changes are made.
            </p>
            {phase4Audit.rawStockExceptions.map((stock) => (
              <p className="text-xs text-muted-foreground" key={stock.rawStockId}>
                <span className="font-mono text-foreground">{stock.containerNumber ?? `Raw stock #${stock.rawStockId}`}</span>
                {" · "}Excess {formatNumber(Number(stock.excessUsedKg))} kg
                {" · "}{stock.supplierCoverage === "POTENTIALLY_ADJUSTMENT_BACKED" ? "Potentially ADD-backed" : "Supplier shortage review"}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              {phase4Audit.summary.ownershipAffectedBatches} batches have ownership references to verify;
              {phase4Audit.summary.unclassifiedNonUsdAdds > 0 ? ` ${phase4Audit.summary.unclassifiedNonUsdAdds} valued ADD requires non-USD FX evidence.` : ""}
              {" "}Export the three CSV files for the full exception records.
            </p>
          </div>
        )}
        {historicalAudit && (
          <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-historical-audit-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Historical Reconciliation Snapshot</p>
              <span className="text-xs text-muted-foreground">
                {historicalAudit.summary.activeBatches} active · {historicalAudit.summary.deletedBatches} deleted · {historicalAudit.summary.sources} saved sources
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Header discrepancies</p><p className="font-mono font-bold">{historicalAudit.summary.headerMismatchBatches}</p></div>
              <div><p className="text-xs text-muted-foreground">Cost arithmetic flags</p><p className="font-mono font-bold">{historicalAudit.summary.sourceLineMismatchBatches}</p></div>
              <div><p className="text-xs text-muted-foreground">Source evidence review</p><p className="font-mono font-bold">{historicalAudit.summary.evidenceReviewBatches}</p></div>
              <div><p className="text-xs text-muted-foreground">Current-rate differences</p><p className="font-mono font-bold">{historicalAudit.summary.currentRateEstimateDifferenceBatches}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">
              Current supplier rates can change after offload. Differences from recorded historical rates are informational,
              not permission to overwrite a batch. Export the source CSV to investigate individual records.
            </p>
            {historicalAudit.batches.filter((b) => !b.deleted && (b.classification === "ARITHMETIC_ERROR" || b.classification === "EVIDENCE_REVIEW")).length > 0 && (
              <div className="space-y-1 text-xs">
                <p className="font-semibold">Batches requiring evidence or mathematical correction review</p>
                {historicalAudit.batches
                  .filter((b) => !b.deleted && (b.classification === "ARITHMETIC_ERROR" || b.classification === "EVIDENCE_REVIEW"))
                  .slice(0, 12)
                  .map((b) => (
                    <p key={b.batchId} className="text-muted-foreground">
                      <span className="font-mono text-foreground">{b.batchCode}</span>
                      {" · "}{[...new Set(b.issues.filter((issue) => issue.severity !== "informational").map((issue) => issue.code))].join(", ")}
                    </p>
                  ))}
                <p className="text-muted-foreground">All flagged records, including deleted batches, are available in the CSV exports.</p>
              </div>
            )}
          </div>
        )}
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : mixBatches.length > 0 ? (
          <>
            <div className="space-y-3 md:hidden phone-land:block" data-testid="mix-batch-mobile-list">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-muted/25 p-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Weight</div>
                  <div className="mt-0.5 font-mono text-sm font-bold" data-testid="text-mix-mobile-summary-total">
                    {fmtKg(sumTotal)} kg
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Blended Cost</div>
                  <div className="mt-0.5 font-mono text-sm font-bold" data-testid="text-mix-mobile-summary-cost">
                    ${blendedCost.toFixed(4)}/kg
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Used</div>
                  <div className="mt-0.5 font-mono text-xs font-medium">{fmtKg(sumUsed)} kg</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining</div>
                  <div className="mt-0.5 font-mono text-xs font-medium">{fmtKg(sumRemaining)} kg</div>
                </div>
              </div>

              {visibleMixBatches.map((batch) => {
                const total = parseFloat(batch.totalWeightKg) || 0;
                const used = parseFloat(batch.usedKg) || 0;
                const remaining = parseFloat(batch.remainingKg) || 0;
                const cost = recordedMixBatchCost(batch).costPerKg;
                return (
                  <div
                    key={`mobile-${batch.id}`}
                    className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm"
                    data-testid={`card-mix-batch-mobile-${batch.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => onViewDetail(batch)}
                        data-testid={`link-mix-batch-mobile-${batch.id}`}
                      >
                        <div className="break-all font-mono text-sm font-semibold text-primary">{batch.batchCode}</div>
                        <div className="mt-0.5 wrap-break-word text-xs text-muted-foreground">
                          {batch.name || "Unnamed batch"}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {batch.batchDate ? formatDisplayDate(batch.batchDate) : formatDisplayDate(batch.createdAt)}
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onEdit(batch)}
                          disabled={!recordChanges.allowed}
                          title={recordChangeReason}
                          aria-label={recordChanges.reason ?? `Edit ${batch.batchCode}`}
                          data-testid={`button-edit-mix-batch-mobile-${batch.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onDelete(batch.id)}
                          disabled={!recordChanges.allowed}
                          title={recordChangeReason}
                          aria-label={recordChanges.reason ?? `Delete ${batch.batchCode}`}
                          data-testid={`button-delete-mix-batch-mobile-${batch.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</div>
                        <div className="mt-0.5 font-mono font-semibold">{formatNumber(total)} kg</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost / kg</div>
                        <div className="mt-0.5 font-mono font-semibold">${cost.toFixed(4)}</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Used</div>
                        <div className="mt-0.5 font-mono font-medium">{fmtKg(used)} kg</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining</div>
                        <div className="mt-0.5 font-mono font-medium">{fmtKg(remaining)} kg</div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {mixBatches.length > BATCH_PREVIEW_COUNT && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAllMixBatches(!showAllMixBatches)}
                  data-testid="button-toggle-show-all-batches-mobile"
                  className="w-full text-xs"
                >
                  {showAllMixBatches
                    ? "Show less"
                    : `Show all ${mixBatches.length} batches (${mixBatches.length - BATCH_PREVIEW_COUNT} hidden)`}
                </Button>
              )}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-border/70 md:block phone-land:hidden">
              <Table>
                <TableHeader className="bg-slate-100/80 dark:bg-slate-800/70">
                  <TableRow>
                    <TableHead className="min-w-40">Batch Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="min-w-32 whitespace-nowrap">Date</TableHead>
                    <TableHead className="min-w-32 text-right whitespace-nowrap">Total (kg)</TableHead>
                    <TableHead className="min-w-36 text-right whitespace-nowrap">Recorded Cost/kg</TableHead>
                    <TableHead className="min-w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMixBatches.map((batch) => {
                    const total = parseFloat(batch.totalWeightKg) || 0;
                    return (
                      <TableRow
                        key={batch.id}
                        className="even:bg-muted/15 transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-400/5"
                        data-testid={`row-mix-batch-${batch.id}`}
                      >
                        <TableCell
                          className="font-mono font-medium text-sm cursor-pointer hover:underline text-primary"
                          onClick={() => onViewDetail(batch)}
                          data-testid={`link-mix-batch-detail-${batch.id}`}
                        >
                          {batch.batchCode}
                        </TableCell>
                        <TableCell
                          className="text-sm cursor-pointer hover:underline"
                          onClick={() => onViewDetail(batch)}
                        >
                          {batch.name || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {batch.batchDate ? formatDisplayDate(batch.batchDate) : formatDisplayDate(batch.createdAt)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(total)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          ${recordedMixBatchCost(batch).costPerKg.toFixed(4)}/kg
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => onEdit(batch)}
                              disabled={!recordChanges.allowed}
                              title={recordChangeReason}
                              aria-label={recordChangeReason}
                              data-testid={`button-edit-mix-batch-${batch.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => onDelete(batch.id)}
                              disabled={!recordChanges.allowed}
                              title={recordChangeReason}
                              aria-label={recordChangeReason}
                              data-testid={`button-delete-mix-batch-${batch.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                {mixBatches.length > BATCH_PREVIEW_COUNT && (
                  <tbody>
                    <tr>
                      <td colSpan={6} className="py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllMixBatches(!showAllMixBatches)}
                          data-testid="button-toggle-show-all-batches"
                          className="text-xs text-muted-foreground"
                        >
                          {showAllMixBatches
                            ? "Show less"
                            : `Show all ${mixBatches.length} batches (${mixBatches.length - BATCH_PREVIEW_COUNT} hidden)`}
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                )}
                <tfoot className="border-t-2 border-border bg-slate-100/60 dark:bg-slate-800/50">
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="px-4 py-3 text-sm font-semibold text-foreground">
                      Combined Total
                      <div className="text-xs text-muted-foreground font-normal mt-0.5">
                        {mixBatches.length} batch{mixBatches.length !== 1 ? "es" : ""}
                        {" · "}Used: {fmtKg(sumUsed)}
                        {" · "}Remaining: {fmtKg(sumRemaining)}
                      </div>
                    </TableCell>
                    <TableCell
                      className="px-4 py-3 text-right font-mono font-semibold text-sm"
                      data-testid="text-mix-summary-total"
                    >
                      {fmtKg(sumTotal)}
                    </TableCell>
                    <TableCell
                      className="px-4 py-3 text-right font-mono font-semibold text-sm"
                      data-testid="text-mix-summary-cost"
                    >
                      ${blendedCost.toFixed(4)}/kg
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </tfoot>
              </Table>
            </div>
          </>
        ) : (
          <div className="text-center py-10">
            <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
            <h3 className="mt-3 text-base font-semibold">No mix batches</h3>
            <p className="text-muted-foreground text-sm mt-1">No mix batches yet. Create one to get started.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
