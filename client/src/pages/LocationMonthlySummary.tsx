import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import {
  ArrowLeft,
  MapPin,
  Globe,
  Eye,
  ArrowDownToLine,
  ArrowUpFromLine,
  Package,
  DollarSign,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PeriodFilter, getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useCursorNav } from "@/contexts/CursorNavContext";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

interface MonthlyData {
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

export default function LocationMonthlySummary({ posUser }: { posUser?: AuthMe } = {}) {
  const { formatAmount } = useCurrencyContext();
  const { registerCursorNav, clearCursorNav } = useCursorNav();
  const params = useParams();
  const locationId = parseInt(params.locationId || "0");
  const stockItemId = parseInt(params.stockItemId || "0");
  const [_location, navigate] = useLocation();
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

  const { data: detailData, isLoading: detailLoading } = useQuery<{ inTransactions: any[]; outTransactions: any[] }>({
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

  const { data, isLoading } = useQuery<LocationMonthlySummaryData>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(apiUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: stockItemId > 0,
  });

  const hasActivity = (m: MonthlyData) =>
    m.inwardQty > 0 || m.outwardQty > 0 || m.openingQty !== 0 || m.closingQty !== 0;

  const visibleRows = useMemo(() => {
    if (!data?.monthlyData) return [];
    return showAllMonths ? data.monthlyData : data.monthlyData.filter(hasActivity);
  }, [data?.monthlyData, showAllMonths]);

  const handleMonthClick = useCallback((month: number) => {
    if (!isAllLocationsMode) {
      const year = new Date(periodFilter.fromDate).getFullYear();
      navigate(`/locations/${locationId}/stock-items/${stockItemId}/vouchers/${year}/${month}`);
    }
  }, [isAllLocationsMode, locationId, navigate, periodFilter.fromDate, stockItemId]);

  const fmtQty = (n: number) => {
    if (n === 0) return "—";
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  const fmtRate = (n: number) => {
    if (n === 0) return "—";
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtVal = (n: number) => {
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

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const uom = data?.stockItem?.uom || "Units";

  return (
    <div className="container mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <PageHeader title={isAllLocationsMode ? "Item Monthly Summary" : "Stock Movement"} />
            {data?.stockItem && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-item-location">
                <span className="font-medium">{data.stockItem.name}</span>
                <span className="text-muted-foreground/50">({data.stockItem.code})</span>
                <span>•</span>
                {isAllLocationsMode ? (
                  <>
                    <Globe className="h-3.5 w-3.5" />
                    <span>All Locations</span>
                  </>
                ) : (
                  <>
                    <MapPin className="h-3.5 w-3.5" />
                    <span>{data.location?.name || "Unknown"}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant={showAllMonths ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setShowAllMonths((v) => {
                const next = !v;
                // "Show all months" should genuinely show the full 12-month year, even if
                // a narrower custom range (e.g. a single month) is currently selected —
                // otherwise the toggle flips but the table still only has the months that
                // were already fetched, which looks like the button does nothing.
                if (next) {
                  const parsed = periodFilter.fromDate ? new Date(periodFilter.fromDate) : new Date();
                  const year = Number.isNaN(parsed.getTime()) ? new Date().getFullYear() : parsed.getFullYear();
                  const fullYear = {
                    fromDate: `${year}-01-01`,
                    toDate: `${year}-12-31`,
                    preset: "custom" as const,
                  };
                  if (periodFilter.fromDate !== fullYear.fromDate || periodFilter.toDate !== fullYear.toDate) {
                    setPeriodFilter(fullYear);
                  }
                }
                return next;
              });
            }}
            data-testid="button-show-all-months"
          >
            <Eye className="h-4 w-4 mr-1.5" />
            {showAllMonths ? "Hide empty months" : "Show all months"}
          </Button>
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
        </div>
      </div>

      {/* KPI Summary Cards */}
      {data?.grandTotal && (
        <div className="flex flex-wrap gap-3 items-stretch">
          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-500" />
              Total Stock In
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {fmtQty(data.grandTotal.inwardQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.inwardValue)}</div>
            )}
          </div>

          <div className="flex items-center self-center text-muted-foreground/40">
            <ArrowRight className="h-4 w-4" />
          </div>

          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-rose-500" />
              Total Stock Out
            </div>
            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400">
              {fmtQty(data.grandTotal.outwardQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.outwardValue)}</div>
            )}
          </div>

          <div className="flex items-center self-center text-muted-foreground/40">
            <ArrowRight className="h-4 w-4" />
          </div>

          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <Package className="h-3.5 w-3.5 text-primary" />
              Closing Stock
            </div>
            <div
              className={`text-xl font-bold font-mono ${data.grandTotal.closingQty < 0 ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}
            >
              {fmtQty(data.grandTotal.closingQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.closingValue)}</div>
            )}
          </div>

          {!posUser && (
            <>
              <div className="flex items-center self-center text-muted-foreground/40">
                <ArrowRight className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-[140px] rounded-xl border bg-primary/5 p-4 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  <DollarSign className="h-3.5 w-3.5 text-primary" />
                  Closing Value
                </div>
                <div className="text-xl font-bold font-mono text-primary">{fmtVal(data.grandTotal.closingValue)}</div>
                <div className="text-xs font-mono text-muted-foreground">
                  avg {fmtRate(data.grandTotal.closingRate)} / {uom}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Tally-style Stock Movement Table */}
      <Card className="overflow-hidden flex flex-col" style={{ maxHeight: "calc(100vh - 340px)" }}>
        <CardHeader className="pb-2 flex-shrink-0">
          <CardTitle className="text-base">
            Monthly Stock Movement
            <span className="ml-2 text-sm font-normal text-muted-foreground">({uom})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto flex-1 p-0" ref={tableScrollContainer}>
          <table className="w-full text-sm border-collapse" style={{ minWidth: "900px" }}>
            <thead className="sticky top-0 z-30">
              <tr className="bg-muted border-b">
                <th rowSpan={2} className="text-left align-bottom px-3 py-2 border-r font-semibold w-28">
                  Month
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-2 py-1.5 border-r font-semibold text-muted-foreground"
                >
                  Opening
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-2 py-1.5 border-r font-semibold text-green-700 dark:text-green-400"
                >
                  Stock In
                </th>
                <th
                  colSpan={posUser ? 1 : 3}
                  className="text-center px-2 py-1.5 border-r font-semibold text-red-700 dark:text-red-400"
                >
                  Stock Out
                </th>
                <th colSpan={posUser ? 1 : 3} className="text-center px-2 py-1.5 font-semibold text-primary">
                  Closing
                </th>
              </tr>
              <tr className="bg-muted/70 border-b text-xs">
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Qty</th>
                {!posUser && (
                  <>
                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Rate</th>
                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Value</th>
                  </>
                )}
                <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">Qty</th>
                {!posUser && (
                  <>
                    <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">
                      Rate
                    </th>
                    <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">
                      Value
                    </th>
                  </>
                )}
                <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">Qty</th>
                {!posUser && (
                  <>
                    <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">Rate</th>
                    <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">
                      Value
                    </th>
                  </>
                )}
                <th className="text-right px-3 py-1.5 font-medium text-primary">Qty</th>
                {!posUser && (
                  <>
                    <th className="text-right px-3 py-1.5 font-medium text-primary">Rate</th>
                    <th className="text-right px-3 py-1.5 font-medium text-primary">Value</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={posUser ? 5 : 13} className="text-center py-12 text-muted-foreground">
                    No stock movement for this period
                  </td>
                </tr>
              )}
              {visibleRows.map((month, idx) => {
                const isSelected = selectedRowIndex === idx;
                const isClickable = !isAllLocationsMode;
                const isActive = hasActivity(month);

                return (
                  <tr
                    key={month.month}
                    className={`border-b transition-colors ${isClickable ? "cursor-pointer" : ""} ${isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : isActive && isClickable ? "hover:bg-muted/40" : "text-muted-foreground/60"}`}
                    onClick={() => isClickable && isActive && handleMonthClick(month.month)}
                    data-testid={`row-month-${month.month}`}
                    data-row-index={idx}
                  >
                    <td className="font-medium px-3 py-2.5 border-r">{month.monthName}</td>

                    {/* Opening */}
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                      {fmtQty(month.openingQty)}
                    </td>
                    {!posUser && (
                      <>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                          {fmtRate(month.openingRate)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                          {fmtVal(month.openingValue)}
                        </td>
                      </>
                    )}

                    {/* Stock In */}
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400 font-medium">
                      {!isAllLocationsMode && month.inwardQty > 0 ? (
                        <button
                          className="underline decoration-dotted underline-offset-2 cursor-pointer hover:opacity-70 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            const y = new Date(periodFilter.fromDate).getFullYear();
                            setDetailYear(y);
                            setDetailMonth(month.month);
                            setDetailMonthName(month.monthName);
                            setDetailDirection("in");
                            setDetailOpen(true);
                          }}
                        >
                          {fmtQty(month.inwardQty)}
                        </button>
                      ) : (
                        fmtQty(month.inwardQty)
                      )}
                    </td>
                    {!posUser && (
                      <>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                          {fmtRate(month.inwardRate)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                          {fmtVal(month.inwardValue)}
                        </td>
                      </>
                    )}

                    {/* Stock Out */}
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400 font-medium">
                      {!isAllLocationsMode && month.outwardQty > 0 ? (
                        <button
                          className="underline decoration-dotted underline-offset-2 cursor-pointer hover:opacity-70 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            const y = new Date(periodFilter.fromDate).getFullYear();
                            setDetailYear(y);
                            setDetailMonth(month.month);
                            setDetailMonthName(month.monthName);
                            setDetailDirection("out");
                            setDetailOpen(true);
                          }}
                        >
                          {fmtQty(month.outwardQty)}
                        </button>
                      ) : (
                        fmtQty(month.outwardQty)
                      )}
                    </td>
                    {!posUser && (
                      <>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                          {fmtRate(month.outwardRate)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                          {fmtVal(month.outwardValue)}
                        </td>
                      </>
                    )}

                    {/* Closing */}
                    <td className="text-right px-3 py-2.5 tabular-nums font-semibold text-foreground">
                      {fmtQty(month.closingQty)}
                    </td>
                    {!posUser && (
                      <>
                        <td className="text-right px-3 py-2.5 tabular-nums font-medium">
                          {fmtRate(month.closingRate)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums font-medium">
                          {fmtVal(month.closingValue)}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>

            {/* Grand Total */}
            {data?.grandTotal && (
              <tfoot className="sticky bottom-0 z-10">
                <tr className="bg-muted font-bold border-t-2">
                  <td className="px-3 py-2.5 border-r">Total</td>

                  {/* Opening total */}
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                    {fmtQty(data.grandTotal.openingQty)}
                  </td>
                  {!posUser && (
                    <>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                        {fmtRate(data.grandTotal.openingRate)}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                        {fmtVal(data.grandTotal.openingValue)}
                      </td>
                    </>
                  )}

                  {/* In total */}
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                    {fmtQty(data.grandTotal.inwardQty)}
                  </td>
                  {!posUser && (
                    <>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                        {fmtRate(data.grandTotal.inwardRate)}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                        {fmtVal(data.grandTotal.inwardValue)}
                      </td>
                    </>
                  )}

                  {/* Out total */}
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                    {fmtQty(data.grandTotal.outwardQty)}
                  </td>
                  {!posUser && (
                    <>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                        {fmtRate(data.grandTotal.outwardRate)}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                        {fmtVal(data.grandTotal.outwardValue)}
                      </td>
                    </>
                  )}

                  {/* Closing total */}
                  <td className="text-right px-3 py-2.5 tabular-nums text-foreground">
                    {fmtQty(data.grandTotal.closingQty)}
                  </td>
                  {!posUser && (
                    <>
                      <td className="text-right px-3 py-2.5 tabular-nums">{fmtRate(data.grandTotal.closingRate)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums">{fmtVal(data.grandTotal.closingValue)}</td>
                    </>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>

      {/* Legend */}
      {!isAllLocationsMode && (
        <p className="text-xs text-muted-foreground text-center">
          Click any month row to see voucher detail · Click Qty In/Out to drill into transactions
        </p>
      )}

      {/* ── Drill-down detail dialog ── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl flex flex-col" style={{ maxHeight: "75vh" }}>
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              {detailDirection === "in" ? (
                <span className="text-green-700 dark:text-green-400">Stock In</span>
              ) : (
                <span className="text-red-700 dark:text-red-400">Stock Out</span>
              )}
              <span className="text-muted-foreground font-normal">—</span>
              <span>
                {detailMonthName} {detailYear}
              </span>
            </DialogTitle>
            <DialogDescription>
              {data?.stockItem?.name} · {data?.location?.name}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto min-h-0 border rounded-md">
            {detailLoading ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              (() => {
                const rows =
                  detailDirection === "in" ? (detailData?.inTransactions ?? []) : (detailData?.outTransactions ?? []);

                const typeBadgeClass = (type: string) => {
                  if (type === "Sale") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
                  if (type.startsWith("Transfer In"))
                    return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
                  if (type.startsWith("Transfer Out"))
                    return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
                  if (type.startsWith("Adjustment"))
                    return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
                  if (type === "Credit Note")
                    return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
                  return "bg-muted text-muted-foreground";
                };

                if (!rows.length) {
                  return (
                    <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                      No transactions found for this period.
                    </div>
                  );
                }

                const totalQty = rows.reduce((s: number, r) => s + (r.qty || 0), 0);
                const totalValue = rows.reduce((s: number, r) => s + (r.value || 0), 0);
                const avgRate = totalQty > 0 ? totalValue / totalQty : 0;

                return (
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-muted border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Reference</th>
                        <th className="text-right px-3 py-2 font-medium">Qty</th>
                        <th className="text-right px-3 py-2 font-medium">Rate</th>
                        <th className="text-right px-3 py-2 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((tx, i: number) => (
                        <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeClass(tx.type)}`}
                            >
                              {tx.type}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{tx.date}</td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{tx.reference}</td>
                          <td className="text-right px-3 py-2 tabular-nums font-medium">
                            {(tx.qty || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-muted-foreground">
                            {(tx.rate || 0).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums">{formatAmount(tx.value || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-muted border-t-2 font-semibold">
                      <tr>
                        <td colSpan={3} className="px-3 py-2 text-xs text-muted-foreground">
                          {rows.length} transaction{rows.length !== 1 ? "s" : ""} · Avg rate:{" "}
                          {avgRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="text-right px-3 py-2 tabular-nums">
                          {totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td />
                        <td className="text-right px-3 py-2 tabular-nums">{formatAmount(totalValue)}</td>
                      </tr>
                    </tfoot>
                  </table>
                );
              })()
            )}
          </div>

          <DialogFooter className="flex-shrink-0 pt-2">
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
