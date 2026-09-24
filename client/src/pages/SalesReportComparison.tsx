import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Building2, ChevronDown } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";

interface SalesItem {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupName: string | null;
  quantity: string;
  totalSales: string;
  costProfit: string;
  configuredProfit: number;
  configuredProfitPercentage: number;
  costProfitPercentage: number;
  totalConfiguredCost: number;
  companyId: number;
  companyCode: string;
  companyName: string;
}

interface ItemRow {
  stockItemCode: string;
  stockItemName: string;
  stockGroupName: string;
  byCompany: Record<
    string,
    {
      totalSales: number;
      totalQty: number;
      costProfit: number;
    }
  >;
}

type ViewFilter = "all" | "gaining" | "losing";

interface Company {
  code: string;
  name: string;
}

function getAiResult(row: ItemRow, companies: Company[]): string {
  if (companies.length < 2) return "—";

  const data = companies.map((c) => ({
    code: c.code,
    name: c.name.toUpperCase(),
    qty: row.byCompany[c.code]?.totalQty ?? 0,
    profit: row.byCompany[c.code]?.costProfit ?? 0,
  }));

  const hasAnyData = data.some((d) => d.qty > 0 || d.profit !== 0);
  if (!hasAnyData) return "—";

  const maxQty = Math.max(...data.map((d) => d.qty));
  const maxProfit = Math.max(...data.map((d) => d.profit));

  const qtyWinners = data.filter((d) => d.qty === maxQty);
  const profitWinners = data.filter((d) => d.profit === maxProfit);

  const qtyTied = qtyWinners.length > 1;
  const profitTied = profitWinners.length > 1;

  if (qtyTied && profitTied) return "EQUAL IN BOTH";

  const sameWinner = !qtyTied && !profitTied && qtyWinners[0].code === profitWinners[0].code;

  if (sameWinner) {
    return `${qtyWinners[0].name} BETTER IN SALES & PROFIT`;
  }

  const salesPart = qtyTied ? "SALES EQUAL" : `${qtyWinners[0].name} BETTER IN SALES`;
  const profitPart = profitTied ? "PROFIT EQUAL" : `${profitWinners[0].name} BETTER IN PROFIT`;

  if (qtyTied) return profitPart;
  if (profitTied) return salesPart;
  return `${profitPart} — ${salesPart}`;
}

