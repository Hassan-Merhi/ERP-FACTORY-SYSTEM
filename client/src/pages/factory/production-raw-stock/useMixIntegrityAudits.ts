import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

export interface MixHistoricalAuditPreview {
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

export interface MixPhase4Audit {
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
    rawStockId: number;
    containerNumber: string | null;
    excessUsedKg: string;
    supplierCoverage: string;
  }>;
  ownershipExceptions: Array<{
    sourceId: number;
    batchCode: string;
    pricingSupplierId: number | null;
    recordedInventorySupplierId: number | null;
    currentContainerSupplierId: number | null;
  }>;
  adjustmentEvidence: Array<{
    adjustmentId: number;
    supplierName: string | null;
    date: string;
    kg: string;
    currency: string;
    classification: string;
  }>;
}

export interface MixPhase5Audit {
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

export interface MixPhase6LifecycleAudit {
  generatedAt: string;
  readOnly: true;
  summary: {
    allBatches: number;
    activeBatches: number;
    completedWithRemainderBatches: number;
    completedRemainderKg: string;
    completedRemainderPotentialValueUsd: string;
    overusedBatches: number;
    overusedKg: string;
    carryForwardBatches: number;
    carryForwardExceptions: number;
    batchesWithDailyUsage: number;
  };
  batches: Array<{
    batchId: number;
    batchCode: string;
    status: string;
    deleted: boolean;
    totalKg: string;
    usedKg: string;
    remainingKg: string;
    classification: string;
    issues: Array<{ code: string; severity: string; detail: string }>;
  }>;
}

export interface MixPhase7MonitorStatus {
  companyId: number;
  initialized: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  summary: {
    critical: number;
    warning: number;
    review: number;
    total: number;
    suppressedCurrentRateDrift: boolean;
  } | null;
  unreadAlerts: number;
  monitoringEnabled: boolean;
  nextCheck: string;
  legacyBaselinePolicy: string;
}

/**
 * State and actions for the read-only Factory mix integrity audits (historical
 * valuation, raw-stock provenance, downstream cost, lifecycle and the nightly
 * monitor). Nothing here writes mix, stock or accounting data.
 */
export function useMixIntegrityAudits({
  canAuditHistoricalMixes,
  monitorCompanyId,
}: {
  canAuditHistoricalMixes: boolean;
  monitorCompanyId: number | null;
}) {
  const { toast } = useToast();
  const [isAuditingMixes, setIsAuditingMixes] = useState(false);
  const [auditExportLevel, setAuditExportLevel] = useState<"batches" | "sources" | null>(null);
  const [historicalAudit, setHistoricalAudit] = useState<MixHistoricalAuditPreview | null>(null);
  const [phase4Audit, setPhase4Audit] = useState<MixPhase4Audit | null>(null);
  const [phase5Audit, setPhase5Audit] = useState<MixPhase5Audit | null>(null);
  const [phase6Audit, setPhase6Audit] = useState<MixPhase6LifecycleAudit | null>(null);
  const [phase7Monitor, setPhase7Monitor] = useState<MixPhase7MonitorStatus | null>(null);
  const [monitorRefreshError, setMonitorRefreshError] = useState<string | null>(null);
  const [isRefreshingMonitor, setIsRefreshingMonitor] = useState(false);
  const [isAuditingLifecycle, setIsAuditingLifecycle] = useState(false);
  const [isExportingLifecycle, setIsExportingLifecycle] = useState(false);
  const [isAuditingDownstream, setIsAuditingDownstream] = useState(false);
  const [isExportingDownstream, setIsExportingDownstream] = useState(false);
  const [isAuditingProvenance, setIsAuditingProvenance] = useState(false);
  const [provenanceExport, setProvenanceExport] = useState<"stock" | "ownership" | "adjustments" | null>(null);

  // The monitor is persisted by the scheduler, not re-run from this page.
  // Refreshing this small status never starts heavy reconciliation SQL.
  useEffect(() => {
    setPhase7Monitor(null);
    setMonitorRefreshError(null);
    if (!canAuditHistoricalMixes || !monitorCompanyId) return;
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/factory/mix-batches?profile=integrity-monitor", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Monitor status unavailable.");
        const data = (await response.json()) as MixPhase7MonitorStatus;
        if (active) {
          setPhase7Monitor(data);
          setMonitorRefreshError(null);
        }
      } catch (error) {
        if (active) setMonitorRefreshError(error instanceof Error ? error.message : "Monitor status unavailable.");
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 300_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [canAuditHistoricalMixes, monitorCompanyId]);

  const handleRefreshMonitor = async () => {
    setIsRefreshingMonitor(true);
    try {
      const response = await fetch("/api/factory/mix-batches?profile=integrity-monitor", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not retrieve Factory mix monitor status.");
      const data = (await response.json()) as MixPhase7MonitorStatus;
      if (data.companyId !== monitorCompanyId) throw new Error("Company changed during monitor refresh.");
      setPhase7Monitor(data);
      setMonitorRefreshError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please retry.";
      setMonitorRefreshError(message);
      toast({ title: "Integrity status unavailable", description: message, variant: "destructive" });
    } finally {
      setIsRefreshingMonitor(false);
    }
  };

  const handleRunHistoricalAudit = async () => {
    setIsAuditingMixes(true);
    try {
      const res = await fetch("/api/factory/mix-batches?profile=historical-audit&includeSources=false", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Could not load the historical audit.");
      setHistoricalAudit((await res.json()) as MixHistoricalAuditPreview);
      toast({
        title: "Historical audit ready",
        description: "All active and deleted mix batches were checked without changing any records.",
      });
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
      await downloadFromUrl("/api/factory/mix-batches?profile=historical-audit&format=csv&level=" + level, {
        fileName: exportFileName("factory mix historical " + level + " audit", "csv"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setAuditExportLevel(null);
    }
  };

  const handleRunProvenanceAudit = async () => {
    setIsAuditingProvenance(true);
    try {
      const res = await fetch("/api/factory/mix-batches?profile=raw-provenance-audit", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Unable to load the raw-material provenance report.");
      setPhase4Audit((await res.json()) as MixPhase4Audit);
      toast({
        title: "Raw stock and supplier audit ready",
        description: "No inventory, pricing or accounting values were changed.",
      });
    } catch (error) {
      toast({
        title: "Provenance audit failed",
        description: error instanceof Error ? error.message : "Please retry.",
        variant: "destructive",
      });
    } finally {
      setIsAuditingProvenance(false);
    }
  };

  const handleDownloadProvenanceAudit = async (section: "stock" | "ownership" | "adjustments") => {
    setProvenanceExport(section);
    try {
      await downloadFromUrl("/api/factory/mix-batches?profile=raw-provenance-audit&format=csv&section=" + section, {
        fileName: exportFileName("factory mix " + section + " audit", "csv"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setProvenanceExport(null);
    }
  };

  const handleRunDownstreamAudit = async () => {
    setIsAuditingDownstream(true);
    try {
      const response = await fetch("/api/factory/mix-batches?profile=downstream-audit", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load production/bale/GL reconciliation.");
      setPhase5Audit((await response.json()) as MixPhase5Audit);
      toast({
        title: "Bale & GL audit ready",
        description: "All mixes were checked without changing costs, sales or accounting.",
      });
    } catch (error) {
      toast({
        title: "Bale & GL audit failed",
        description: error instanceof Error ? error.message : "Please retry.",
        variant: "destructive",
      });
    } finally {
      setIsAuditingDownstream(false);
    }
  };

  const handleExportDownstreamAudit = async () => {
    setIsExportingDownstream(true);
    try {
      await downloadFromUrl("/api/factory/mix-batches?profile=downstream-audit&format=csv", {
        fileName: exportFileName("factory mix downstream audit", "csv"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExportingDownstream(false);
    }
  };

  const handleRunLifecycleAudit = async () => {
    setIsAuditingLifecycle(true);
    try {
      const response = await fetch("/api/factory/mix-batches?profile=lifecycle-audit", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Cannot load the used-kg and carry-forward reconciliation.");
      setPhase6Audit((await response.json()) as MixPhase6LifecycleAudit);
      toast({
        title: "Mix lifecycle audit ready",
        description: "The full active and deleted batch history was inspected without changing quantities.",
      });
    } catch (error) {
      toast({
        title: "Lifecycle audit failed",
        description: error instanceof Error ? error.message : "Please retry.",
        variant: "destructive",
      });
    } finally {
      setIsAuditingLifecycle(false);
    }
  };

  const handleExportLifecycleAudit = async () => {
    setIsExportingLifecycle(true);
    try {
      await downloadFromUrl("/api/factory/mix-batches?profile=lifecycle-audit&format=csv", {
        fileName: exportFileName("factory mix lifecycle audit", "csv"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExportingLifecycle(false);
    }
  };

  return {
    canAuditHistoricalMixes,
    monitorCompanyId,
    isAuditingMixes,
    setIsAuditingMixes,
    auditExportLevel,
    setAuditExportLevel,
    historicalAudit,
    setHistoricalAudit,
    phase4Audit,
    setPhase4Audit,
    phase5Audit,
    setPhase5Audit,
    phase6Audit,
    setPhase6Audit,
    phase7Monitor,
    setPhase7Monitor,
    monitorRefreshError,
    setMonitorRefreshError,
    isRefreshingMonitor,
    setIsRefreshingMonitor,
    isAuditingLifecycle,
    setIsAuditingLifecycle,
    isExportingLifecycle,
    setIsExportingLifecycle,
    isAuditingDownstream,
    setIsAuditingDownstream,
    isExportingDownstream,
    setIsExportingDownstream,
    isAuditingProvenance,
    setIsAuditingProvenance,
    provenanceExport,
    setProvenanceExport,
    handleRefreshMonitor,
    handleRunHistoricalAudit,
    handleDownloadHistoricalAudit,
    handleRunProvenanceAudit,
    handleDownloadProvenanceAudit,
    handleRunDownstreamAudit,
    handleExportDownstreamAudit,
    handleRunLifecycleAudit,
    handleExportLifecycleAudit,
  };
}

export type MixIntegrityAudits = ReturnType<typeof useMixIntegrityAudits>;
