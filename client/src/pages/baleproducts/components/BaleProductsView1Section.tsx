// Extracted from ./BaleProductsView1.tsx to keep that module under the source-size cap.
import { AlertCircle, ChevronDown, Eye, EyeOff, Layers3, Palette, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBaleProductsView1State } from "./useBaleProductsView1State";
import { SearchField } from "@/components/ui/search-field";

export function BaleProductsView1Section({
  bulkToggleActiveMutation,
  canChangeExistingRecords,
  categories,
  distinctWeights,
  filterCategoryId,
  filterWeight,
  hiddenProducts,
  hideSellingPriceBP,
  noColorCount,
  searchQuery,
  selectedActiveIds,
  selectedHiddenIds,
  selectedIds,
  setFilterCategoryId,
  setFilterWeight,
  setSearchQuery,
  setSelectedIds,
  setShowHidden,
  setShowNoColor,
  setShowZeroPrice,
  showHidden,
  showNoColor,
  showZeroPrice,
}: Pick<
  ReturnType<typeof useBaleProductsView1State>,
  | "bulkToggleActiveMutation"
  | "canChangeExistingRecords"
  | "categories"
  | "distinctWeights"
  | "filterCategoryId"
  | "filterWeight"
  | "hiddenProducts"
  | "hideSellingPriceBP"
  | "noColorCount"
  | "searchQuery"
  | "selectedActiveIds"
  | "selectedHiddenIds"
  | "selectedIds"
  | "setFilterCategoryId"
  | "setFilterWeight"
  | "setSearchQuery"
  | "setSelectedIds"
  | "setShowHidden"
  | "setShowNoColor"
  | "setShowZeroPrice"
  | "showHidden"
  | "showNoColor"
  | "showZeroPrice"
>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 bg-gradient-to-r from-slate-50 via-white to-blue-50/60 px-4 py-4 dark:border-blue-300/15 dark:from-[#142444] dark:via-[#111e36] dark:to-[#101b31]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-2.5 text-base font-bold tracking-tight text-slate-900 dark:text-white">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <Layers3 className="h-5 w-5" />
          </span>
          Product List
        </span>
        {selectedIds.size > 0 && (
          <>
            <span className="text-xs text-muted-foreground border-l pl-2">{selectedIds.size} selected</span>
            {canChangeExistingRecords && selectedActiveIds.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkToggleActiveMutation.mutate({ ids: selectedActiveIds, active: false })}
                disabled={bulkToggleActiveMutation.isPending}
                data-testid="button-bulk-hide"
              >
                <EyeOff className="h-3.5 w-3.5 mr-1" />
                Hide ({selectedActiveIds.length})
              </Button>
            )}
            {canChangeExistingRecords && selectedHiddenIds.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkToggleActiveMutation.mutate({ ids: selectedHiddenIds, active: true })}
                disabled={bulkToggleActiveMutation.isPending}
                data-testid="button-bulk-unhide"
              >
                <Eye className="h-3.5 w-3.5 mr-1" />
                Unhide ({selectedHiddenIds.length})
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              data-testid="button-clear-selection"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SearchField
          value={searchQuery}
          onValueChange={(value) => {
            setSearchQuery(value);
            setSelectedIds(new Set());
          }}
          placeholder="Search by name or code..."
          wrapperClassName="w-56"
          className="h-9 rounded-xl border-slate-300 bg-white/90 text-sm shadow-sm focus-visible:ring-blue-500 dark:border-blue-300/20 dark:bg-[#0d192c]"
          data-testid="input-search-products"
          clearTestId="button-clear-search"
        />
        {categories && categories.length > 0 && (
          <Select
            value={filterCategoryId === null ? "all" : String(filterCategoryId)}
            onValueChange={(val) => {
              setFilterCategoryId(val === "all" ? null : Number(val));
              setSelectedIds(new Set());
            }}
          >
            <SelectTrigger
              className="h-9 w-40 rounded-xl border-slate-300 bg-white/90 text-sm shadow-sm dark:border-blue-300/20 dark:bg-[#0d192c]"
              data-testid="select-filter-category"
            >
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {distinctWeights.length > 0 && (
          <Select
            value={filterWeight === null ? "all" : filterWeight}
            onValueChange={(val) => {
              setFilterWeight(val === "all" ? null : val);
              setSelectedIds(new Set());
            }}
          >
            <SelectTrigger
              className="h-9 w-32 rounded-xl border-slate-300 bg-white/90 text-sm shadow-sm dark:border-blue-300/20 dark:bg-[#0d192c]"
              data-testid="select-filter-weight"
            >
              <SelectValue placeholder="All weights" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All weights</SelectItem>
              {distinctWeights.map((w) => (
                <SelectItem key={w} value={w}>
                  {w} kg
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(() => {
          const activeFilterCount =
            (showZeroPrice && !hideSellingPriceBP ? 1 : 0) +
            (showNoColor && noColorCount > 0 ? 1 : 0) +
            (showHidden && hiddenProducts && hiddenProducts.length > 0 ? 1 : 0);
          const hasAnyFilter = !hideSellingPriceBP || noColorCount > 0 || (hiddenProducts && hiddenProducts.length > 0);
          if (!hasAnyFilter) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant={activeFilterCount > 0 ? "default" : "outline"}
                  className="h-9 rounded-xl shadow-sm"
                  data-testid="button-filters-dropdown"
                >
                  <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-xs no-default-active-elevate">
                      {activeFilterCount}
                    </Badge>
                  )}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Show in list</DropdownMenuLabel>
                {!hideSellingPriceBP && (
                  <DropdownMenuItem
                    onClick={() => {
                      setShowZeroPrice((v) => !v);
                      setSelectedIds(new Set());
                    }}
                    data-testid="menu-filter-unpriced"
                    className="flex items-center justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-muted-foreground" />
                      Unpriced products
                    </span>
                    {showZeroPrice && <span className="text-xs text-primary font-medium">On</span>}
                  </DropdownMenuItem>
                )}
                {noColorCount > 0 && (
                  <DropdownMenuItem
                    onClick={() => {
                      setShowNoColor((v) => !v);
                      setSelectedIds(new Set());
                    }}
                    data-testid="menu-filter-no-color"
                    className="flex items-center justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <Palette className="h-4 w-4 text-muted-foreground" />
                      No color ({noColorCount})
                    </span>
                    {showNoColor && <span className="text-xs text-primary font-medium">On</span>}
                  </DropdownMenuItem>
                )}
                {hiddenProducts && hiddenProducts.length > 0 && (
                  <DropdownMenuItem
                    onClick={() => {
                      setShowHidden(!showHidden);
                      setSelectedIds(new Set());
                    }}
                    data-testid="menu-filter-hidden"
                    className="flex items-center justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                      Hidden products ({hiddenProducts.length})
                    </span>
                    {showHidden && <span className="text-xs text-primary font-medium">On</span>}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })()}
      </div>
    </div>
  );
}
