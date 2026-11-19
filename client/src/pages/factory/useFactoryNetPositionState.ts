// Extracted from ./FactoryNetPositionSection.tsx
import { visibleTabInterval } from "@/lib/queryPolicies";
import { getAppDate } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import type { NetPositionData } from "./factorynetposition/types";

export function useFactoryNetPositionState() {
  const { selectedCompany } = useCompany();
  const [asOf, setAsOf] = useState<string>("");
  const [fxHistorySide, setFxHistorySide] = useState<"gain" | "loss" | null>(null);
  const isToday = !asOf;
  const { prefs, updatePref, isPending: isSavingValuationMode } = useUserPreferences();
  const valuationMode = prefs?.factoryNetPositionValuationMode === "selling" ? "selling" : "cost";

  const {
    data: rawData,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<NetPositionData>({
    queryKey: companyQueryKey("/api/factory/net-position", selectedCompany?.id, asOf || "company-today", valuationMode),
    queryFn: async () => {
      const params = new URLSearchParams({ valuationMode });
      if (asOf) params.set("asOf", asOf);
      const res = await fetch(`/api/factory/net-position?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: isToday ? 30_000 : 60_000,
    refetchInterval: isToday ? visibleTabInterval(120_000) : false,
  });

  // Supplier, customer and employee figures come from the server's balance
  // engine; the page no longer swaps in the Suppliers-page formula for today
  // (that re-mixed operational container amounts into the totals).
  const data = rawData;
  const displayAsOf = asOf || data?.asOf || getAppDate();
  const companyToday = data?.businessToday || getAppDate();

  const isPositive = (data?.netPosition ?? 0) >= 0;
  const hasPendingVerified =
    (data?.pendingOrders?.length ?? 0) + (data?.verifiedOrders?.length ?? 0) + (data?.loadingOrders?.length ?? 0) > 0;
  return {
    asOf,
    companyToday,
    data,
    displayAsOf,
    error,
    fxHistorySide,
    hasPendingVerified,
    isFetching,
    isLoading,
    isPositive,
    isSavingValuationMode,
    isToday,
    refetch,
    setAsOf,
    setFxHistorySide,
    updatePref,
    valuationMode,
  };
}
