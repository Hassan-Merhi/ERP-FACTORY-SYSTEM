// Extracted from ./FactoryNetPositionDetails.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAccountDisplayOrder } from "@/hooks/useAccountDisplayOrder";
import { type InlineOrderActions } from "@/components/accounts/InlineOrderButtons";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { getAppDate } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryNetPositionData } from "./factorynetposition/detailsTypes";

export function useFactoryNetPositionDetailsState() {
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const accountOrder = useAccountDisplayOrder();
  const displayLayout = accountOrder.layout;
  const orderActions: InlineOrderActions = {
    canArrange: accountOrder.canArrange,
    arranging: accountOrder.arranging,
    isSaving: accountOrder.isSaving,
    swap: accountOrder.swap,
    move: accountOrder.move,
  };
  // Empty selection means "company business today" resolved by the API.
  // A browser in a different timezone must not pick the accounting cutoff.
  const [asOf, setAsOf] = useState<string>("");
  const [fxHistorySide, setFxHistorySide] = useState<"gain" | "loss" | null>(null);
  const queryClient = useQueryClient();
  const isToday = !asOf;
  const { prefs, updatePref, isPending: isSavingValuationMode } = useUserPreferences();
  const valuationMode = prefs?.factoryNetPositionValuationMode === "selling" ? "selling" : "cost";

  const { data, isLoading, error, refetch, isFetching } = useQuery<FactoryNetPositionData>({
    queryKey: companyQueryKey("/api/factory/net-position", selectedCompany?.id, asOf || "company-today", valuationMode),
    queryFn: async () => {
      const params = new URLSearchParams({ valuationMode });
      if (asOf) params.set("asOf", asOf);
      const res = await fetch(`/api/factory/net-position?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const text = await res.text();
        // Attach the parsed code so the retry handler can inspect it
        const err: Error & { code?: string } = new Error(text);
        try {
          err.code = JSON.parse(text)?.code;
        } catch {
          // Malformed or absent payload — fall through to the default rather than surface a parse error.
        }
        throw err;
      }
      return res.json();
    },
    // Historical data can change after audited late entry/backfill.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // Auto-retry when the concurrency guard fires (max 3 attempts, 6 s apart)
    retry: (failureCount, err: unknown) =>
      (err as { code?: string } | null)?.code === "ENDPOINT_BUSY" ? failureCount < 3 : false,
    retryDelay: (_, err: unknown) => ((err as { code?: string } | null)?.code === "ENDPOINT_BUSY" ? 6_000 : 0),
  });

  const displayAsOf = asOf || data?.asOf || getAppDate();
  const companyToday = data?.businessToday || getAppDate();
  return {
    formatAmount,
    accountOrder,
    displayLayout,
    orderActions,
    asOf,
    setAsOf,
    setFxHistorySide,
    fxHistorySide,
    queryClient,
    isToday,
    isSavingValuationMode,
    updatePref,
    valuationMode,
    isLoading,
    error,
    refetch,
    data,
    isFetching,
    displayAsOf,
    companyToday,
  };
}
