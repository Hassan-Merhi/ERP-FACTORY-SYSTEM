// Extracted from ./StockOTW.tsx to keep that module under the source-size cap.
import { Fragment } from "react";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, ChevronDown, ChevronRight, FileDown, Layers, Package, Ship } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import CombinedInventory from "@/pages/CombinedInventory";
import { useStockOTWContentState } from "./useStockOTWContentState";
import { StockOTWContentSection } from "./StockOTWContentSection";

export function StockOTWContent(props: { showCombined: boolean; onToggleCombined: () => void }) {
  const {
    categoryOptions,
    clearFilters,
    containerGrandTotal,
    containersFailed,
    displayTotal,
    expandedItems,
    exportToExcel,
    filteredItems,
    formatAmount,
    gradeOptions,
    groupedItems,
    hasActiveFilters,
    hasErrors,
    isExporting,
    isLoading,
    onToggleCombined,
    otwContainerCount,
    otwItemsFailed,
    retryFailedQueries,
    searchTerm,
    selectedCategory,
    selectedGrade,
    selectedSupplier,
    setSearchTerm,
    setSelectedCategory,
    setSelectedGrade,
    setSelectedSupplier,
    showCombined,
    spContainersFailed,
    stockItems,
    supplierOptions,
    toggleItemExpanded,
    totalQuantity,
    uniqueItemCount,
  } = useStockOTWContentState(props);

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
        <StockOTWContentSection
          categoryOptions={categoryOptions}
          clearFilters={clearFilters}
          gradeOptions={gradeOptions}
          hasActiveFilters={hasActiveFilters}
          searchTerm={searchTerm}
          selectedCategory={selectedCategory}
          selectedGrade={selectedGrade}
          selectedSupplier={selectedSupplier}
          setSearchTerm={setSearchTerm}
          setSelectedCategory={setSelectedCategory}
          setSelectedGrade={setSelectedGrade}
          setSelectedSupplier={setSelectedSupplier}
          supplierOptions={supplierOptions}
        />
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
