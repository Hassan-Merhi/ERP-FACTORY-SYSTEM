import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isBlockingQueryError } from "@/lib/abortError";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Package, Search, Ship, AlertCircle, ChevronRight, ChevronDown, X, Layers, FileDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Container } from "@shared/schema";
import { PageHeader } from "@/components/PageHeader";
import CombinedInventory from "@/pages/CombinedInventory";
import { ExcelJS, writeFile } from "@/lib/excelHelper";

interface StockItem {
  stockItemCode: string;
  stockItemName: string;
  quantity: string;
  totalCost: string;
  rate: string;
  containerNumber: string;
  supplierName: string;
  importDate: string;
  gradeId: number | null;
  gradeName: string | null;
  categoryId: number | null;
  categoryName: string | null;
}

interface GroupedStockItem {
  stockItemName: string;
  totalQuantity: number;
  totalCost: number;
  containerCount: number;
  gradeName: string | null;
  categoryName: string | null;
  containers: {
    containerNumber: string;
    quantity: number;
    cost: number;
    rate: number;
    supplierName: string;
  }[];
}

function StockOTWContent({ showCombined, onToggleCombined }: { showCombined: boolean; onToggleCombined: () => void }) {
  const { formatAmount } = useCurrencyContext();
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<string[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  const {
    data: containers = [],
    isLoading: loadingContainers,
    error: containersError,
    refetch: refetchContainers,
  } = useQuery<Container[]>({
    queryKey: ["/api/containers"],
  });

  // Single bulk query replaces the N-per-container useQueries fan-out
  const {
    data: otwItemsRaw = [],
    isLoading: loadingOtwItems,
    error: otwItemsError,
    refetch: refetchOtwItems,
  } = useQuery<StockItem[]>({
    queryKey: ["/api/containers/otw-items"],
  });

  const otwContainers = useMemo(() => containers.filter((c) => c.status === "OTW"), [containers]);

  const isLoading = loadingContainers || loadingOtwItems;
  // A failed background refetch leaves the last good data on screen and an error
  // beside it, and a cancelled request is not a failure at all. Report only what
  // actually left the page without data.
  const containersFailed = isBlockingQueryError(containersError, containers.length > 0);
  const otwItemsFailed = isBlockingQueryError(otwItemsError, otwItemsRaw.length > 0);
  const hasErrors = containersFailed || otwItemsFailed;

  const retryFailedQueries = () => {
    if (containersFailed) void refetchContainers();
    if (otwItemsFailed) void refetchOtwItems();
  };

  const stockItems: StockItem[] = otwItemsRaw;

  const groupedItems: GroupedStockItem[] = useMemo(() => {
    const grouped = new Map<string, GroupedStockItem>();
    stockItems.forEach((item) => {
      const name = item.stockItemName;
      const qty = parseFloat(item.quantity || "0");
      const cost = parseFloat(item.totalCost || "0");
      if (!grouped.has(name)) {
        grouped.set(name, {
          stockItemName: name,
          totalQuantity: 0,
          totalCost: 0,
          containerCount: 0,
          gradeName: item.gradeName ?? null,
          categoryName: item.categoryName ?? null,
          containers: [],
        });
      }
      const group = grouped.get(name)!;
      if (!group.gradeName && item.gradeName) group.gradeName = item.gradeName;
      if (!group.categoryName && item.categoryName) group.categoryName = item.categoryName;
      group.totalQuantity += isNaN(qty) ? 0 : qty;
      group.totalCost += isNaN(cost) ? 0 : cost;
      const existingContainer = group.containers.find((c) => c.containerNumber === item.containerNumber);
      const itemRate = parseFloat(item.rate || "0");
      if (existingContainer) {
        existingContainer.quantity += isNaN(qty) ? 0 : qty;
        existingContainer.cost += isNaN(cost) ? 0 : cost;
      } else {
        group.containers.push({
          containerNumber: item.containerNumber,
          quantity: isNaN(qty) ? 0 : qty,
          cost: isNaN(cost) ? 0 : cost,
          rate: isNaN(itemRate) ? 0 : itemRate,
          supplierName: item.supplierName,
        });
      }
    });
    grouped.forEach((group) => {
      group.containerCount = group.containers.length;
    });
    return Array.from(grouped.values()).sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
  }, [stockItems]);

  const gradeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    groupedItems.forEach((item) => {
      if (item.gradeName) seen.set(item.gradeName, item.gradeName);
    });
    return Array.from(seen.values()).sort();
  }, [groupedItems]);

  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    groupedItems.forEach((item) => {
      if (item.categoryName) seen.set(item.categoryName, item.categoryName);
    });
    return Array.from(seen.values()).sort();
  }, [groupedItems]);

  const supplierOptions = useMemo(() => {
    const seen = new Set<string>();
    groupedItems.forEach((item) => {
      item.containers.forEach((c) => {
        if (c.supplierName) seen.add(c.supplierName);
      });
    });
    return Array.from(seen).sort();
  }, [groupedItems]);

  const filteredItems = groupedItems.filter((item) => {
    if (selectedGrade !== "all" && item.gradeName !== selectedGrade) return false;
    if (selectedCategory.length > 0 && !selectedCategory.includes(item.categoryName ?? "")) return false;
    if (selectedSupplier.length > 0 && !item.containers.some((c) => selectedSupplier.includes(c.supplierName)))
      return false;
    if (searchTerm === "") return true;
    const search = searchTerm.toLowerCase();
    return (
      item.stockItemName.toLowerCase().includes(search) ||
      (item.gradeName?.toLowerCase().includes(search) ?? false) ||
      (item.categoryName?.toLowerCase().includes(search) ?? false) ||
      item.containers.some(
        (c) => c.containerNumber.toLowerCase().includes(search) || c.supplierName.toLowerCase().includes(search)
      )
    );
  });

  const toggleItemExpanded = (itemName: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemName)) {
        newSet.delete(itemName);
      } else {
        newSet.add(itemName);
      }
      return newSet;
    });
  };

  const totalQuantity = filteredItems.reduce((sum, item) => sum + item.totalQuantity, 0);
  const totalValue = filteredItems.reduce((sum, item) => sum + item.totalCost, 0);
  const uniqueItemCount = filteredItems.length;

  const containerGrandTotal = otwContainers.reduce((sum, c) => sum + parseFloat(c.grandTotal || "0"), 0);
  const isFiltered =
    searchTerm.trim() !== "" || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0;
  const displayTotal = isFiltered ? totalValue : containerGrandTotal;

  const hasActiveFilters =
    searchTerm !== "" || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0;

  const clearFilters = () => {
    setSearchTerm("");
    setSelectedGrade("all");
    setSelectedCategory([]);
    setSelectedSupplier([]);
  };

  const exportToExcel = async () => {
    if (isExporting || filteredItems.length === 0) return;
    setIsExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Stock OTW");

      const COLS = 8;
      const BLUE_DARK = "1D4ED8";
      const BLUE_MID = "DBEAFE";
      const BLUE_LIGHT = "EFF6FF";
      const GRAY_LIGHT = "F9FAFB";
      const WHITE = "FFFFFF";

      const hFill = (argb: string): ExcelJS.Fill => ({
        type: "pattern",
        pattern: "solid",
        fgColor: { argb },
      });
      const bold = (size = 11): Partial<ExcelJS.Font> => ({ bold: true, size });
      const right: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle" };
      const mid: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle" };
      const numFmt = "#,##0.##";

      // ── Title ──────────────────────────────────────────────────────────────
      ws.mergeCells(1, 1, 1, COLS);
      const titleCell = ws.getCell("A1");
      titleCell.value = "Stock On The Way";
      titleCell.font = { bold: true, size: 16, color: { argb: "1E3A5F" } };
      titleCell.alignment = { horizontal: "left", vertical: "middle" };
      ws.getRow(1).height = 28;

      ws.mergeCells(2, 1, 2, COLS);
      const subCell = ws.getCell("A2");
      subCell.value = `Exported: ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;
      subCell.font = { italic: true, size: 10, color: { argb: "6B7280" } };
      subCell.alignment = mid;
      ws.getRow(2).height = 18;

      // ── Stats row ──────────────────────────────────────────────────────────
      ws.getRow(3).height = 8;

      const statsRow = ws.getRow(4);
      statsRow.height = 20;
      const statsText = [
        `${otwContainers.length} container${otwContainers.length !== 1 ? "s" : ""} OTW`,
        `${filteredItems.length} unique item${filteredItems.length !== 1 ? "s" : ""}`,
        `Total qty: ${Math.round(totalQuantity).toLocaleString()}`,
        `Total value: ${formatAmount(displayTotal)}`,
      ].join("     |     ");
      ws.mergeCells(4, 1, 4, COLS);
      const statsCell = ws.getCell("A4");
      statsCell.value = statsText;
      statsCell.font = { size: 10, color: { argb: "374151" } };
      statsCell.alignment = mid;

      if (searchTerm || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0) {
        const filters: string[] = [];
        if (searchTerm) filters.push(`Search: "${searchTerm}"`);
        if (selectedGrade !== "all") filters.push(`Grade: ${selectedGrade}`);
        if (selectedCategory.length > 0) filters.push(`Categories: ${selectedCategory.join(", ")}`);
        if (selectedSupplier.length > 0) filters.push(`Suppliers: ${selectedSupplier.join(", ")}`);
        ws.getRow(5).height = 16;
        ws.mergeCells(5, 1, 5, COLS);
        const fCell = ws.getCell("A5");
        fCell.value = `Active filters: ${filters.join(" | ")}`;
        fCell.font = { italic: true, size: 9, color: { argb: "9CA3AF" } };
        fCell.alignment = mid;
      }

      ws.getRow(6).height = 8;

      // ── Column headers ─────────────────────────────────────────────────────
      const HDR_ROW = 7;
      const headers = ["Item Name", "Grade", "Category", "Container #", "Supplier", "Quantity", "Rate", "Total Cost"];
      const hRow = ws.getRow(HDR_ROW);
      hRow.height = 22;
      headers.forEach((h, i) => {
        const cell = hRow.getCell(i + 1);
        cell.value = h;
        cell.font = { ...bold(11), color: { argb: WHITE } };
        cell.fill = hFill(BLUE_DARK);
        cell.alignment = i >= 5 ? right : mid;
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFFFFF" } },
        };
      });

      // ── Data rows ──────────────────────────────────────────────────────────
      let rowIdx = HDR_ROW + 1;

      for (const item of filteredItems) {
        const uniqueSuppliers = Array.from(new Set(item.containers.map((c) => c.supplierName)));

        // Summary row
        const sRow = ws.getRow(rowIdx++);
        sRow.height = 20;
        const sCells = [
          item.stockItemName,
          item.gradeName ?? "",
          item.categoryName ?? "",
          `${item.containerCount} container${item.containerCount !== 1 ? "s" : ""}`,
          uniqueSuppliers.join(", "),
          item.totalQuantity,
          null,
          item.totalCost,
        ];
        sCells.forEach((v, i) => {
          const cell = sRow.getCell(i + 1);
          cell.value = v;
          cell.fill = hFill(BLUE_LIGHT);
          cell.font = bold(10);
          cell.alignment = i >= 5 ? right : mid;
          if (i === 5 || i === 7) cell.numFmt = numFmt;
        });

        // Container sub-rows
        for (const con of item.containers) {
          const cRow = ws.getRow(rowIdx++);
          cRow.height = 18;
          const cCells = [
            `    ${con.containerNumber}`,
            "",
            "",
            con.containerNumber,
            con.supplierName,
            con.quantity,
            con.rate,
            con.cost,
          ];
          cCells.forEach((v, i) => {
            const cell = cRow.getCell(i + 1);
            cell.value = v;
            cell.fill = hFill(i % 2 === 0 ? WHITE : GRAY_LIGHT);
            cell.font = { size: 9, color: { argb: "374151" } };
            cell.alignment = i >= 5 ? right : mid;
            if (i >= 5) cell.numFmt = numFmt;
          });
          // Unified subtle fill
          for (let i = 1; i <= COLS; i++) {
            cRow.getCell(i).fill = hFill(GRAY_LIGHT);
          }
        }
      }

      // ── Totals footer ──────────────────────────────────────────────────────
      const totRow = ws.getRow(rowIdx);
      totRow.height = 22;
      const totCells: (string | number | null)[] = [
        `Total — ${filteredItems.length} items`,
        "",
        "",
        "",
        "",
        totalQuantity,
        null,
        displayTotal,
      ];
      totCells.forEach((v, i) => {
        const cell = totRow.getCell(i + 1);
        cell.value = v;
        cell.fill = hFill(BLUE_MID);
        cell.font = bold(11);
        cell.alignment = i >= 5 ? right : mid;
        if (i === 5 || i === 7) cell.numFmt = numFmt;
      });

      // ── Column widths ──────────────────────────────────────────────────────
      ws.getColumn(1).width = 36;
      ws.getColumn(2).width = 14;
      ws.getColumn(3).width = 16;
      ws.getColumn(4).width = 18;
      ws.getColumn(5).width = 24;
      ws.getColumn(6).width = 12;
      ws.getColumn(7).width = 12;
      ws.getColumn(8).width = 14;

      // Freeze rows above the header
      ws.views = [{ state: "frozen", xSplit: 0, ySplit: HDR_ROW }];

      const date = new Date().toISOString().slice(0, 10);
      await writeFile(wb, `Stock-OTW-${date}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-3 sm:p-0 space-y-4 sm:space-y-6">
        <div className="flex flex-wrap gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-10 w-full rounded-md" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (showCombined) {
    return (
      <CombinedInventory
        headerActions={
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleCombined}
            data-testid="button-toggle-combined"
            className="shrink-0 gap-2"
          >
            <Ship className="h-4 w-4" />
            Stock OTW
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Stock On The Way" subtitle="All stock items from containers currently in transit">
        <Button
          variant="outline"
          size="sm"
          onClick={exportToExcel}
          disabled={isExporting || filteredItems.length === 0}
          data-testid="button-export-excel"
          className="gap-2"
        >
          <FileDown className="h-4 w-4" />
          {isExporting ? "Exporting…" : "Export"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleCombined}
          data-testid="button-toggle-combined"
          className="gap-2"
        >
          <Layers className="h-4 w-4" />
          Combined
        </Button>
      </PageHeader>

      {hasErrors && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Loading Data</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              {containersFailed ? "Failed to load containers. " : ""}
              {otwItemsFailed ? "Failed to load stock items. " : ""}
            </span>
            <Button variant="outline" size="sm" onClick={retryFailedQueries} data-testid="button-otw-retry">
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Stats bar */}
      {otwContainers.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 bg-blue-500/10 rounded-lg px-3 py-2">
            <Ship className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <span
              className="text-sm font-semibold text-blue-700 dark:text-blue-300"
              data-testid="text-containers-count"
            >
              {otwContainers.length}
            </span>
            <span className="text-xs text-muted-foreground">Containers OTW</span>
          </div>
          <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold" data-testid="text-total-items">
              {groupedItems.length}
            </span>
            <span className="text-xs text-muted-foreground">Unique Items</span>
          </div>
          <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
            <span className="text-sm font-semibold font-mono" data-testid="text-total-quantity">
              {Math.round(groupedItems.reduce((s, i) => s + i.totalQuantity, 0)).toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">Total Qty</span>
          </div>
          <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
            <span className="text-sm font-semibold font-mono text-primary" data-testid="text-summary-value">
              {formatAmount(containerGrandTotal)}
            </span>
            <span className="text-xs text-muted-foreground">Total Value</span>
          </div>
        </div>
      )}

      {/* Inline filter row */}
      {stockItems.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, container, supplier, grade or category..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
              data-testid="input-search"
            />
          </div>
          {gradeOptions.length > 0 && (
            <Select value={selectedGrade} onValueChange={setSelectedGrade}>
              <SelectTrigger className="w-[140px]" data-testid="select-grade-filter">
                <SelectValue placeholder="All Grades" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Grades</SelectItem>
                {gradeOptions.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {categoryOptions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-[170px] justify-between gap-2"
                  data-testid="select-category-filter"
                >
                  <span className="truncate">
                    {selectedCategory.length === 0
                      ? "All Categories"
                      : selectedCategory.length === 1
                        ? selectedCategory[0]
                        : `${selectedCategory.length} Categories`}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[220px]">
                {categoryOptions.map((category) => {
                  const checked = selectedCategory.includes(category);
                  return (
                    <DropdownMenuItem
                      key={category}
                      className="cursor-pointer gap-2"
                      onSelect={(event) => {
                        event.preventDefault();
                        setSelectedCategory((current) =>
                          checked ? current.filter((value) => value !== category) : [...current, category]
                        );
                      }}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span className="truncate">{category}</span>
                    </DropdownMenuItem>
                  );
                })}
                {selectedCategory.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer justify-center text-xs text-muted-foreground"
                      onSelect={(event) => {
                        event.preventDefault();
                        setSelectedCategory([]);
                      }}
                    >
                      Clear categories
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {supplierOptions.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-[180px] justify-between gap-2"
                  data-testid="select-supplier-filter"
                >
                  <span className="truncate">
                    {selectedSupplier.length === 0
                      ? "All Suppliers"
                      : selectedSupplier.length === 1
                        ? selectedSupplier[0]
                        : `${selectedSupplier.length} Suppliers`}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[240px]">
                {supplierOptions.map((supplier) => {
                  const checked = selectedSupplier.includes(supplier);
                  return (
                    <DropdownMenuItem
                      key={supplier}
                      className="cursor-pointer gap-2"
                      onSelect={(event) => {
                        event.preventDefault();
                        setSelectedSupplier((current) =>
                          checked ? current.filter((value) => value !== supplier) : [...current, supplier]
                        );
                      }}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span className="truncate">{supplier}</span>
                    </DropdownMenuItem>
                  );
                })}
                {selectedSupplier.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer justify-center text-xs text-muted-foreground"
                      onSelect={(event) => {
                        event.preventDefault();
                        setSelectedSupplier([]);
                      }}
                    >
                      Clear suppliers
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>
      )}

      {/* Content */}
      {filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
            <Ship className="w-7 h-7 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-1">No stock on the way</h2>
          <p className="text-sm text-muted-foreground">
            {stockItems.length === 0
              ? "There are no containers currently in transit"
              : "No items match your search criteria"}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table — borderless card, full-width */}
          <div className="hidden md:block">
            <Table wrapperClassName="max-h-[calc(100vh-300px)]">
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="w-10 pl-4"></TableHead>
                  <TableHead>Item Name</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item, index) => {
                  const isExpanded = expandedItems.has(item.stockItemName);
                  const uniqueSuppliers = Array.from(new Set(item.containers.map((c) => c.supplierName)));
                  return (
                    <Fragment key={item.stockItemName}>
                      <TableRow
                        data-testid={`row-item-${index}`}
                        className="hover-elevate cursor-pointer"
                        onClick={() => toggleItemExpanded(item.stockItemName)}
                      >
                        <TableCell className="pl-4">
                          <Button variant="ghost" size="icon" data-testid={`button-expand-${index}`}>
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                        </TableCell>
                        <TableCell className="font-medium">
                          <div>{item.stockItemName}</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {item.gradeName && (
                              <Badge variant="outline" className="text-xs" data-testid={`grade-${index}`}>
                                {item.gradeName}
                              </Badge>
                            )}
                            {item.categoryName && (
                              <Badge variant="secondary" className="text-xs" data-testid={`category-${index}`}>
                                {item.categoryName}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {item.containerCount} container{item.containerCount !== 1 ? "s" : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {Math.round(item.totalQuantity).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatAmount(item.totalCost)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {uniqueSuppliers.length === 1
                            ? uniqueSuppliers[0]
                            : `${uniqueSuppliers[0]} +${uniqueSuppliers.length - 1}`}
                        </TableCell>
                      </TableRow>
                      {isExpanded &&
                        item.containers.map((container, containerIndex) => (
                          <TableRow
                            key={`${item.stockItemName}-${containerIndex}`}
                            className="bg-muted/30"
                            data-testid={`row-container-${index}-${containerIndex}`}
                          >
                            <TableCell className="pl-4"></TableCell>
                            <TableCell className="pl-10 text-sm">
                              <span className="font-mono text-foreground">{container.containerNumber}</span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {Math.round(container.quantity).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatAmount(container.rate)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
              <TableFooter className="bg-muted/40">
                <TableRow className="font-semibold">
                  <TableCell className="pl-4"></TableCell>
                  <TableCell>Total ({uniqueItemCount} items)</TableCell>
                  <TableCell className="text-right font-mono" data-testid="text-summary-quantity">
                    {Math.round(totalQuantity).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid="text-summary-value">
                    {formatAmount(displayTotal)}
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filteredItems.map((item, index) => {
              const isExpanded = expandedItems.has(item.stockItemName);
              const uniqueSuppliers = Array.from(new Set(item.containers.map((c) => c.supplierName)));
              return (
                <div key={item.stockItemName} data-testid={`row-item-${index}`}>
                  <div
                    className="bg-card border rounded-xl p-4 cursor-pointer hover-elevate"
                    onClick={() => toggleItemExpanded(item.stockItemName)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{item.stockItemName}</div>
                          {(item.gradeName || item.categoryName) && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {item.gradeName && (
                                <Badge variant="outline" className="text-xs" data-testid={`grade-mobile-${index}`}>
                                  {item.gradeName}
                                </Badge>
                              )}
                              {item.categoryName && (
                                <Badge variant="secondary" className="text-xs" data-testid={`category-mobile-${index}`}>
                                  {item.categoryName}
                                </Badge>
                              )}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {item.containerCount} container{item.containerCount !== 1 ? "s" : ""} ·{" "}
                            {uniqueSuppliers.length === 1
                              ? uniqueSuppliers[0]
                              : `${uniqueSuppliers[0]} +${uniqueSuppliers.length - 1}`}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono font-semibold">{formatAmount(item.totalCost)}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {Math.round(item.totalQuantity).toLocaleString()} units
                        </p>
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="ml-4 mt-1 space-y-1">
                      {item.containers.map((container, containerIndex) => (
                        <div
                          key={containerIndex}
                          className="px-4 py-2 rounded-lg bg-muted/40 text-xs flex justify-between items-center"
                          data-testid={`row-container-${index}-${containerIndex}`}
                        >
                          <div>
                            <span className="font-mono font-medium">{container.containerNumber}</span>
                          </div>
                          <div className="font-mono text-right">
                            <span>{Math.round(container.quantity).toLocaleString()}</span>
                            <span className="text-muted-foreground mx-1">·</span>
                            <span>{formatAmount(container.cost)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Mobile total row */}
            <div className="bg-muted/40 rounded-xl px-4 py-3 flex justify-between items-center">
              <span className="text-sm font-semibold">Total ({uniqueItemCount} items)</span>
              <div className="text-right">
                <p className="text-sm font-mono font-semibold">{formatAmount(displayTotal)}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {Math.round(totalQuantity).toLocaleString()} units
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function StockOTW() {
  const [showCombined, setShowCombined] = useState(false);
  return <StockOTWContent showCombined={showCombined} onToggleCombined={() => setShowCombined((v) => !v)} />;
}
