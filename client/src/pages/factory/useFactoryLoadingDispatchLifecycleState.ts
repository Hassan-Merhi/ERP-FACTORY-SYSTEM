// Extracted from ./FactoryLoadingDispatchLifecycle.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryActionCapabilities } from "@shared/factoryActionCapabilities";
import { useCompany } from "@/contexts/CompanyContext";
import type { FactoryMyAccess } from "@shared/apiTypes";

interface ClosingSummary {
  expectedBales: number | null;
  verifiedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  verifiedWeightKg: number;
  expectedWeightKg: number | null;
  weightDifferenceKg: number | null;
}

interface ClosingIssue {
  code: string;
  label: string;
  count?: number;
}

interface ClosePreview {
  dispatchId: number;
  dispatchNumber: number;
  status: string;
  fingerprint: string;
  issues: ClosingIssue[];
  needsApproval: boolean;
  canCloseClean: boolean;
  hasAnyScans: boolean;
  summary: ClosingSummary;
}

interface Closure {
  id: number | string;
  revision: number;
  summary: ClosingSummary;
  issues: ClosingIssue[];
  approvedWithDiscrepancies: boolean;
  discrepancyReason: string | null;
  closedByUsername: string;
  closedAt: string;
  reopenedAt: string | null;
  reopenedByUsername: string | null;
  reopenReason: string | null;
}

interface AuditEvent {
  id: number | string;
  eventType: string;
  actorUsername: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface Lifecycle {
  trip: {
    id: number | string;
    status: string;
    dispatchNumber: number;
    closedAt: string | null;
    reopenedAt: string | null;
  };
  closures: Closure[];
  events: AuditEvent[];
  eventsLimitedTo: number;
}

interface FrozenSnapshot extends Closure {
  comparison: {
    articles: Array<{
      articleCode: string;
      expectedQty: number | null;
      scannedQty: number;
      missingQty: number | null;
      extraQty: number;
    }>;
    missingBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
    unexpectedBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
    crossTripBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
  };
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
  onChanged: () => void;
}

export function fmt(n: number | null | undefined, precision = 0) {
  return n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: precision });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected server error";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || "Could not load dispatch review");
  }
  return res.json() as Promise<T>;
}

export function useFactoryLoadingDispatchLifecycleState({
  orderId,
  dispatchId,
  companyId,
  status,
  role,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { data: access } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", companyId),
    enabled: Boolean(companyId) && selectedCompany?.id === companyId,
  });
  const { formatDisplayDateTime } = useDateFormat();
  const [, navigate] = useLocation();
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const previewUrl = base + "/close-preview";
  const lifecycleUrl = base + "/lifecycle";
  const capabilities = factoryActionCapabilities({
    role,
    hasFactoryAccess: Boolean(
      selectedCompany?.id === companyId && access?.companyId === companyId && access?.hasFactoryAccess
    ),
  });
  const supervisory = capabilities["dispatch.approve-discrepancy"];
  const canClose = capabilities["dispatch.close"] && status === "OPEN";
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [discrepancyReason, setDiscrepancyReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [frozenClosureId, setFrozenClosureId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const preview = useQuery<ClosePreview>({
    queryKey: companyQueryKey(previewUrl, companyId),
    queryFn: () => getJson<ClosePreview>(previewUrl),
    enabled: Boolean(companyId) && closeOpen && status === "OPEN",
    refetchInterval: closeOpen ? 10000 : false,
  });
  const history = useQuery<Lifecycle>({
    queryKey: companyQueryKey(lifecycleUrl, companyId),
    queryFn: () => getJson<Lifecycle>(lifecycleUrl),
    enabled: Boolean(companyId),
    refetchInterval: 15000,
  });
  const frozenUrl = frozenClosureId ? lifecycleUrl + "/closures/" + frozenClosureId : lifecycleUrl;
  const frozen = useQuery<FrozenSnapshot>({
    // Keep inactive snapshot state out of the lifecycle history query cache.
    queryKey: companyQueryKey(lifecycleUrl + "/closure-snapshot/" + (frozenClosureId ?? "none"), companyId),
    queryFn: () => getJson<FrozenSnapshot>(frozenUrl),
    enabled: Boolean(companyId) && Boolean(frozenClosureId),
  });

  const invalidate = () => {
    const listUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches";
    for (const url of [
      listUrl,
      base,
      base + "/scans",
      base + "/allocations",
      previewUrl,
      lifecycleUrl,
      base + "/comparison",
      listUrl + "/comparison",
    ]) {
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(url, companyId) });
    }
    onChanged();
  };

  const endMutation = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("Review current verification before ending this trip");
      const response = await apiRequest("POST", base + "/close", {
        confirm: true,
        fingerprint: preview.data.fingerprint,
        ...(preview.data.needsApproval ? { discrepancyReason: discrepancyReason.trim() } : {}),
      });
      return response.json() as Promise<{ revision: number; status: string; approvedWithDiscrepancies: boolean }>;
    },
    onSuccess: (data) => {
      setCloseOpen(false);
      setCloseConfirmed(false);
      setDiscrepancyReason("");
      invalidate();
      toast({
        title: "Dispatch ended and locked",
        description: "Closure #" + data.revision + " saved. The verification scans and plan are now read-only.",
      });
    },
    onError: (error) => {
      setCloseConfirmed(false);
      void preview.refetch();
      toast({ title: "Dispatch not ended", description: errorMessage(error), variant: "destructive" });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", base + "/reopen", { reason: reopenReason.trim() });
      return response.json() as Promise<{ status: string }>;
    },
    onSuccess: () => {
      setReopenOpen(false);
      setReopenReason("");
      invalidate();
      toast({ title: "Dispatch reopened", description: "The previous closure remains preserved in audit history." });
    },
    onError: (error) => {
      toast({ title: "Dispatch not reopened", description: errorMessage(error), variant: "destructive" });
    },
  });

  const s = preview.data?.summary;
  const issues = preview.data?.issues ?? [];
  const hasApproval = Boolean(preview.data?.needsApproval);
  const canConfirmEnd = Boolean(
    canClose &&
    closeConfirmed &&
    preview.data &&
    preview.data.status === "OPEN" &&
    preview.data.hasAnyScans &&
    (!hasApproval || (supervisory && discrepancyReason.trim().length >= 10 && discrepancyReason.trim().length <= 1000))
  );
  // Historical closure records may have incomplete snapshots. Never allow
  // missing review data to crash the active dispatch page.
  const closures = Array.isArray(history.data?.closures) ? history.data.closures : [];
  const latest = closures[0] ?? null;
  return {
    canClose,
    canConfirmEnd,
    capabilities,
    closeConfirmed,
    closeOpen,
    closures,
    companyId,
    discrepancyReason,
    dispatchId,
    endMutation,
    formatDisplayDateTime,
    frozen,
    frozenClosureId,
    hasApproval,
    history,
    issues,
    latest,
    navigate,
    orderId,
    preview,
    previewUrl,
    reopenMutation,
    reopenOpen,
    reopenReason,
    s,
    setCloseConfirmed,
    setCloseOpen,
    setDiscrepancyReason,
    setFrozenClosureId,
    setReopenOpen,
    setReopenReason,
    setShowHistory,
    showHistory,
    status,
    supervisory,
  };
}
