// Extracted from ./StockItemHistory.tsx
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useState } from "react";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import type { StockItemSummary } from "./StockItemHistoryTypes";

export function useStockItemHistoryState() {
  const params = useParams();
  const stockItemId = parseInt(params.id || "0");
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { formatAmount } = useCurrencyContext();

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear.toString());
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_year"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  useEscapeToParent("/stock-items");

  const { data, isLoading, isError, refetch } = useQuery<StockItemSummary>({
    queryKey: [
      `/api/stock-items/${stockItemId}/monthly-summary`,
      { year: selectedYear, startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/stock-items/${stockItemId}/monthly-summary?year=${selectedYear}&startDate=${periodFilter.fromDate}&endDate=${periodFilter.toDate}`,
        {
          credentials: "include",
        }
      );
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: stockItemId > 0,
  });

  const years = [];
  for (let y = currentYear; y >= currentYear - 5; y--) {
    years.push(y);
  }

  const chartData =
    data?.monthlyData.map((m) => ({
      name: m.monthName.substring(0, 3),
      Inwards: m.inwardQty,
      Outwards: m.outwardQty,
    })) || [];

  const handleMonthClick = (month: number) => {
    navigate(`/stock-items/${stockItemId}/history/${selectedYear}/${month}`);
  };

  const formatNumber = (num: number, decimals = 2) => {
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };
  return {
    handleBack,
    formatAmount,
    selectedYear,
    setSelectedYear,
    periodFilter,
    setPeriodFilter,
    isLoading,
    isError,
    data,
    refetch,
    years,
    chartData,
    handleMonthClick,
    formatNumber,
  };
}
