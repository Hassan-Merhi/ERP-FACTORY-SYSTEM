// Extracted from ./FactoryBaleProductMonthDetail.tsx
import { searchAny } from "@shared/searchNormalization";
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
import { type WeightEditBale } from "@/components/BaleWeightEditDialog";
import type { BaleDetailResponse } from "./types";

export function useFactoryBaleProductMonthDetailState() {
  const params = useParams();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  useEscapeToParent();

  const productId = params.productId || "0";
  const locationId = params.locationId || "0";
  const year = params.year || String(new Date().getFullYear());
  const month = params.month || "1";
  const backPath = `/factory/bale-product-history/${productId}/${locationId}/${year}`;

  const [searchTerm, setSearchTerm] = useState("");
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
  } = useQuery<BaleDetailResponse>({
    queryKey: companyQueryKey(
      "/api/factory/bale-product-history",
      selectedCompany?.id,
      productId,
      locationId,
      year,
      month
    ),
    queryFn: async () => {
      const response = await fetch(`/api/factory/bale-product-history/${productId}/${locationId}/${year}/${month}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled:
      Boolean(selectedCompany?.id) &&
      parseInt(productId) > 0 &&
      parseInt(locationId) > 0 &&
      parseInt(year) > 0 &&
      parseInt(month) > 0,
  });

  const data = responseData?.bales;
  const sellingPricePerBale = parseFloat(responseData?.sellingPrice || "0");

  const filteredData = (data || []).filter((bale) => {
    const effectiveStatus = getBaleHistoryDisplayStatus(bale);
    if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;
    if (searchTerm) {
      if (!searchAny(searchTerm, bale.baleCode, bale.referenceNumber)) return false;
    }
    return true;
  });

  const monthNames = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthName = monthNames[parseInt(month)] || month;

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
        month
      ),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/factory/bale-product-history", selectedCompany?.id, productId, locationId, year),
    });
  };
  return {
    navigate,
    formatAmount,
    productId,
    locationId,
    year,
    backPath,
    searchTerm,
    setSearchTerm,
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
    monthName,
    formatNumber,
    formatDateTime,
    handleWeightSuccess,
  };
}
