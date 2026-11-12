import { Boxes, DollarSign, Gauge, Layers, Package, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InventoryTable } from "./InventoryTable";
import type { InventoryItem, StockGroupSummary } from "./locationInventoryTypes";
import type { AuthMe } from "@shared/apiTypes";

interface StockGroupItemsViewProps {
  selectedGroup: StockGroupSummary;
  posUser?: AuthMe;
  canViewCost: boolean;
  formatAmount: (v: number) => string;
  setArchiveDialogOpen: (v: boolean) => void;
  /** False for read-only roles: hides Archive Group. */
  canChangeExistingRecords?: boolean;
  itemSearchTerm: string;
  setItemSearchTerm: (v: string) => void;
  itemCategoryFilter: string[];
  setItemCategoryFilter: (v: string[]) => void;
  categoriesList: { id: number; name: string; active: boolean }[];
  filteredStockItems: InventoryItem[];
  showMovement: boolean;
  openingInventoryMap: Map<number, number>;
  selectedRowIndex: number;
  setSelectedRowIndex: (v: number) => void;
  navigate: (path: string) => void;
  inventory: InventoryItem[];
}

export function StockGroupItemsView({
  selectedGroup,
  posUser,
  canViewCost,
  formatAmount,
  setArchiveDialogOpen,
  canChangeExistingRecords = true,
  itemSearchTerm,
  setItemSearchTerm,
  itemCategoryFilter,
  setItemCategoryFilter,
  categoriesList,
  filteredStockItems,
  showMovement,
  openingInventoryMap,
  selectedRowIndex,
  setSelectedRowIndex,
  navigate,
  inventory,
}: StockGroupItemsViewProps) {
  return (
    <>
      {/* Group identity and restricted actions */}
      <section
        className="relative isolate overflow-hidden rounded-2xl border border-violet-200/70 bg-gradient-to-r from-violet-50 via-background to-blue-50/70 px-4 py-4 shadow-sm dark:border-violet-400/20 dark:from-violet-950/40 dark:via-slate-950/70 dark:to-blue-950/30 sm:px-5"
        aria-label="Selected stock group"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-24 h-52 w-72 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/20"
        />
        <div className="relative flex flex-wrap items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-violet-300/40 bg-violet-500/10 text-violet-700 shadow-sm dark:border-violet-400/25 dark:bg-violet-400/20 dark:text-violet-200">
            <Layers className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-700/80 dark:text-violet-300/80">
              Stock group
            </p>
            <h2 className="truncate text-xl font-bold tracking-tight sm:text-2xl" data-testid="stock-group-title">
              {selectedGroup.groupName}
            </h2>
            <p className="text-xs text-muted-foreground">
              {selectedGroup.itemCount.toLocaleString()} items ·{" "}
              {Math.floor(selectedGroup.totalQuantity).toLocaleString()} BL total
            </p>
          </div>
          {!posUser && canChangeExistingRecords && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-9 gap-1.5 rounded-xl border-rose-300/60 bg-background/70 text-rose-700 shadow-sm hover:bg-rose-50 dark:border-rose-500/30 dark:bg-rose-950/20 dark:text-rose-300 dark:hover:bg-rose-950/50"
              onClick={() => setArchiveDialogOpen(true)}
              data-testid="button-archive-group"
            >
              <Trash2 className="h-4 w-4" /> Archive Group
            </Button>
          )}
        </div>
      </section>

      {/* KPI tiles respect the same cost visibility capability as the table */}
      <div
        className={canViewCost ? "grid grid-cols-2 gap-3 xl:grid-cols-4" : "grid grid-cols-2 gap-3"}
        aria-label="Group inventory summary"
      >
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-50 to-sky-100/60 p-3 shadow-sm dark:border-blue-400/25 dark:from-blue-950/60 dark:to-sky-900/25 sm:p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-700 dark:text-blue-300">
            <Package className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Items</p>
            <p className="truncate text-xl font-bold tabular-nums sm:text-2xl">
              {selectedGroup.itemCount.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 to-purple-100/60 p-3 shadow-sm dark:border-violet-400/25 dark:from-violet-950/60 dark:to-purple-900/25 sm:p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-700 dark:text-violet-300">
            <Boxes className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Total BL</p>
            <p className="truncate text-xl font-bold tabular-nums sm:text-2xl">
              {Math.floor(selectedGroup.totalQuantity).toLocaleString()} <span className="text-sm font-medium">BL</span>
            </p>
          </div>
        </div>
        {canViewCost && (
          <>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-100/60 p-3 shadow-sm dark:border-emerald-400/25 dark:from-emerald-950/60 dark:to-teal-900/25 sm:p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                <DollarSign className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Total Value</p>
                <p
                  className="truncate text-lg font-bold tabular-nums sm:text-xl"
                  title={formatAmount(selectedGroup.totalValue)}
                >
                  {formatAmount(selectedGroup.totalValue)}
                </p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50 to-orange-100/60 p-3 shadow-sm dark:border-amber-400/25 dark:from-amber-950/50 dark:to-orange-900/25 sm:p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
                <Gauge className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Avg Rate / BL</p>
                <p className="truncate text-lg font-bold tabular-nums sm:text-xl">
                  {formatAmount(selectedGroup.averageRate)}
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Search + category */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-card/80 p-3 shadow-sm sm:p-3.5">
        <div className="relative min-w-[180px] flex-1 sm:max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items by name..."
            value={itemSearchTerm}
            onChange={(e) => setItemSearchTerm(e.target.value)}
            className="h-10 rounded-xl border-border/70 bg-background/80 pl-10 shadow-sm focus-visible:ring-violet-400/50"
            data-testid="input-item-search"
          />
        </div>
        <Select
          value={itemCategoryFilter[0] || "all"}
          onValueChange={(v) => setItemCategoryFilter(v === "all" ? [] : [v])}
        >
          <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/80 shadow-sm sm:w-56">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="none">Uncategorized</SelectItem>
            {categoriesList.map((cat) => (
              <SelectItem key={cat.id} value={String(cat.id)}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <InventoryTable
        filteredStockItems={filteredStockItems}
        showMovement={showMovement}
        openingInventoryMap={openingInventoryMap}
        selectedRowIndex={selectedRowIndex}
        setSelectedRowIndex={setSelectedRowIndex}
        navigate={navigate}
        formatAmount={formatAmount}
        canViewCost={canViewCost}
        itemSearchTerm={itemSearchTerm}
        inventory={inventory}
        selectedGroup={selectedGroup}
      />
    </>
  );
}
