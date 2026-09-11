import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { ArrowLeft, MapPin, Eye, ArrowDownToLine, ArrowUpFromLine, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCursorNav } from "@/contexts/CursorNavContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { PageHeader } from "@/components/PageHeader";

interface Transaction {
  date: string;
  particulars: string;
  vchType: string;
  voucherId: number;
  poId?: number;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
  isOpeningBalance?: boolean;
  isPOS?: boolean;
  posSellingRate?: number;
  posSellingValue?: number;
}

/** A transaction row in the ledger, or a month-separator marker row. */
type DisplayRow = Transaction & { _isSeparator?: boolean; _separatorLabel?: string };

interface LocationVouchersData {
  stockItem: { id: number; code: string; name: string; uom: string };
  location: { id: number; code: string; name: string };
  year: number;
  month: number;
  monthName: string;
  transactions: Transaction[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
  };
}

interface RangeVouchersData {
  stockItem: { id: number; code: string; name: string; uom: string };
  location: { id: number; code: string; name: string };
  startDate: string;
  endDate: string;
  transactions: Transaction[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
  };
}

export default function LocationVouchers({ posUser }: { posUser?: unknown } = {}) {
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const { registerCursorNav, clearCursorNav } = useCursorNav();
  const params = useParams();
  const locationId = parseInt(params.locationId || "0");
  const stockItemId = parseInt(params.stockItemId || "0");
  const year = parseInt(params.year || "0");
  const month = parseInt(params.month || "0");
  const [_location, navigate] = useLocation();
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
  const tableScrollContainer = useRef<HTMLDivElement>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_month"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [showStockTransfers, setShowStockTransfers] = useState(false);
  const [showAllMonths, setShowAllMonths] = useState(false);

  // Single-month query
  const { data: monthData, isLoading: monthLoading } = useQuery<LocationVouchersData>({
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
  const { data: rangeData, isLoading: rangeLoading } = useQuery<RangeVouchersData>({
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
  const _totals = data?.totals;

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
    if (t === "sales") return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
    return "bg-muted text-muted-foreground";
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const colSpanFull = posUser ? 6 : 12;

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(`/locations/${locationId}/stock-items/${stockItemId}/history`)}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <PageHeader title="Location Vouchers" />
            {data?.stockItem && data?.location && (
              <div className="flex items-center gap-2 text-muted-foreground" data-testid="text-item-location">
                <span>
                  {data.stockItem.name} ({data.stockItem.code})
                </span>
                <span>•</span>
                <MapPin className="h-4 w-4" />
                <span>{data.location.name}</span>
                <span>•</span>
                <span>{showAllMonths ? String(year) : `${"monthName" in data ? data.monthName : ""} ${year}`}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant={showAllMonths ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setShowAllMonths((v) => !v);
              setSelectedRowIndex(-1);
            }}
            data-testid="button-show-all-months"
          >
            <Eye className="h-4 w-4 mr-1.5" />
            {showAllMonths ? "This month only" : "Show all months"}
          </Button>
          <div className="flex items-center gap-2">
            <Checkbox
              id="show-stock-transfers"
              checked={showStockTransfers}
              onCheckedChange={(checked) => setShowStockTransfers(checked === true)}
              data-testid="checkbox-show-stock-transfers"
            />
            <Label htmlFor="show-stock-transfers" className="text-sm cursor-pointer">
              Show Stock Transfers
            </Label>
          </div>
          {!showAllMonths && (
            <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
          )}
        </div>
      </div>

      {/* KPI Summary Cards */}
      {filteredTransactions.length > 0 && (
        <div className="flex flex-wrap gap-3 items-stretch">
          <div className="flex-1 min-w-[130px] rounded-xl border bg-card p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-500" />
              Total In
            </div>
            <div className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {calculatedTotals.inwardQty > 0
                ? calculatedTotals.inwardQty.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : "—"}
            </div>
            {!posUser && calculatedTotals.inwardValue > 0 && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.inwardValue)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[130px] rounded-xl border bg-card p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-rose-500" />
              Total Out
            </div>
            <div className="text-lg font-bold font-mono text-rose-600 dark:text-rose-400">
              {calculatedTotals.outwardQty > 0
                ? calculatedTotals.outwardQty.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : "—"}
            </div>
            {!posUser && calculatedTotals.outwardValue > 0 && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.outwardValue)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[130px] rounded-xl border bg-primary/5 p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <Layers className="h-3.5 w-3.5 text-primary" />
              Closing
            </div>
            <div
              className={`text-lg font-bold font-mono ${calculatedTotals.closingQty < 0 ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}
            >
              {calculatedTotals.closingQty.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.closingValue)}
              </div>
            )}
          </div>
        </div>
      )}

      <Card className="overflow-hidden flex flex-col" style={{ maxHeight: "calc(100vh - 270px)" }}>
        <CardHeader className="pb-2 flex-shrink-0">
          <CardTitle className="text-base">
            {showAllMonths
              ? `All Transactions — ${year}`
              : `Transactions — ${"monthName" in (data ?? {}) ? (data as { monthName: unknown }).monthName : ""} ${year}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto flex-1 p-0" ref={tableScrollContainer}>
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-30">
              <tr className="bg-muted border-b">
                <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium w-[100px]">
                  Date
                </th>
                <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium">
                  Particulars
                </th>
                <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium w-[110px]">
                  Vch Type
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-3 py-1.5 border-r font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-t-2 border-t-emerald-500"
                >
                  <span className="flex items-center justify-center gap-1">
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                    Inwards
                  </span>
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-3 py-1.5 border-r font-semibold text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border-t-2 border-t-rose-500"
                >
                  <span className="flex items-center justify-center gap-1">
                    <ArrowUpFromLine className="h-3.5 w-3.5" />
                    Outwards
                  </span>
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-3 py-1.5 font-semibold text-primary bg-primary/5 border-t-2 border-t-primary"
                >
                  <span className="flex items-center justify-center gap-1">
                    <Layers className="h-3.5 w-3.5" />
                    Closing
                  </span>
                </th>
              </tr>
              <tr className="border-b text-xs">
                <th className="text-right px-2 py-1.5 font-medium border-r bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[55px]">
                  Qty
                </th>
                {!posUser && (
                  <th className="text-right px-2 py-1.5 font-medium bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[60px]">
                    Rate
                  </th>
                )}
                {!posUser && (
                  <th className="text-right px-2 py-1.5 border-r font-medium bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[75px]">
                    Value
                  </th>
                )}
                <th className="text-right px-2 py-1.5 font-medium border-r bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[55px]">
                  Qty
                </th>
                {!posUser && (
                  <th className="text-right px-2 py-1.5 font-medium bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[60px]">
                    Rate
                  </th>
                )}
                {!posUser && (
                  <th className="text-right px-2 py-1.5 border-r font-medium bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[75px]">
                    Value
                  </th>
                )}
                <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[55px]">Qty</th>
                {!posUser && (
                  <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[60px]">Rate</th>
                )}
                {!posUser && (
                  <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[75px]">Value</th>
                )}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((txn: DisplayRow, idx: number) => {
                // Month separator row
                if (txn._isSeparator) {
                  return (
                    <tr key={`sep-${idx}`} className="bg-primary/10 border-b border-t">
                      <td colSpan={colSpanFull} className="px-4 py-1.5">
                        <span className="text-xs font-bold uppercase tracking-wider text-primary">
                          {txn._separatorLabel}
                        </span>
                      </td>
                    </tr>
                  );
                }

                const navIndex = txn.isOpeningBalance ? -1 : navigableRows.indexOf(txn);
                const isSelected = navIndex >= 0 && selectedRowIndex === navIndex;

                return (
                  <tr
                    key={idx}
                    data-testid={`row-txn-${idx}`}
                    className={`border-b transition-colors ${txn.isOpeningBalance ? "bg-muted/30 font-medium" : isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : "hover:bg-muted/30"}`}
                    data-row-index={navIndex >= 0 ? navIndex : undefined}
                  >
                    <td className="px-4 py-2.5 border-r tabular-nums text-muted-foreground text-xs">
                      {txn.isOpeningBalance ? "" : formatDate(txn.date)}
                    </td>
                    <td className={`px-4 py-2.5 border-r ${txn.isOpeningBalance ? "font-semibold" : ""}`}>
                      {getTransactionEditUrl(txn) ? (
                        <button
                          onClick={() => handleParticularsClick(txn)}
                          className="text-left text-primary hover:underline cursor-pointer"
                          data-testid={`link-particulars-${idx}`}
                        >
                          {txn.particulars}
                        </button>
                      ) : (
                        txn.particulars
                      )}
                    </td>
                    <td className="px-4 py-2.5 border-r">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getVchTypeBadge(txn.vchType)}`}
                      >
                        {txn.vchType}
                      </span>
                    </td>
                    <td className="text-right px-2 py-2.5 tabular-nums border-r font-medium text-emerald-700 dark:text-emerald-400">
                      {formatNumber(txn.inwardQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.inwardRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                        {formatAmount(txn.inwardValue)}
                      </td>
                    )}
                    <td className="text-right px-2 py-2.5 tabular-nums border-r font-medium text-rose-700 dark:text-rose-400">
                      {formatNumber(txn.outwardQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.isPOS && txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                        {formatAmount(txn.isPOS && txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                      </td>
                    )}
                    <td className="text-right px-2 py-2.5 tabular-nums font-semibold text-foreground">
                      {formatNumber(txn.closingQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.closingRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums font-medium">
                        {formatAmount(txn.closingValue)}
                      </td>
                    )}
                  </tr>
                );
              })}

              {displayRows.filter((r: DisplayRow) => !r._isSeparator).length === 0 && (
                <tr>
                  <td colSpan={colSpanFull} className="text-center text-muted-foreground py-8">
                    No transactions found
                  </td>
                </tr>
              )}

              {filteredTransactions.length > 0 && (
                <tr className="bg-muted font-bold border-t-2">
                  <td colSpan={3} className="px-4 py-2.5 border-r text-sm">
                    Totals
                  </td>
                  <td className="text-right px-2 py-2.5 tabular-nums border-r text-emerald-700 dark:text-emerald-400">
                    {formatNumber(calculatedTotals.inwardQty, 0)}
                  </td>
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                      {formatAmount(calculatedTotals.inwardRate)}
                    </td>
                  )}
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                      {formatAmount(calculatedTotals.inwardValue)}
                    </td>
                  )}
                  <td className="text-right px-2 py-2.5 tabular-nums border-r text-rose-700 dark:text-rose-400">
                    {formatNumber(calculatedTotals.outwardQty, 0)}
                  </td>
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                      {formatAmount(calculatedTotals.outwardRate)}
                    </td>
                  )}
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                      {formatAmount(calculatedTotals.outwardValue)}
                    </td>
                  )}
                  <td className="text-right px-2 py-2.5 tabular-nums text-foreground">
                    {formatNumber(calculatedTotals.closingQty, 0)}
                  </td>
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                      {formatAmount(calculatedTotals.closingRate)}
                    </td>
                  )}
                  {!posUser && (
                    <td className="text-right px-2 py-2.5 tabular-nums text-primary">
                      {formatAmount(calculatedTotals.closingValue)}
                    </td>
                  )}
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