export default function SalesReportComparison() {
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
  } = useQuery<SalesItem[]>({
    queryKey: ["/api/dashboard/sales-report-all", queryString],
    enabled,
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

  const summaryForCompany = (code: string) => {
    let totalSales = 0,
      totalProfit = 0;
    for (const row of tableData) {
      const entry = row.byCompany[code];
      if (entry) {
        totalSales += entry.totalSales;
        totalProfit += entry.costProfit;
      }
    }
    return { totalSales, totalProfit };
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 space-y-3 border-b pb-3 sm:px-6 sm:pt-4">
        <PageHeader
          title="Company Comparison"
          subtitle="Compare sales performance across companies"
          onBack={() => navigate("/sales-report")}
        />

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2" data-erp-filter-bar="sales-report-comparison">
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-36 h-9 text-sm"
              data-testid="input-start-date"
            />
            <span className="text-muted-foreground text-sm">–</span>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-36 h-9 text-sm"
              data-testid="input-end-date"
            />
          </div>

          <Popover open={companyPopoverOpen} onOpenChange={setCompanyPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-company-select">
                <Building2 className="h-4 w-4" />
                {selectedCodes.length === 0 ? "Select Companies" : `${selectedCodes.length} Selected`}
                <ChevronDown className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" align="end">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
                Select 2 or more companies
              </p>
              <div className="space-y-1">
                {allCompanies.map((c) => (
                  <div
                    key={c.code}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate"
                    onClick={() => toggleCompany(c.code)}
                    data-testid={`option-company-${c.code}`}
                  >
                    <Checkbox checked={selectedCodes.includes(c.code)} className="h-4 w-4" />
                    <span className="text-sm">{c.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{c.code}</span>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Select value={stockGroupFilter} onValueChange={setStockGroupFilter} data-testid="select-stock-group">
            <SelectTrigger className="w-44 h-9">
              <SelectValue placeholder="All Groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Groups</SelectItem>
              {stockGroups.map((g) => (
                <SelectItem key={g.id} value={g.name}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex rounded-md border overflow-hidden">
            {(["all", "gaining", "losing"] as ViewFilter[]).map((v) => (
              <button
                key={v}
                onClick={() => setViewFilter(v)}
                className={`px-3 h-9 text-sm capitalize transition-colors ${
                  viewFilter === v ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                }`}
                data-testid={`filter-${v}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto pt-3 sm:p-6">
        {!enabled ? (
          <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground gap-3">
            <Building2 className="h-10 w-10 opacity-30" />
            <p className="text-base font-medium">Select at least 2 companies to compare</p>
            <p className="text-sm">Use the "Select Companies" button above</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="flex flex-wrap gap-3 mb-6">
              {displayCompanies.map((c) => {
                const { totalSales, totalProfit } = summaryForCompany(c.code);
                return (
                  <Card key={c.code} className="flex-1 min-w-44">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        {c.name}
                      </p>
                      <p className="font-mono text-lg font-bold">{fmt(totalSales)}</p>
                      <p
                        className={`font-mono text-sm ${totalProfit >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
                      >
                        {totalProfit >= 0 ? "+" : ""}
                        {fmt(totalProfit)}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Search */}
            <div className="mb-4">
              <Input
                placeholder="Search items..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-72"
                data-testid="input-search"
              />
            </div>

            {isFetching && !isLoading && (
              <div className="h-0.5 w-full bg-muted overflow-hidden mb-3 rounded-full">
                <div className="h-full bg-primary w-1/2 rounded-full animate-pulse" />
              </div>
            )}

            {isLoading ? (
              <div className="text-center py-16 text-muted-foreground">Loading comparison data…</div>
            ) : tableData.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">No data found for the selected filters</div>
            ) : (
              <div className="rounded-md border overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    {/* Row 1: Item | Group | [Company name spanning 3 cols each] | AI Result */}
                    <TableRow>
                      <TableHead className="min-w-[200px] sticky left-0 bg-background z-10">Item</TableHead>
                      <TableHead className="w-36">Group</TableHead>
                      {displayCompanies.map((c) => (
                        <TableHead
                          key={c.code}
                          colSpan={3}
                          className="text-center border-l uppercase tracking-wide text-xs"
                        >
                          {c.name}
                        </TableHead>
                      ))}
                      <TableHead className="min-w-[220px] border-l text-center text-xs uppercase tracking-wide">
                        AI Result
                      </TableHead>
                    </TableRow>
                    {/* Row 2: sub-labels per company */}
                    <TableRow className="text-xs text-muted-foreground">
                      <TableHead className="sticky left-0 bg-background z-10" />
                      <TableHead />
                      {displayCompanies.map((c) => (
                        <>
                          <TableHead key={`${c.code}-qty`} className="border-l font-normal">
                            Qty Sold
                          </TableHead>
                          <TableHead key={`${c.code}-avg`} className="font-normal">
                            Av Price
                          </TableHead>
                          <TableHead key={`${c.code}-prf`} className="font-normal">
                            Profit
                          </TableHead>
                        </>
                      ))}
                      <TableHead className="border-l" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tableData.map((row) => (
                      <TableRow key={row.stockItemCode} data-testid={`row-item-${row.stockItemCode}`}>
                        <TableCell className="font-medium sticky left-0 bg-background z-10">
                          {row.stockItemName}
                        </TableCell>
                        <TableCell>
                          {row.stockGroupName ? (
                            <Badge variant="secondary" className="text-xs">
                              {row.stockGroupName}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        {displayCompanies.map((c) => {
                          const entry = row.byCompany[c.code];
                          if (!entry)
                            return (
                              <>
                                <TableCell
                                  key={`${c.code}-q`}
                                  className="border-l text-muted-foreground text-center text-xs"
                                >
                                  —
                                </TableCell>
                                <TableCell key={`${c.code}-a`} className="text-muted-foreground text-center text-xs">
                                  —
                                </TableCell>
                                <TableCell key={`${c.code}-p`} className="text-muted-foreground text-center text-xs">
                                  —
                                </TableCell>
                              </>
                            );
                          return (
                            <>
                              <TableCell key={`${c.code}-q`} className="border-l font-mono text-sm">
                                {fmtQty(entry.totalQty)}
                              </TableCell>
                              <TableCell key={`${c.code}-a`} className="font-mono text-sm text-muted-foreground">
                                {fmtAvgPrice(entry.totalSales, entry.totalQty)}
                              </TableCell>
                              <TableCell key={`${c.code}-p`}>{profitCell(entry.costProfit)}</TableCell>
                            </>
                          );
                        })}
                        <TableCell className="border-l">{aiResultCell(row)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
