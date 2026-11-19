// Extracted from ./LocationMonthlySummary.tsx to keep that module under the source-size cap.
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCursorNav } from "@/contexts/CursorNavContext";
import type { AuthMe } from "@shared/apiTypes";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

export interface MonthlyData {
  month: number;
  monthName: string;
  openingQty: number;
  openingValue: number;
  openingRate: number;
  inwardQty: number;
  inwardValue: number;
  inwardRate: number;
  outwardQty: number;
  outwardValue: number;
  outwardRate: number;
  closingQty: number;
  closingValue: number;
  closingRate: number;
}

/** Transaction row from GET /api/locations/:id/stock-items/:id/monthly-detail. */
interface MonthlyDetailTx {
  type: string;
  date: string;
  reference: string;
  qty: number;
  rate: number;
  value: number;
}

/** Response of the monthly-detail drill-down endpoint. */
interface MonthlyDetailResponse {
  inTransactions: MonthlyDetailTx[];
  outTransactions: MonthlyDetailTx[];
}

interface LocationMonthlySummaryData {
  stockItem: {
    id: number;
    code: string;
    name: string;
    uom: string;
  };
  location?: {
    id: number;
    code: string;
    name: string;
  };
  year: number;
  monthlyData: MonthlyData[];
  grandTotal: {
    openingQty: number;
    openingValue: number;
    openingRate: number;
    inwardQty: number;
    inwardValue: number;
    inwardRate: number;
    outwardQty: number;
    outwardValue: number;
    outwardRate: number;
    closingQty: number;
    closingValue: number;
    closingRate: number;
  };
}

export function toSafeNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function hasActivity(m: MonthlyData) {
  return (
    toSafeNumber(m.inwardQty) > 0 ||
    toSafeNumber(m.outwardQty) > 0 ||
    toSafeNumber(m.openingQty) !== 0 ||
    toSafeNumber(m.closingQty) !== 0
  );
}

export function useLocationMonthlySummaryState({ posUser }: { posUser?: AuthMe } = {}) {
  const mobileCards = useMobileCardTable();
  const mobileCardsSecondary = useMobileCardTable();
  const { formatAmount } = useCurrencyContext();
  const { registerCursorNav, clearCursorNav } = useCursorNav();
  const params = useParams();
  const locationId = parseInt(params.locationId || "0");
  const stockItemId = parseInt(params.stockItemId || "0");
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();

  const isAllLocationsMode = locationId === 0;

  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_year"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
  const [showAllMonths, setShowAllMonths] = useState(true);
  const tableScrollContainer = useRef<HTMLDivElement>(null);

  // Drill-down detail dialog state
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailYear, setDetailYear] = useState(new Date().getFullYear());
  const [detailMonth, setDetailMonth] = useState(0);
  const [detailMonthName, setDetailMonthName] = useState("");
  const [detailDirection, setDetailDirection] = useState<"in" | "out">("out");

  const { data: detailData, isLoading: detailLoading } = useQuery<MonthlyDetailResponse>({
    queryKey: [
      `/api/locations/${locationId}/stock-items/${stockItemId}/monthly-detail`,
      { year: detailYear, month: detailMonth },
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/locations/${locationId}/stock-items/${stockItemId}/monthly-detail?year=${detailYear}&month=${detailMonth}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch detail");
      return res.json();
    },
    enabled: detailOpen && !isAllLocationsMode && stockItemId > 0 && locationId > 0 && detailMonth > 0,
  });

  const apiUrl = isAllLocationsMode
    ? `/api/stock-items/${stockItemId}/monthly-summary?startDate=${periodFilter.fromDate}&endDate=${periodFilter.toDate}`
    : `/api/locations/${locationId}/stock-items/${stockItemId}/monthly-summary?startDate=${periodFilter.fromDate}&endDate=${periodFilter.toDate}`;

  const queryKey = isAllLocationsMode
    ? [
        `/api/stock-items/${stockItemId}/monthly-summary`,
        { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
      ]
    : [
        `/api/locations/${locationId}/stock-items/${stockItemId}/monthly-summary`,
        { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
      ];
  const { data, isLoading, isError, refetch } = useQuery<LocationMonthlySummaryData>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(apiUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: stockItemId > 0,
  });

  const visibleRows = useMemo(() => {
    if (!data?.monthlyData) return [];
    return showAllMonths ? data.monthlyData : data.monthlyData.filter(hasActivity);
  }, [data?.monthlyData, showAllMonths]);

  const handleMonthClick = useCallback(
    (month: number) => {
      if (!isAllLocationsMode) {
        const year = new Date(periodFilter.fromDate).getFullYear();
        navigate(`/locations/${locationId}/stock-items/${stockItemId}/vouchers/${year}/${month}`);
      }
    },
    [isAllLocationsMode, locationId, navigate, periodFilter.fromDate, stockItemId]
  );

  const fmtQty = (value: unknown) => {
    const n = toSafeNumber(value);
    if (n === 0) return "—";
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  const fmtRate = (value: unknown) => {
    const n = toSafeNumber(value);
    if (n === 0) return "—";
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtVal = (value: unknown) => {
    const n = toSafeNumber(value);
    if (n === 0) return "—";
    return formatAmount(n);
  };

  useEscapeToParent("/location-inventory");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      if (hasAnyOpenDialog()) return;
      if (!visibleRows.length) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedRowIndex((prev) => Math.max(-1, prev - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedRowIndex === -1) setSelectedRowIndex(0);
        else if (selectedRowIndex < visibleRows.length - 1) setSelectedRowIndex((prev) => prev + 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!isAllLocationsMode && selectedRowIndex >= 0) {
          handleMonthClick(visibleRows[selectedRowIndex].month);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [selectedRowIndex, visibleRows, isAllLocationsMode, handleMonthClick]);

  useEffect(() => {
    if (selectedRowIndex < 0 || !tableScrollContainer.current) return;
    const rowElement = tableScrollContainer.current.querySelector(`[data-row-index="${selectedRowIndex}"]`);
    if (rowElement) rowElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedRowIndex]);

  useEffect(() => {
    registerCursorNav({
      canNavigateUp: selectedRowIndex > -1,
      canNavigateDown: visibleRows.length > 0 && (selectedRowIndex === -1 || selectedRowIndex < visibleRows.length - 1),
      onUp: () => setSelectedRowIndex((prev) => Math.max(-1, prev - 1)),
      onDown: () =>
        setSelectedRowIndex((prev) => {
          if (prev === -1) return 0;
          if (prev < visibleRows.length - 1) return prev + 1;
          return prev;
        }),
    });
    return () => clearCursorNav();
  }, [clearCursorNav, registerCursorNav, selectedRowIndex, visibleRows]);
  return {
    refetch,
    isError,
    data,
    detailData,
    detailDirection,
    detailLoading,
    detailMonthName,
    detailOpen,
    detailYear,
    fmtQty,
    fmtRate,
    fmtVal,
    formatAmount,
    handleBack,
    handleMonthClick,
    isAllLocationsMode,
    isLoading,
    mobileCards,
    mobileCardsSecondary,
    periodFilter,
    posUser,
    selectedRowIndex,
    setDetailDirection,
    setDetailMonth,
    setDetailMonthName,
    setDetailOpen,
    setDetailYear,
    setPeriodFilter,
    setShowAllMonths,
    showAllMonths,
    tableScrollContainer,
    visibleRows,
  };
}
