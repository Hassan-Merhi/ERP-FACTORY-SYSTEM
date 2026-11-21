// Extracted from ./StockOTW.tsx to keep that module under the source-size cap.
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, FileDown, Layers, Package, Ship } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import CombinedInventory from "@/pages/CombinedInventory";
import { useStockOTWContentState } from "./useStockOTWContentState";
import { StockOTWContentSection } from "./StockOTWContentSection";
import { StockOTWContentContent } from "./StockOTWContentContent";

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
        <StockOTWContentContent
          displayTotal={displayTotal}
          expandedItems={expandedItems}
          filteredItems={filteredItems}
          formatAmount={formatAmount}
          toggleItemExpanded={toggleItemExpanded}
          totalQuantity={totalQuantity}
          uniqueItemCount={uniqueItemCount}
        />
      )}
    </div>
  );
}
