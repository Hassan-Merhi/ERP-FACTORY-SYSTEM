import { Package, Warehouse, Search, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

interface CombinedStockViewProps {
  allInventoryLoading: boolean;
  filteredCombinedRows: any[];
  allInventoryData: any[];
  allInventoryLocations: any[];
  allInventoryGroups: any[];
  /** Full location list from /api/locations — used for the dropdown so empty locations are still visible */
  allLocations?: any[];
  categoriesList: any[];
  allStockSearchTerm: string;
  setAllStockSearchTerm: (s: string) => void;
  allStockGroupFilter: string;
  setAllStockGroupFilter: (s: string) => void;
  allStockLocationFilter: string;
  setAllStockLocationFilter: (s: string) => void;
  allStockCategoryFilter: string[];
  setAllStockCategoryFilter: (cats: string[] | ((prev: string[]) => string[])) => void;
  allStockSelectedRowIndex: number;
  openMovement: (locId: number | null, locName: string | null, stockItemId: number, stockItemName: string) => void;
  formatAmount: (amt: number) => string;
  posUser?: AuthMe;
  allStockTableRef: React.RefObject<HTMLDivElement | null>;
}

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
  // Table columns: locations that actually have stock (derived from inventory data)
  const uniqueLocationNames = Array.from(new Map(allInventoryLocations.map((l) => [l.name, l])).values());

  // Dropdown options: full location list so empty locations are still selectable.
  // Falls back to inventory-derived list if allLocations wasn't passed.
  const dropdownLocations =
    allLocations && allLocations.length > 0
      ? [...allLocations].sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      : uniqueLocationNames;
  // Deduplicate categories by id (guard against any API-level duplicates)
  const uniqueCategories = Array.from(new Map(categoriesList.map((c) => [c.id, c])).values());

  // Columns are always deduplicated by name so same-name locations never produce duplicate headers
  const visibleLocations = allStockLocationFilter
    ? uniqueLocationNames.filter((l) => l.name === allStockLocationFilter)
    : uniqueLocationNames;

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
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items by name or code..."
              value={allStockSearchTerm}
              onChange={(e) => setAllStockSearchTerm(e.target.value)}
              className="pl-10"
              data-testid="input-all-stock-search"
            />
          </div>
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
          <div
            className="w-full overflow-auto max-h-[calc(100vh-200px)]"
            ref={allStockTableRef as React.RefObject<HTMLDivElement>}
          >
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-30 bg-muted/50">
                <tr className="bg-muted/60 border-b">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap sticky left-0 bg-muted/60 z-10">
                    Item Name
                  </th>
                  {uniqueCategories.length > 0 && (
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
                      Category
                    </th>
                  )}
                  {visibleLocations.map((loc) => (
                    <th
                      key={loc.name}
                      className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap"
                    >
                      {loc.name}
                    </th>
                  ))}
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap border-l">
                    Total
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
                    Avg Cost
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
                    Total Value
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(() => {
                  const rows = [];
                  let lastGroup = "";
                  let rowIdx = 0;
                  for (const row of filteredCombinedRows) {
                    const currentIdx = rowIdx++;
                    // Group separator when group changes
                    if (!allStockGroupFilter && row.stockGroupName !== lastGroup) {
                      lastGroup = row.stockGroupName;
                      const groupRows = filteredCombinedRows.filter((r) => r.stockGroupName === row.stockGroupName);
                      const groupTotal = groupRows.reduce((s, r) => s + r.totalQty, 0);
                      const groupValue = groupRows.reduce((s, r) => s + r.totalValue, 0);
                      rows.push(
                        <tr key={`group-${row.stockGroupName}`} className="bg-muted/30">
                          <td
                            colSpan={visibleLocations.length + 4 + (uniqueCategories.length > 0 ? 1 : 0)}
                            className="px-4 py-1.5 sticky left-0 bg-muted/30 z-10"
                          >
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                {row.stockGroupName}
                                <span className="ml-2 font-normal normal-case text-muted-foreground/70">
                                  ({groupRows.length} item{groupRows.length !== 1 ? "s" : ""})
                                </span>
                              </span>
                              <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                                {groupTotal.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}{" "}
                                units
                                {groupValue > 0 && <span className="ml-3">{formatAmount(groupValue)}</span>}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    const isSelected = allStockSelectedRowIndex === currentIdx;
                    rows.push(
                      <tr
                        key={row.stockItemId}
                        className={cn(
                          "transition-colors",
                          isSelected ? "bg-accent text-accent-foreground" : "hover-elevate"
                        )}
                        data-testid={`row-allstock-${row.stockItemId}`}
                        data-allstock-row-index={currentIdx}
                      >
                        <td
                          className={cn(
                            "px-4 py-2 font-medium whitespace-nowrap sticky left-0 z-10 transition-colors cursor-pointer",
                            isSelected ? "bg-accent" : "bg-background"
                          )}
                          title="View stock movement across all locations"
                          onClick={() => openMovement(null, null, row.stockItemId, row.stockItemName)}
                          data-testid={`button-allstock-name-${row.stockItemId}`}
                        >
                          <span className="hover:underline">{row.stockItemName}</span>
                        </td>
                        {uniqueCategories.length > 0 && (
                          <td
                            className="px-4 py-2 whitespace-nowrap"
                            data-testid={`allstock-category-${row.stockItemId}`}
                          >
                            {row.categoryName ? (
                              <Badge variant="secondary" className="text-xs font-normal">
                                {row.categoryName}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground/40 text-xs">—</span>
                            )}
                          </td>
                        )}
                        {visibleLocations.map((loc) => {
                          const cellQty = row.qtyByLocationName[loc.name] || 0;
                          return (
                            <td
                              key={loc.name}
                              className="px-4 py-2 text-right font-mono whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline"
                              title={cellQty > 0 ? `View movement at ${loc.name}` : undefined}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (cellQty > 0) openMovement(loc.id, loc.name, row.stockItemId, row.stockItemName);
                              }}
                            >
                              {cellQty > 0 ? (
                                cellQty.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })
                              ) : (
                                <span className="text-muted-foreground/30">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-4 py-2 text-right font-mono font-semibold whitespace-nowrap border-l">
                          {row.totalQty.toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-muted-foreground whitespace-nowrap">
                          {row.avgCost > 0 ? (
                            formatAmount(row.avgCost)
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono whitespace-nowrap">
                          {row.totalValue > 0 ? (
                            <span className="font-medium">{formatAmount(row.totalValue)}</span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  return rows;
                })()}
              </tbody>
              {/* Grand total footer */}
              <tfoot>
                <tr className="bg-muted/50 border-t-2 font-semibold">
                  <td className="px-4 py-2.5 whitespace-nowrap sticky left-0 bg-muted/50 z-10">
                    Total ({filteredCombinedRows.length} items)
                  </td>
                  {uniqueCategories.length > 0 && <td className="px-4 py-2.5" />}
                  {visibleLocations.map((loc) => {
                    const locTotal = filteredCombinedRows.reduce((s, r) => s + (r.qtyByLocationName[loc.name] || 0), 0);
                    return (
                      <td
                        key={loc.name}
                        className="px-4 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground"
                      >
                        {locTotal > 0 ? (
                          locTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
                        ) : (
                          <span className="opacity-30">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap border-l">
                    {filteredCombinedRows
                      .reduce((s, r) => s + r.totalQty, 0)
                      .toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground">—</td>
                  <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap">
                    {formatAmount(filteredCombinedRows.reduce((s, r) => s + r.totalValue, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
