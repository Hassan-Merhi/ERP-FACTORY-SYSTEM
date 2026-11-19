// Extracted from ./SalesReportComparison.tsx: state, queries and handlers for SalesReportComparison.
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { getAiResult, type SalesItem, type ItemRow, type ViewFilter } from "./salesReportComparisonModel";

export function useSalesReportComparisonModel() {
  const [, navigate] = useLocation();
  const { formatAmount } = useCurrencyContext();
  const { companies: allCompanies } = useCompany();

  const today = new Date().toLocaleDateString("en-CA");
  const firstOfYear = new Date(new Date().getFullYear(), 0, 1).toLocaleDateString("en-CA");

  const [startDate, setStartDate] = useState(firstOfYear);
  const [endDate, setEndDate] = useState(today);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [stockGroupFilter, setStockGroupFilter] = useState("all");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("all");
  const [search, setSearch] = useState("");
  const [companyPopoverOpen, setCompanyPopoverOpen] = useState(false);

  const toggleCompany = (code: string) => {
    setSelectedCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    if (selectedCodes.length > 0) p.set("companyFilter", selectedCodes.join(","));
    return p.toString();
  }, [startDate, endDate, selectedCodes]);

  const enabled = selectedCodes.length >= 2;

  const {
    data: rawItems = [],
    isFetching,
    isLoading,
    isError,
    refetch,
  } = useQuery<SalesItem[]>({
    queryKey: [
      queryString ? `/api/dashboard/sales-report-comparison?${queryString}` : "/api/dashboard/sales-report-comparison",
    ],
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: stockGroups = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/stock-groups"],
  });

  const displayCompanies = useMemo(
    () => allCompanies.filter((c) => selectedCodes.includes(c.code)),
    [allCompanies, selectedCodes]
  );

  const tableData = useMemo((): ItemRow[] => {
    // Pass 1: group by barcode (stockItemCode) for cross-company matching
    const codeMap = new Map<string, ItemRow>();

    for (const item of rawItems) {
      if (!item.stockItemCode) continue;
      if (stockGroupFilter !== "all" && item.stockGroupName !== stockGroupFilter) continue;

      const groupKey = item.stockItemCode.trim();

      if (!codeMap.has(groupKey)) {
        codeMap.set(groupKey, {
          stockItemCode: groupKey,
          stockItemName: item.stockItemName,
          stockGroupName: item.stockGroupName || "",
          byCompany: {},
        });
      }

      const row = codeMap.get(groupKey)!;
      const compCode = item.companyCode;

      if (!row.byCompany[compCode]) {
        row.byCompany[compCode] = { totalSales: 0, totalQty: 0, costProfit: 0 };
      }

      const entry = row.byCompany[compCode];
      entry.totalSales += parseFloat(item.totalSales || "0");
      entry.totalQty += parseFloat(item.quantity || "0");
      entry.costProfit += parseFloat(item.costProfit || "0");
    }

    // Pass 2: merge rows that have the same normalised name
    // (handles the same product entered with different codes in the same company)
    const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    const nameMap = new Map<string, ItemRow>();

    for (const row of codeMap.values()) {
      const key = normName(row.stockItemName);
      if (!nameMap.has(key)) {
        nameMap.set(key, { ...row, byCompany: { ...row.byCompany } });
      } else {
        const existing = nameMap.get(key)!;
        for (const [compCode, entry] of Object.entries(row.byCompany)) {
          if (!existing.byCompany[compCode]) {
            existing.byCompany[compCode] = { ...entry };
          } else {
            existing.byCompany[compCode].totalSales += entry.totalSales;
            existing.byCompany[compCode].totalQty += entry.totalQty;
            existing.byCompany[compCode].costProfit += entry.costProfit;
          }
        }
      }
    }

    // Pass 3: remove rows where none of the selected companies have any data
    let rows = Array.from(nameMap.values()).filter((r) => displayCompanies.some((c) => !!r.byCompany[c.code]));

    if (viewFilter === "gaining") {
      rows = rows.filter((r) => displayCompanies.some((c) => (r.byCompany[c.code]?.costProfit ?? 0) > 0));
    } else if (viewFilter === "losing") {
      rows = rows.filter((r) => displayCompanies.some((c) => (r.byCompany[c.code]?.costProfit ?? 0) < 0));
    }

    if (search.trim()) {
      rows = rows.filter((r) => searchAny(search, r.stockItemName, r.stockGroupName));
    }

    rows.sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
    return rows;
  }, [rawItems, stockGroupFilter, viewFilter, search, displayCompanies]);

  const fmt = (n: number) => formatAmount(n);

  const fmtQty = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));

  const fmtAvgPrice = (totalSales: number, totalQty: number) => {
    if (!totalQty) return "—";
    return fmt(totalSales / totalQty);
  };

  const profitCell = (profit: number) => {
    if (profit === 0) return <span className="text-muted-foreground text-xs font-mono">—</span>;
    const sign = profit > 0 ? "+" : "";
    return (
      <span
        className={`font-mono text-xs font-semibold ${profit > 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
      >
        {sign}
        {fmt(profit)}
      </span>
    );
  };

  const aiResultCell = (row: ItemRow) => {
    const verdict = getAiResult(row, displayCompanies);
    if (verdict === "—") return <span className="text-muted-foreground text-xs">—</span>;

    const isPositive = verdict.includes("EQUAL IN BOTH");
    return (
      <span className={`text-xs font-medium ${isPositive ? "text-muted-foreground" : "text-foreground"}`}>
        {verdict}
      </span>
    );
  };

  return {
    navigate,
    allCompanies,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    selectedCodes,
    stockGroupFilter,
    setStockGroupFilter,
    viewFilter,
    setViewFilter,
    search,
    setSearch,
    companyPopoverOpen,
    setCompanyPopoverOpen,
    toggleCompany,
    enabled,
    rawItems,
    isFetching,
    isLoading,
    isError,
    refetch,
    stockGroups,
    displayCompanies,
    tableData,
    fmt,
    fmtQty,
    fmtAvgPrice,
    profitCell,
    aiResultCell,
  };
}

export type SalesReportComparisonModel = ReturnType<typeof useSalesReportComparisonModel>;
