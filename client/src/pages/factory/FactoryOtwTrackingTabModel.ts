// Extracted from ./FactoryOtwTrackingTab.tsx: state, queries and handlers for FactoryOtwTrackingTab.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient as useTQClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { ContainerWithSupplier } from "./factoryotwtrackingtab/types";
import { STATUS_ACTIVE, calcDelayDays, ccySym, containerCost, isOverdue, num } from "./factoryotwtrackingtab/utils";
import { useOtwCsvTools } from "./factoryotwtrackingtab/hooks/useOtwCsvTools";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { AuthMe } from "@shared/apiTypes";

export function useFactoryOtwTrackingTabModel() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const tqClient = useTQClient();
  // ETA, docs and notes edit existing containers; read-only roles see them without editors.
  const recordChanges = useExistingRecordChangeAccess();
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [freightFilter, setFreightFilter] = useState<string>("all");
  const [weightFilter, setWeightFilter] = useState<string>("all");
  const [docsFilter, setDocsFilter] = useState<string>("all");
  const [delayedFilter, setDelayedFilter] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<string>("DEFAULT");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [detailedView, setDetailedView] = useState(false);
  // Use activeOnly=true so the backend pre-filters to PENDING/IN_TRANSIT/ARRIVED.
  // Canonical scoped query key retains the URL-first prefix for invalidations.
  const { data: containers, isLoading } = useQuery<ContainerWithSupplier[]>({
    queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id, "otw"),
    queryFn: async () => {
      const res = await fetch("/api/factory/containers?activeOnly=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch containers");
      return res.json();
    },
  });
  const otwContainers = (containers || []).filter((c) => STATUS_ACTIVE.has(c.status));
  // Supplier list for filter
  const suppliers = Array.from(
    new Map(otwContainers.map((c) => [String(c.supplierId ?? "none"), c.supplierName || "No Supplier"])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));
  // Apply filters + sort
  let filtered = otwContainers.filter((c) => {
    if (supplierFilter !== "all" && String(c.supplierId ?? "none") !== supplierFilter) return false;
    if (freightFilter === "has_freight" && !(num(c.freight) > 0)) return false;
    if (freightFilter === "no_freight" && num(c.freight) > 0) return false;
    if (weightFilter === "has_weight" && !(num(c.totalKg) > 0)) return false;
    if (weightFilter === "no_weight" && num(c.totalKg) > 0) return false;
    if (docsFilter === "received" && !c.otwDocsReceived) return false;
    if (docsFilter === "not_received" && !!c.otwDocsReceived) return false;
    if (delayedFilter === "delayed" && calcDelayDays(c) === 0) return false;
    if (delayedFilter === "overdue" && !isOverdue(c)) return false;
    if (delayedFilter === "on_time" && (!c.arrivalDate || isOverdue(c))) return false;
    if (delayedFilter === "eta_missing" && !!c.arrivalDate) return false;
    if (search.trim()) {
      if (!searchAny(search, c.containerNumber, c.supplierName)) return false;
    }
    return true;
  });
  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sortOrder === "ETA_ASC" || sortOrder === "ETA_DESC") {
      const da = a.arrivalDate ? new Date(a.arrivalDate).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
      const db = b.arrivalDate ? new Date(b.arrivalDate).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
      if (da !== db) return sortOrder === "ETA_ASC" ? da - db : db - da;
    }
    const sa = (a.supplierName || "").toLowerCase();
    const sb = (b.supplierName || "").toLowerCase();
    return sa.localeCompare(sb);
  });
  // Summary stats
  const inTransit = otwContainers.filter((c) => c.status === "IN_TRANSIT").length;
  const arrived = otwContainers.filter((c) => c.status === "ARRIVED").length;
  const delayed = otwContainers.filter((c) => calcDelayDays(c) > 0).length;
  // Cost totals grouped by currency
  const costByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const { symbol, amount } = containerCost(c);
    const ccy = c.currencyCode || "USD";
    if (amount > 0) {
      if (!acc[ccy]) acc[ccy] = { symbol, amount: 0 };
      acc[ccy].amount += amount;
    }
    return acc;
  }, {});
  // Freight totals grouped by currency
  const freightByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const freightAmt = num(c.freight);
    if (freightAmt <= 0) return acc;
    const ccy = c.freightCurrencyCode || c.currencyCode || "USD";
    const sym = ccySym(ccy);
    if (!acc[ccy]) acc[ccy] = { symbol: sym, amount: 0 };
    acc[ccy].amount += freightAmt;
    return acc;
  }, {});
  // Commission totals grouped by currency — there's no dedicated Commission KPI card;
  // instead its USD portion is folded into the "Total (USD)" card below so that card
  // represents the full USD balance (container cost + freight + commission), matching
  // how "Total (USD)" already implicitly combines cost-in-USD across containers.
  const commissionByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const commAmt = num(c.commissionAmount);
    if (commAmt <= 0) return acc;
    const ccy = c.commissionCurrencyCode || "USD";
    const sym = ccySym(ccy);
    if (!acc[ccy]) acc[ccy] = { symbol: sym, amount: 0 };
    acc[ccy].amount += commAmt;
    return acc;
  }, {});
  // "Total (USD)" = USD-priced container cost + USD freight + USD commission.
  // Other currencies' Total cards are left as cost-only (freight/commission for those
  // currencies already appear on their own Freight (CCY) card, and commission has no
  // separate card at all, per request — its USD amount rolls into Total (USD) instead).
  const totalByCurrencyWithUsdBalance: Record<string, { symbol: string; amount: number }> = { ...costByCurrency };
  {
    const usdFreight = freightByCurrency.USD?.amount || 0;
    const usdCommission = commissionByCurrency.USD?.amount || 0;
    const extraUsd = usdFreight + usdCommission;
    if (extraUsd > 0) {
      const existing = totalByCurrencyWithUsdBalance.USD;
      totalByCurrencyWithUsdBalance.USD = {
        symbol: existing?.symbol || ccySym("USD"),
        amount: (existing?.amount || 0) + extraUsd,
      };
    }
  }
  const docsReceived = filtered.filter((c) => !!c.otwDocsReceived).length;
  const totalWeight = filtered.reduce((sum, c) => sum + num(c.totalKg), 0);
  const onTime = otwContainers.filter((c) => !!c.arrivalDate && !isOverdue(c)).length;
  const missingEta = otwContainers.filter((c) => !c.arrivalDate).length;
  const activeFilterCount =
    [supplierFilter, freightFilter, weightFilter, docsFilter, delayedFilter].filter((v) => v !== "all").length +
    (search.trim() ? 1 : 0) +
    (sortOrder !== "DEFAULT" ? 1 : 0);
  /** Immediately patch the in-memory cache entry so the UI reflects the new
   *  value without waiting for the background refetch to complete. */
  function patchCacheContainer(id: number, patch: Partial<ContainerWithSupplier>) {
    tqClient.setQueriesData<ContainerWithSupplier[]>(
      { queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id) },
      (old) => old?.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  }
  async function saveNote(id: number, val: string) {
    if (!recordChanges.allowed) return;
    try {
      await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, { otwNote: val || null });
      patchCacheContainer(id, { otwNote: val || null });
      tqClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id) });
    } catch (err) {
      toast({
        title: "Failed to save note",
        description: getErrorDetails(err).optionalMessage,
        variant: "destructive",
      });
    }
  }
  async function toggleDoc(id: number, checked: boolean) {
    if (!recordChanges.allowed) return;
    try {
      await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, { otwDocsReceived: checked });
      patchCacheContainer(id, { otwDocsReceived: checked });
      tqClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id) });
    } catch (err) {
      toast({
        title: "Failed to update docs",
        description: getErrorDetails(err).optionalMessage,
        variant: "destructive",
      });
    }
  }
  const etaMutation = useMutation({
    mutationFn: async ({ id, arrivalDate }: { id: number; arrivalDate: string | null }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, {
        arrivalDate: arrivalDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to update ETA");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      patchCacheContainer(variables.id, { arrivalDate: variables.arrivalDate });
      tqClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id) });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to update ETA", description: err?.message, variant: "destructive" });
    },
  });
  function saveEta(id: number, val: string | null) {
    etaMutation.mutate({ id, arrivalDate: val });
  }
  function clearFilters() {
    setSearch("");
    setSupplierFilter("all");
    setFreightFilter("all");
    setWeightFilter("all");
    setDocsFilter("all");
    setDelayedFilter("all");
    setSortOrder("DEFAULT");
  }
  const { importing, exportCsv, handleImportFile, canImport } = useOtwCsvTools(filtered, otwContainers);

  return {
    toast,
    recordChanges,
    currentUser,
    supplierFilter,
    setSupplierFilter,
    freightFilter,
    setFreightFilter,
    weightFilter,
    setWeightFilter,
    docsFilter,
    setDocsFilter,
    delayedFilter,
    setDelayedFilter,
    sortOrder,
    setSortOrder,
    search,
    setSearch,
    showFilters,
    setShowFilters,
    detailedView,
    setDetailedView,
    isLoading,
    otwContainers,
    suppliers,
    filtered,
    inTransit,
    arrived,
    delayed,
    freightByCurrency,
    totalByCurrencyWithUsdBalance,
    docsReceived,
    totalWeight,
    onTime,
    missingEta,
    activeFilterCount,
    saveNote,
    toggleDoc,
    saveEta,
    clearFilters,
    importing,
    exportCsv,
    handleImportFile,
    canImport,
  };
}

export type FactoryOtwTrackingTabModel = ReturnType<typeof useFactoryOtwTrackingTabModel>;
