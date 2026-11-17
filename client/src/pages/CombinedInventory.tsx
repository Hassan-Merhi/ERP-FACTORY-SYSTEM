import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, Search, ChevronRight, List, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { formatNumber } from "@/lib/formatNumber";
import { PageHeader } from "@/components/PageHeader";
import type { CombinedInventoryProps } from "./CombinedInventoryTypes";
import { useCombinedInventoryState } from "./useCombinedInventoryState";
import { GroupsView, ItemsTable } from "./CombinedInventoryItemsTable";

export default function CombinedInventory(props: CombinedInventoryProps) {
  const {
    drillGroup,
    filteredAll,
    formatAmount,
    groupItems,
    handleExport,
    headerActions,
    includeZero,
    inventoryRows,
    inventoryTotal,
    inventoryTotalPages,
    isDrillMode,
    isFetchingInventory,
    isLoading,
    isLoadingOtw,
    loadedOtwCount,
    otwContainers,
    refetchInventory,
    search,
    setIncludeZero,
    setSearch,
    setSelectedGroupId,
    setViewMode,
    stockGroups,
    totals,
    viewMode,
  } = useCombinedInventoryState(props);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-10 w-full rounded-md" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      {isDrillMode ? (
        <PageHeader
          title={drillGroup?.stockGroupName}
          icon={<FolderOpen className="h-5 w-5" />}
          onBack={() => setSelectedGroupId(undefined)}
          meta={
            <>
              <button
                type="button"
                className="hover:text-foreground transition-colors"
                onClick={() => setSelectedGroupId(undefined)}
                data-testid="button-back-to-groups"
              >
                Combined Inventory
              </button>
              <ChevronRight className="h-3 w-3" />
              <span className="text-foreground font-medium">{drillGroup?.stockGroupName}</span>
            </>
          }
        >
          {headerActions}
        </PageHeader>
      ) : (
        <PageHeader
          title="Combined Inventory"
          subtitle="In-transit (OTW) + in-hand stock combined per item"
          icon={<Layers className="h-5 w-5" />}
        >
          {headerActions}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchInventory()}
            disabled={isFetchingInventory}
            data-testid="button-refresh-inventory"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5${isFetchingInventory ? " animate-spin" : ""}`} />
            Refresh
          </Button>
          <ExportButton size="sm" onClick={handleExport} data-testid="button-export-excel" />
        </PageHeader>
      )}

      {/* Stats bar */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold" data-testid="stat-items">
            {totals.items.toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground">Items</span>
        </div>
        <div className="flex items-center gap-2 bg-blue-500/10 rounded-lg px-3 py-2">
          {isLoadingOtw ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /> : null}
          <span className="text-sm font-semibold font-mono text-blue-700 dark:text-blue-300" data-testid="stat-otw">
            {formatNumber(totals.otwQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            OTW Qty{isLoadingOtw ? ` (${loadedOtwCount}/${otwContainers.length})` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono" data-testid="stat-inhand">
            {formatNumber(totals.inHandQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">In-Hand Qty</span>
        </div>
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono" data-testid="stat-total">
            {formatNumber(totals.totalQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">Total Qty</span>
        </div>
        <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono text-primary">{formatAmount(totals.combinedValue)}</span>
          <span className="text-xs text-muted-foreground">Total Value</span>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={isDrillMode ? "Search items in this group..." : "Search stock items..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-combined"
          />
        </div>
        {!isDrillMode && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={viewMode === "groups" ? "default" : "outline"}
              onClick={() => {
                setViewMode("groups");
                setSelectedGroupId(undefined);
              }}
              data-testid="button-view-groups"
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              By Group
            </Button>
            <Button
              size="sm"
              variant={viewMode === "all" ? "default" : "outline"}
              onClick={() => setViewMode("all")}
              data-testid="button-view-all"
            >
              <List className="h-3.5 w-3.5 mr-1.5" />
              View All
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 cursor-pointer select-none" data-testid="toggle-include-zero">
          <Checkbox checked={includeZero} onCheckedChange={(v) => setIncludeZero(!!v)} id="include-zero" />
          <span className="text-sm text-muted-foreground">Include zero stock</span>
        </label>
        {isDrillMode && <ExportButton size="sm" onClick={handleExport} data-testid="button-export-excel" />}
      </div>

      {/* Partial-load notice — only shown when total rows exceed the first page */}
      {inventoryTotalPages > 1 && (
        <p className="text-xs text-muted-foreground -mt-2">
          Showing first {inventoryRows.length.toLocaleString()} of {inventoryTotal.toLocaleString()} inventory rows. Use
          search to narrow results, or click Refresh to reload.
        </p>
      )}

      {/* Content */}
      {viewMode === "groups" && !isDrillMode ? (
        <GroupsView
          groups={stockGroups}
          onSelectGroup={setSelectedGroupId}
          formatAmount={formatAmount}
          isLoadingOtw={isLoadingOtw}
        />
      ) : isDrillMode ? (
        <ItemsTable
          rows={groupItems}
          formatAmount={formatAmount}
          emptyMessage="No items match your search in this group."
        />
      ) : (
        <ItemsTable
          rows={filteredAll}
          formatAmount={formatAmount}
          emptyMessage="No stock items found. Try adjusting your search."
        />
      )}
    </div>
  );
}
