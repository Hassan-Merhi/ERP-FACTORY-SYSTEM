// Extracted from ./LocationVouchers.tsx to keep that module under the source-size cap.
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCursorNav } from "@/contexts/CursorNavContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import type { DisplayRow, LocationVouchersData, RangeVouchersData, Transaction } from "./LocationVouchersTypes";

export function useLocationVouchersState({ posUser }: { posUser?: unknown } = {}) {
  const mobileCards = useMobileCardTable();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const { registerCursorNav, clearCursorNav } = useCursorNav();
  const params = useParams();
  const locationId = parseInt(params.locationId || "0");
  const stockItemId = parseInt(params.stockItemId || "0");
  const year = parseInt(params.year || "0");
  const month = parseInt(params.month || "0");
  const [, navigate] = useLocation();
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
  const tableScrollContainer = useRef<HTMLDivElement>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_month"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [showStockTransfers, setShowStockTransfers] = useState(false);
  const [showAllMonths, setShowAllMonths] = useState(false);

  // Single-month query
  const {
    data: monthData,
    isLoading: monthLoading,
    isError: monthError,
    refetch: refetchMonth,
  } = useQuery<LocationVouchersData>({
    queryKey: [
      `/api/locations/${locationId}/stock-items/${stockItemId}/vouchers/${year}/${month}`,
      periodFilter.fromDate,
      periodFilter.toDate,
    ],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (periodFilter.fromDate) p.set("startDate", periodFilter.fromDate);
      if (periodFilter.toDate) p.set("endDate", periodFilter.toDate);
      const url = `/api/locations/${locationId}/stock-items/${stockItemId}/vouchers/${year}/${month}?${p.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch vouchers");
      return res.json();
    },
    enabled: locationId > 0 && stockItemId > 0 && year > 0 && month > 0 && !showAllMonths,
  });

  // All-months (date range) query
  const allMonthsStart = `${year}-01-01`;
  const allMonthsEnd = `${year}-12-31`;
  const {
    data: rangeData,
    isLoading: rangeLoading,
    isError: rangeError,
    refetch: refetchRange,
  } = useQuery<RangeVouchersData>({
    queryKey: [`/api/locations/${locationId}/stock-items/${stockItemId}/transactions`, allMonthsStart, allMonthsEnd],
    queryFn: async () => {
      const url = `/api/locations/${locationId}/stock-items/${stockItemId}/transactions?startDate=${allMonthsStart}&endDate=${allMonthsEnd}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch transactions");
      return res.json();
    },
    enabled: locationId > 0 && stockItemId > 0 && year > 0 && showAllMonths,
  });

  const isLoading = showAllMonths ? rangeLoading : monthLoading;
  const data = showAllMonths ? rangeData : monthData;
  const isError = showAllMonths ? rangeError : monthError;
  const refetch = showAllMonths ? refetchRange : refetchMonth;
  const formatNumber = (num: number | null | undefined, decimals = 2) => {
    if (num == null || isNaN(num) || num === 0) return "";
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatDate = (dateStr: string) => {
    try {
      return formatDisplayDate(new Date(dateStr));
    } catch {
      return dateStr;
    }
  };

  const isStockTransfer = (vchType: string) => {
    const t = (vchType || "").toLowerCase();
    return t === "stock transfer" || t === "stocktransfer" || t === "st";
  };

  const allTransactions: Transaction[] = useMemo(() => data?.transactions || [], [data?.transactions]);

  const filteredTransactions = useMemo(() => {
    return allTransactions.filter((txn) => {
      if (txn.isOpeningBalance) return true;
      if (!showStockTransfers && isStockTransfer(txn.vchType)) return false;
      return true;
    });
  }, [allTransactions, showStockTransfers]);

  // When showing all months, build rows with month separator rows injected
  const displayRows = useMemo(() => {
    if (!showAllMonths) return filteredTransactions;
    const monthNames = [
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
    const rows: DisplayRow[] = [];
    let lastMonth = -1;
    for (const txn of filteredTransactions) {
      if (!txn.isOpeningBalance) {
        const d = new Date(txn.date);
        const m = d.getMonth(); // 0-indexed
        if (m !== lastMonth) {
          lastMonth = m;
          rows.push({ ...txn, _isSeparator: true, _separatorLabel: monthNames[m] + " " + year });
        }
      }
      rows.push(txn);
    }
    return rows;
  }, [filteredTransactions, showAllMonths, year]);

  const calculatedTotals = useMemo(() => {
    const nonOpening = filteredTransactions.filter((t) => !t.isOpeningBalance);
    const inwardQty = nonOpening.reduce((s, t) => s + (t.inwardQty || 0), 0);
    const inwardValue = nonOpening.reduce((s, t) => s + (t.inwardValue || 0), 0);
    const outwardQty = nonOpening.reduce((s, t) => s + (t.outwardQty || 0), 0);
    const outwardValue = nonOpening.reduce((s, t) => s + (t.outwardValue || 0), 0);
    const originalLastTxn = allTransactions[allTransactions.length - 1];
    return {
      inwardQty,
      inwardRate: inwardQty > 0 ? inwardValue / inwardQty : 0,
      inwardValue,
      outwardQty,
      outwardRate: outwardQty > 0 ? outwardValue / outwardQty : 0,
      outwardValue,
      closingQty: originalLastTxn?.closingQty || 0,
      closingRate: originalLastTxn?.closingRate || 0,
      closingValue: originalLastTxn?.closingValue || 0,
    };
  }, [filteredTransactions, allTransactions]);

  const getTransactionEditUrl = (txn: Transaction): string | null => {
    if (txn.isOpeningBalance) return null;
    const vchType = (txn.vchType || "").toLowerCase();
    if (vchType === "production" || vchType === "consumption")
      return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
    if (vchType === "pos") return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
    if (vchType === "stock transfer") return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
    if (vchType === "credit note" || vchType === "debit note")
      return txn.voucherId ? `/vouchers?tab=creditnote&edit=${txn.voucherId}` : null;
    if (vchType === "po offload") return txn.poId ? `/purchase-orders/${txn.poId}` : null;
    return null;
  };

  const handleParticularsClick = (txn: Transaction) => {
    const url = getTransactionEditUrl(txn);
    if (url) navigate(url);
  };

  const navigableRows = useMemo(() => filteredTransactions.filter((t) => !t.isOpeningBalance), [filteredTransactions]);

  const handleTableKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (hasAnyOpenDialog()) return;
        e.preventDefault();
        navigate(`/locations/${locationId}/stock-items/${stockItemId}/history`);
        return;
      }
      if (hasAnyOpenDialog()) return;
      if (navigableRows.length === 0) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedRowIndex((prev) => Math.max(-1, prev - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedRowIndex === -1) setSelectedRowIndex(0);
        else if (selectedRowIndex < navigableRows.length - 1) setSelectedRowIndex((prev) => prev + 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedRowIndex >= 0 && selectedRowIndex < navigableRows.length) {
          const url = getTransactionEditUrl(navigableRows[selectedRowIndex]);
          if (url) navigate(url);
        }
      }
    },
    [locationId, navigableRows, navigate, selectedRowIndex, stockItemId]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleTableKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleTableKeyDown, { capture: true });
  }, [selectedRowIndex, data, handleTableKeyDown]);

  useEffect(() => {
    if (selectedRowIndex < 0 || !tableScrollContainer.current) return;
    const rowElement = tableScrollContainer.current.querySelector(`[data-row-index="${selectedRowIndex}"]`);
    if (rowElement) rowElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedRowIndex]);

  useEffect(() => {
    registerCursorNav({
      canNavigateUp: selectedRowIndex > -1,
      canNavigateDown:
        navigableRows.length > 0 && (selectedRowIndex === -1 || selectedRowIndex < navigableRows.length - 1),
      onUp: () => setSelectedRowIndex((prev) => Math.max(-1, prev - 1)),
      onDown: () =>
        setSelectedRowIndex((prev) => {
          if (prev === -1) return 0;
          if (prev < navigableRows.length - 1) return prev + 1;
          return prev;
        }),
    });
    return () => clearCursorNav();
  }, [selectedRowIndex, navigableRows, registerCursorNav, clearCursorNav]);

  const getVchTypeBadge = (vchType: string) => {
    const t = (vchType || "").toLowerCase();
    if (t === "pos") return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    if (t === "po offload" || t === "purchase import")
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    if (t === "stock transfer" || t === "stocktransfer" || t === "st")
      return "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300";
    if (t === "production") return "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300";
    if (t === "consumption") return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
    if (t === "credit note" || t === "debit note")
      return "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300";
    if (t === "sales") return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
    return "bg-muted text-muted-foreground";
  };
  return {
    refetch,
    isError,
    calculatedTotals,
    data,
    displayRows,
    filteredTransactions,
    formatAmount,
    formatDate,
    formatNumber,
    getTransactionEditUrl,
    getVchTypeBadge,
    handleParticularsClick,
    isLoading,
    locationId,
    mobileCards,
    navigableRows,
    navigate,
    periodFilter,
    posUser,
    selectedRowIndex,
    setPeriodFilter,
    setSelectedRowIndex,
    setShowAllMonths,
    setShowStockTransfers,
    showAllMonths,
    showStockTransfers,
    stockItemId,
    tableScrollContainer,
    year,
  };
}
