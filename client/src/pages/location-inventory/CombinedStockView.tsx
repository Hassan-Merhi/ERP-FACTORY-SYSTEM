import { Package, Warehouse, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchField } from "@/components/ui/search-field";
import type { CombinedStockViewProps } from "./CombinedStockViewTypes";
import { useCombinedStockViewState } from "./useCombinedStockViewState";
import { CombinedStockViewContent } from "./CombinedStockViewContent";

export function CombinedStockView({
  allInventoryLoading,
  filteredCombinedRows,
  allInventoryData,
  allInventoryLocations,
  allInventoryGroups,
  allLocations,
  categoriesList,
  allStockSearchTerm,
  setAllStockSearchTerm,
  allStockGroupFilter,
  setAllStockGroupFilter,
  allStockLocationFilter,
  setAllStockLocationFilter,
  allStockCategoryFilter,
  setAllStockCategoryFilter,
  allStockSelectedRowIndex,
  openMovement,
  formatAmount,
  posUser,
  allStockTableRef,
}: CombinedStockViewProps) {
  const { mobileCards, uniqueLocationNames, dropdownLocations, uniqueCategories, visibleLocations } =
    useCombinedStockViewState({ allInventoryLocations, allLocations, categoriesList, allStockLocationFilter });

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      {!allInventoryLoading && filteredCombinedRows.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{filteredCombinedRows.length.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground">Items</span>
          </div>
          <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
            <Warehouse className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{uniqueLocationNames.length.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground">Locations</span>
          </div>
          {!posUser && (
            <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
              <span className="text-sm font-semibold font-mono text-primary">
                {formatAmount(filteredCombinedRows.reduce((s, r) => s + r.totalValue, 0))}
              </span>
              <span className="text-xs text-muted-foreground">total value</span>
            </div>
          )}
        </div>
      )}

      <Card className="w-full">
        {/* Filters row */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-3 p-4 border-b">
          <SearchField
            placeholder="Search items by name or code..."
            value={allStockSearchTerm}
            onValueChange={setAllStockSearchTerm}
            wrapperClassName="flex-1 min-w-48"
            data-testid="input-all-stock-search"
          />
          <Select
            value={allStockGroupFilter || "__all__"}
            onValueChange={(v) => setAllStockGroupFilter(v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="w-full sm:w-48" data-testid="select-all-stock-group">
              <SelectValue placeholder="All Groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Groups</SelectItem>
              {allInventoryGroups.map((g) => (
                <SelectItem key={String(g.id)} value={g.id === null ? "null" : String(g.id)}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={allStockLocationFilter || "__all__"}
            onValueChange={(v) => setAllStockLocationFilter(v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="w-full sm:w-48" data-testid="select-all-stock-location">
              <SelectValue placeholder="All Locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Locations</SelectItem>
              {dropdownLocations.map((loc) => (
                <SelectItem key={loc.id ?? loc.name} value={loc.name}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {uniqueCategories.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full sm:w-48 justify-between font-normal"
                  data-testid="select-all-stock-category"
                >
                  <span className="truncate">
                    {allStockCategoryFilter.length === 0
                      ? "All Categories"
                      : allStockCategoryFilter.length === 1
                        ? allStockCategoryFilter[0] === "none"
                          ? "No Category"
                          : (uniqueCategories.find((c) => String(c.id) === allStockCategoryFilter[0])?.name ??
                            allStockCategoryFilter[0])
                        : `${allStockCategoryFilter.length} Categories`}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {uniqueCategories.map((cat) => {
                    const val = String(cat.id);
                    const checked = allStockCategoryFilter.includes(val);
                    return (
                      <div
                        key={cat.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md hover-elevate cursor-pointer"
                        onClick={() =>
                          setAllStockCategoryFilter((prev) =>
                            checked ? prev.filter((v) => v !== val) : [...prev, val]
                          )
                        }
                      >
                        <Checkbox checked={checked} />
                        <span className="text-sm">{cat.name}</span>
                      </div>
                    );
                  })}
                </div>
                {allStockCategoryFilter.length > 0 && (
                  <div className="border-t mt-2 pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => setAllStockCategoryFilter([])}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>

        {allInventoryLoading ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : filteredCombinedRows.length === 0 ? (
          <EmptyState
            icon={Package}
            title={allInventoryData.length === 0 ? "No stock found" : "No matching items"}
            description={
              allInventoryData.length === 0
                ? "Stock has not been recorded across any location yet."
                : "Try adjusting your search to see other items."
            }
          />
        ) : (
          <div className="w-full overflow-x-auto" ref={allStockTableRef as React.RefObject<HTMLDivElement>}>
            <CombinedStockViewContent
              allStockGroupFilter={allStockGroupFilter}
              allStockSelectedRowIndex={allStockSelectedRowIndex}
              filteredCombinedRows={filteredCombinedRows}
              formatAmount={formatAmount}
              mobileCards={mobileCards}
              openMovement={openMovement}
              uniqueCategories={uniqueCategories}
              visibleLocations={visibleLocations}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
