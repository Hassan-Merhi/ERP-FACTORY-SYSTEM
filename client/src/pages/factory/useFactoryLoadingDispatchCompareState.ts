// Extracted from ./FactoryLoadingDispatchCompare.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { DispatchOrderReconciliation } from "./FactoryDispatchOrderFinancialReview";
import { Comparison, Filter, getComparison, PAGE_SIZE } from "./FactoryLoadingDispatchCompareParts";

export function useFactoryLoadingDispatchCompareState() {
  const { orderId: orderIdText, dispatchId: dispatchIdText } = useParams<{ orderId: string; dispatchId?: string }>();
  const orderId = Number(orderIdText);
  const dispatchId = dispatchIdText ? Number(dispatchIdText) : null;
  const valid =
    Number.isSafeInteger(orderId) &&
    orderId > 0 &&
    (dispatchId === null || (Number.isSafeInteger(dispatchId) && dispatchId > 0));
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedMissing, setSelectedMissing] = useState<number[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removalReason, setRemovalReason] = useState("");
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const { toast } = useToast();
  const { data: auth } = useQuery<{
    currentCompanyId?: number | null;
    currentRole?: string | null;
    role?: string | null;
  }>({ queryKey: ["/api/auth/me"] });
  const companyId = auth?.currentCompanyId;
  const url =
    "/api/factory/customer-orders/" +
    orderId +
    "/loading-dispatches" +
    (dispatchId ? "/" + dispatchId : "") +
    "/comparison";
  const comparison = useQuery<Comparison>({
    queryKey: companyQueryKey(url, companyId),
    queryFn: () => getComparison(url),
    enabled: valid && Boolean(companyId),
    refetchInterval: 5000,
  });
  const reconciliationUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/order-reconciliation";
  const financialReconciliation = useQuery<DispatchOrderReconciliation>({
    queryKey: companyQueryKey(reconciliationUrl, companyId),
    queryFn: async () => {
      const response = await fetch(reconciliationUrl, { credentials: "include", cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Unable to read financial reconciliation");
      return data as DispatchOrderReconciliation;
    },
    enabled: valid && Boolean(companyId) && dispatchId === null,
    refetchInterval: removeOpen ? false : 10000,
  });
  const refreshAllReconciliation = () => {
    void financialReconciliation.refetch();
    void comparison.refetch();
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(reconciliationUrl, companyId) });
  };
  const result = comparison.data;
  const s = result?.summary;
  const articles = useMemo(() => result?.articles ?? [], [result?.articles]);
  const selectedId = dispatchId === null ? undefined : String(dispatchId);
  const missingFromLoading = (result?.missingBales ?? []).filter(
    (bale) => Number.isSafeInteger(bale.orderBaleId) && Number(bale.orderBaleId) > 0
  );
  const allTripsEnded =
    Boolean(result?.trips.length) && (result?.trips.every((trip) => trip.status !== "OPEN") ?? false);
  const isSupervisor = ["admin", "owner", "developer"].includes((auth?.currentRole ?? auth?.role ?? "").toLowerCase());
  const canReconcile =
    !selectedId &&
    allTripsEnded &&
    ["LOADING", "PENDING_VERIFICATION"].includes(result?.loadingStatus ?? "") &&
    isSupervisor &&
    Boolean(financialReconciliation.data) &&
    !financialReconciliation.data?.approval &&
    financialReconciliation.data?.fingerprint !== undefined &&
    (financialReconciliation.data?.summary.unshippedBales ?? 0) > 0 &&
    financialReconciliation.data?.summary.duplicateScans === 0 &&
    financialReconciliation.data?.summary.unexpectedScans === 0;
  const selectedCurrent = selectedMissing.filter((id) => missingFromLoading.some((bale) => bale.orderBaleId === id));
  const selectedBales = missingFromLoading.filter((bale) => selectedCurrent.includes(bale.orderBaleId!));
  const selectedKg = selectedBales.reduce((sum, bale) => sum + (Number(bale.weightKg) || 0), 0);
  const selectAllMissing = () => {
    setSelectedMissing(
      selectedCurrent.length === missingFromLoading.length ? [] : missingFromLoading.map((bale) => bale.orderBaleId!)
    );
  };
  const removeSelected = async () => {
    const fin = financialReconciliation.data;
    if (
      !canReconcile ||
      removing ||
      !fin ||
      selectedCurrent.length === 0 ||
      !removeConfirmed ||
      removalReason.trim().length < 10
    )
      return;
    setRemoving(true);
    try {
      // One signed, all-or-nothing database transaction. Never issue a
      // sequence of legacy DELETE calls that could partially remove a load.
      const response = await apiRequest("POST", reconciliationUrl + "/remove-unshipped", {
        confirm: true,
        orderBaleIds: selectedCurrent,
        expectedFingerprint: fin.fingerprint,
        reason: removalReason.trim(),
      });
      const result = (await response.json()) as { removed: number; remainingUnshipped: number };
      toast({
        title: "Unshipped bales reconciled",
        description:
          result.removed +
          " bale(s) returned to stock in one transaction. " +
          result.remainingUnshipped +
          " still unshipped.",
      });
      setSelectedMissing([]);
      setRemovalReason("");
      setRemoveConfirmed(false);
      setRemoveOpen(false);
      void queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/customer-orders/" + orderId, companyId),
      });
    } catch (error) {
      toast({
        title: "No partial removal committed",
        description: error instanceof Error ? error.message : "Reconciliation failed",
        variant: "destructive",
      });
    } finally {
      setRemoving(false);
      refreshAllReconciliation();
    }
  };

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return articles.filter((article) => {
      if (filter === "missing" && !((article.missingQty ?? 0) > 0)) return false;
      if (filter === "extra" && article.extraQty <= 0) return false;
      if (filter === "match" && article.status !== "MATCH") return false;
      if (filter === "unplanned" && article.status !== "UNPLANNED") return false;
      return (
        !query || article.articleCode.toLowerCase().includes(query) || article.productName.toLowerCase().includes(query)
      );
    });
  }, [articles, filter, search]);
  return {
    allTripsEnded,
    canReconcile,
    companyId,
    comparison,
    filter,
    financialReconciliation,
    isSupervisor,
    missingFromLoading,
    navigate,
    orderId,
    refreshAllReconciliation,
    removalReason,
    removeConfirmed,
    removeOpen,
    removeSelected,
    removing,
    result,
    rows,
    s,
    search,
    selectAllMissing,
    selectedCurrent,
    selectedId,
    selectedKg,
    setFilter,
    setRemovalReason,
    setRemoveConfirmed,
    setRemoveOpen,
    setSearch,
    setSelectedMissing,
    setVisibleCount,
    valid,
    visibleCount,
  };
}
