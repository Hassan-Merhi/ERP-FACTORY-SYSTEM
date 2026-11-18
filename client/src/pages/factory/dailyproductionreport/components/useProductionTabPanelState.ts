// Extracted from ./ProductionTabPanelSection.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FactoryMixBatch } from "@shared/schema";
import type { AuthMe } from "@shared/apiTypes";
import type { DailyProductionReportState } from "../useDailyProductionReport";

export function useProductionTabPanelState({ report }: { report: DailyProductionReportState }) {
  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    stepDates,
    data,
    isLoading,
    presets,
    valuationMode,
    setValuationMode,
  } = report;
  const [selectedMixBatchId, setSelectedMixBatchId] = useState<number | null>(null);
  const { data: selectedMixBatch, isError: selectedMixBatchError } = useQuery<FactoryMixBatch>({
    queryKey: ["/api/factory/mix-batches", selectedMixBatchId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/mix-batches/${selectedMixBatchId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load mix batch details");
      return res.json();
    },
    enabled: selectedMixBatchId !== null,
    staleTime: 30_000,
  });
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const effectiveRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const isOwner = effectiveRole === "Owner";
  const costsHidden = Boolean(data?.costsHidden);
  const showMoneySummary = !costsHidden && (!isOwner || valuationMode === "cost");
  // Profit is calculated once on the backend from the period-scoped remaining
  // material value. Do not rebuild it from the Balance on Table card here.
  const productionProfitValue = data?.summary.profitValue ?? 0;
  const productionProfitMarginPct = data?.summary.profitMarginPct ?? 0;
  return {
    costsHidden,
    customFrom,
    customTo,
    data,
    isLoading,
    isOwner,
    preset,
    presets,
    productionProfitMarginPct,
    productionProfitValue,
    report,
    selectedMixBatch,
    selectedMixBatchError,
    selectedMixBatchId,
    setCustomFrom,
    setCustomTo,
    setPreset,
    setSelectedMixBatchId,
    setValuationMode,
    showMoneySummary,
    stepDates,
    valuationMode,
  };
}
