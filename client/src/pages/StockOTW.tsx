import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { isBlockingQueryError } from "@/lib/abortError";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SearchField } from "@/components/ui/search-field";
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
import { Package, Ship, AlertCircle, ChevronRight, ChevronDown, X, Layers, FileDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Container } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import type { SpContainerWithLines } from "./containers/types";
import { PageHeader } from "@/components/PageHeader";
import CombinedInventory from "@/pages/CombinedInventory";
import { exportStockOtwExcel } from "./stockotw/exportStockOtwExcel";
import {
  expandStockOtwWirePayload,
  type GroupedStockItem,
  type StockItem,
  type StockOtwWirePayload,
} from "@/lib/stockOtwWirePayload";

function StockOTWContent({ showCombined, onToggleCombined }: { showCombined: boolean; onToggleCombined: () => void }) {
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";
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
    // This page only needs OTW id/status/grandTotal. Keep the compact profile
    // in queryKey[0] because the shared React Query fetcher uses that element
    // as the literal request URL.
    queryKey: ["/api/containers?profile=otw-summary"],
  });

  // Single bulk query replaces the N-per-container useQueries fan-out
  const {
    data: otwItemsRaw = [],
    isLoading: loadingOtwItems,
    error: otwItemsError,
    refetch: refetchOtwItems,
  } = useQuery<StockOtwWirePayload, Error, StockItem[]>({
    // Request the dictionary-compressed contract explicitly. Production data
    // has thousands of item/container pairs, so even the older flat compact
    // profile can exceed the operational response budget.
    queryKey: ["/api/containers/otw-items?profile=stock-otw-v2"],
    select: expandStockOtwWirePayload,
  });

  // Native SP containers live outside regular ERP container/PO tables.
  const {
    data: spContainers = [],
    isLoading: loadingSpContainers,
    error: spContainersError,
    refetch: refetchSpContainers,
  } = useQuery<SpContainerWithLines[]>({
    queryKey: ["/api/sp/containers"],
    queryFn: async () => {
      const response = await fetch("/api/sp/containers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load Supplier Partner containers");
      return response.json();
    },
    enabled: !!selectedCompany?.id && isSupplierPartner,
  });
  const otwContainers = useMemo(() => containers.filter((c) => c.status === "OTW"), [containers]);
  const spOtwContainers = useMemo(() => {
    const erpNumbers = new Set(otwContainers.map((c) => c.containerNumber?.trim().toUpperCase()).filter(Boolean));
    // An imported PO may have both a native SP and an ERP representation.
    return spContainers.filter(
      (c) => c.status === "open" && (!c.containerNumber || !erpNumbers.has(c.containerNumber.trim().toUpperCase()))
    );
  }, [otwContainers, spContainers]);
  const otwContainerCount = otwContainers.length + spOtwContainers.length;
  const isLoading = loadingContainers || loadingOtwItems || (isSupplierPartner && loadingSpContainers);
  // A failed background refetch leaves the last good data on screen and an error
  // beside it, and a cancelled request is not a failure at all. Report only what
  // actually left the page without data.
  const containersFailed = isBlockingQueryError(containersError, containers.length > 0);
  const otwItemsFailed = isBlockingQueryError(otwItemsError, otwItemsRaw.length > 0);
  const spContainersFailed = isSupplierPartner && isBlockingQueryError(spContainersError, spContainers.length > 0);
  const hasErrors = containersFailed || otwItemsFailed || spContainersFailed;

  const retryFailedQueries = () => {
    if (containersFailed) void refetchContainers();
    if (otwItemsFailed) void refetchOtwItems();
    if (spContainersFailed) void refetchSpContainers();
  };

  const stockItems: StockItem[] = useMemo(() => {
    const nativeLines: StockItem[] = [];
    for (const container of spOtwContainers) {
      const factor = 1 - Number(container.discountPct || 0) / 100;
      for (const line of container.lines ?? []) {
        const qty = Number(line.qty || 0);
        const rate = Number(line.unitRateUsd || 0) * factor;
        nativeLines.push({
          stockItemCode: line.articleCode || "",
          stockItemName: line.description || line.articleCode || "Unnamed item",
          quantity: String(qty),
          totalCost: String(qty * rate),
          rate: String(rate),
          containerNumber: container.containerNumber || container.invoiceNumber || "SP #" + container.id,
          supplierName: container.supplierName || "",
          importDate: container.invoiceDate || "",
          gradeId: null,
          gradeName: null,
          categoryId: null,
          categoryName: null,
        });
      }
    }
    return [...otwItemsRaw, ...nativeLines];
  }, [otwItemsRaw, spOtwContainers]);

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
    return (
      searchAny(searchTerm, item.stockItemName, item.gradeName, item.categoryName) ||
      item.containers.some((c) => searchAny(searchTerm, c.containerNumber, c.supplierName))
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

  const containerGrandTotal =
    otwContainers.reduce((sum, c) => sum + parseFloat(c.grandTotal || "0"), 0) +
    spOtwContainers.reduce((sum, c) => sum + parseFloat(c.invoiceTotalUsd || "0"), 0);
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
      await exportStockOtwExcel({
        filteredItems,
        otwContainerCount,
        totalQuantity,
        displayTotal,
        formatAmount,
        searchTerm,
        selectedGrade,
        selectedCategory,
        selectedSupplier,
      });
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
              {spContainersFailed ? "Failed to load Supplier Partner containers. " : ""}
            </span>
            <Button variant="outline" size="sm" onClick={retryFailedQueries} data-testid="button-otw-retry">
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Stats bar */}
      {otwContainerCount > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 bg-blue-500/10 rounded-lg px-3 py-2">
            <Ship className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <span
              className="text-sm font-semibold text-blue-700 dark:text-blue-300"
              data-testid="text-containers-count"
            >
              {otwContainerCount}
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
          <SearchField
            placeholder="Search by name, container, supplier, grade or category..."
            value={searchTerm}
            onValueChange={setSearchTerm}
            wrapperClassName="flex-1 min-w-[200px]"
            data-testid="input-search"
          />
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
          <div className="hidden md:block phone-land:hidden">
            <Table>
              <TableHeader className="bg-muted">
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
                        className="hover-elevate cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        tabIndex={0}
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} containers for ${item.stockItemName}`}
                        onClick={() => toggleItemExpanded(item.stockItemName)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleItemExpanded(item.stockItemName);
                          }
                        }}
                      >
                        <TableCell className="pl-4">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} containers for ${item.stockItemName}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleItemExpanded(item.stockItemName);
                            }}
                            data-testid={`button-expand-${index}`}
                          >
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
          <div className="md:hidden phone-land:block space-y-2">
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
