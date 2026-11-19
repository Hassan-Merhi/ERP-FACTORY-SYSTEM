// Extracted from ./FactoryBaleProductAllMonths.tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useParams, useLocation } from "wouter";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getBaleHistoryDisplayStatus } from "./BaleHistoryStatusBadge";
import { useState } from "react";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { type WeightEditBale } from "@/components/BaleWeightEditDialog";
import type { BaleItem } from "./types";

export function useFactoryBaleProductAllMonthsState() {
  const params = useParams();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  useEscapeToParent();

  const productId = params.productId || "0";
  const locationId = params.locationId || "0";
  const year = params.year || String(new Date().getFullYear());
  const backPath = `/factory/bale-product-history/${productId}/${locationId}/${year}`;

  const [statusFilter, setStatusFilter] = useState("all");
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const accessReady = Boolean(
    selectedCompany?.id && myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
  );
  const hiddenCost =
    accessReady && myAccess?.hideAllCosts !== true
      ? (myAccess?.hiddenCostFields ?? [])
      : ["bale_history_cost_per_kg", "bale_history_total_cost"];

  const {
    data: responseData,
    isLoading,
    isError,
    refetch,
  } = useQuery<{ bales: BaleItem[]; sellingPrice?: string }>({
    queryKey: companyQueryKey(
      "/api/factory/bale-product-history",
      selectedCompany?.id,
      productId,
      locationId,
      year,
      "all"
    ),
    queryFn: async () => {
      const response = await fetch(
        `/api/factory/bale-product-history/${productId}/${locationId}/all-bales?year=${year}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: Boolean(selectedCompany?.id) && parseInt(productId) > 0 && parseInt(locationId) > 0,
  });

  const data = responseData?.bales;
  const sellingPricePerBale = parseFloat(responseData?.sellingPrice || "0");

  const filteredData = (data ?? []).filter((bale) => {
    const effectiveStatus = getBaleHistoryDisplayStatus(bale);
    if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;
    return true;
  });

  const formatNumber = (num: number) => {
    if (num % 1 === 0) return num.toLocaleString();
    return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${formatDisplayDate(d)} ${time}`;
  };

  const handleWeightSuccess = () => {
    queryClient.invalidateQueries({
      queryKey: companyQueryKey(
        "/api/factory/bale-product-history",
        selectedCompany?.id,
        productId,
        locationId,
        year,
        "all"
      ),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/factory/bale-product-history", selectedCompany?.id, productId, locationId, year),
    });
  };
  return {
    navigate,
    formatAmount,
    recordChanges,
    year,
    backPath,
    statusFilter,
    setStatusFilter,
    weightEditBale,
    setWeightEditBale,
    hiddenCost,
    isLoading,
    isError,
    responseData,
    refetch,
    data,
    sellingPricePerBale,
    filteredData,
    formatNumber,
    formatDateTime,
    handleWeightSuccess,
  };
}
