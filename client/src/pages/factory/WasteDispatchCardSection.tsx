// Extracted from ./WasteDispatch.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { fmt, fmtKg } from "./wastedispatch/utils";
import { useWasteDispatchState } from "./useWasteDispatchState";
import { SearchField } from "@/components/ui/search-field";

export function WasteDispatchCardSection({
  bales,
  expandedGroups,
  grandTotals,
  isLoading,
  productGroups,
  search,
  selected,
  setSearch,
  toggleAll,
  toggleBale,
  toggleExpandGroup,
  toggleGroup,
}: Pick<
  ReturnType<typeof useWasteDispatchState>,
  | "bales"
  | "expandedGroups"
  | "grandTotals"
  | "isLoading"
  | "productGroups"
  | "search"
  | "selected"
  | "setSearch"
  | "toggleAll"
  | "toggleBale"
  | "toggleExpandGroup"
  | "toggleGroup"
>) {
  return (
    <Card>
      <CardHeader className="pb-2 px-4 pt-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <CardTitle className="text-sm">Available Waste Bales</CardTitle>
            {!isLoading && (
              <Badge variant="outline" className="text-xs">
                {bales.length} bales · {productGroups.length} products
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SearchField
              placeholder="Filter products..."
              value={search}
              onValueChange={setSearch}
              wrapperClassName="w-48"
              className="h-8 text-xs"
              data-testid="input-search-bales"
            />
            {bales.length > 0 && (
              <Button variant="outline" size="sm" onClick={toggleAll} className="text-xs h-8 px-3">
                {selected.size === bales.length ? "Deselect All" : "Select All"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : productGroups.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-25" />
            <p className="text-sm">No Garbage or Wiper bales in stock.</p>
            <p className="text-xs mt-1">Only bales with Garbage or Wiper category are eligible.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-8 py-2 px-3"></TableHead>
                  <TableHead className="py-2 px-3 text-xs">Product</TableHead>
                  <TableHead className="py-2 px-3 text-xs">Category</TableHead>
                  <TableHead className="py-2 px-3 text-right text-xs">Bales</TableHead>
                  <TableHead className="py-2 px-3 text-right text-xs">Weight (kg)</TableHead>
                  <TableHead className="py-2 px-3 text-right text-xs">Avg Rate</TableHead>
                  <TableHead className="py-2 px-3 text-right text-xs">Total Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productGroups.map((group) => {
                  const isExpanded = expandedGroups.has(group.key);
                  const groupSelectedCount = group.bales.filter((b) => selected.has(b.id)).length;
                  const allGroupSelected = groupSelectedCount === group.bales.length;
                  const someGroupSelected = groupSelectedCount > 0 && !allGroupSelected;

                  return (
                    <>
                      <TableRow
                        key={group.key}
                        className={`cursor-pointer font-medium ${allGroupSelected ? "bg-destructive/5" : someGroupSelected ? "bg-destructive/3" : ""} hover:bg-muted/30`}
                        data-testid={`row-group-${group.key}`}
                      >
                        <TableCell className="py-2 px-3">
                          <Checkbox
                            checked={allGroupSelected}
                            data-state={
                              someGroupSelected ? "indeterminate" : allGroupSelected ? "checked" : "unchecked"
                            }
                            onCheckedChange={() => toggleGroup(group)}
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`checkbox-group-${group.key}`}
                          />
                        </TableCell>
                        <TableCell className="py-2 px-3" onClick={() => toggleExpandGroup(group.key)}>
                          <div className="flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            )}
                            <span className="text-sm font-semibold">{group.productName}</span>
                            {groupSelectedCount > 0 && (
                              <Badge variant="outline" className="text-xs text-destructive border-destructive/30 ml-1">
                                {groupSelectedCount} selected
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="py-2 px-3" onClick={() => toggleExpandGroup(group.key)}>
                          <Badge variant="outline" className="text-xs">
                            {group.categoryName}
                          </Badge>
                        </TableCell>
                        <TableCell
                          className="py-2 px-3 text-right text-sm"
                          onClick={() => toggleExpandGroup(group.key)}
                        >
                          {group.bales.length}
                        </TableCell>
                        <TableCell
                          className="py-2 px-3 text-right text-sm"
                          onClick={() => toggleExpandGroup(group.key)}
                        >
                          {fmtKg(group.totalWeight)}
                        </TableCell>
                        <TableCell
                          className="py-2 px-3 text-right text-xs text-muted-foreground"
                          onClick={() => toggleExpandGroup(group.key)}
                        >
                          {group.avgRate > 0 ? fmt(group.avgRate) : "—"}
                        </TableCell>
                        <TableCell
                          className="py-2 px-3 text-right text-sm font-medium"
                          onClick={() => toggleExpandGroup(group.key)}
                        >
                          {group.totalCost > 0 ? fmt(group.totalCost) : "—"}
                        </TableCell>
                      </TableRow>

                      {isExpanded &&
                        group.bales.map((b) => (
                          <TableRow
                            key={b.id}
                            className={`cursor-pointer text-xs ${selected.has(b.id) ? "bg-destructive/8" : "bg-muted/10"} hover:bg-muted/20`}
                            onClick={() => toggleBale(b.id)}
                            data-testid={`row-bale-${b.id}`}
                          >
                            <TableCell className="py-1.5 px-3 pl-5" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={selected.has(b.id)}
                                onCheckedChange={() => toggleBale(b.id)}
                                data-testid={`checkbox-bale-${b.id}`}
                              />
                            </TableCell>
                            <TableCell className="py-1.5 px-3 pl-8" colSpan={2}>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-primary">
                                  {b.referenceNumber}
                                </span>
                                <span className="text-xs text-muted-foreground">{b.locationName}</span>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 px-3 text-right text-xs">1</TableCell>
                            <TableCell className="py-1.5 px-3 text-right text-xs">{fmtKg(b.weightKg)}</TableCell>
                            <TableCell className="py-1.5 px-3 text-right text-xs text-muted-foreground">
                              {b.totalCost > 0 ? fmt(b.totalCost) : "—"}
                            </TableCell>
                            <TableCell className="py-1.5 px-3 text-right text-xs">
                              {b.totalCost > 0 ? fmt(b.totalCost) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                    </>
                  );
                })}

                {/* Grand total row */}
                <TableRow className="bg-muted/50 font-bold border-t-2">
                  <TableCell className="py-2 px-3"></TableCell>
                  <TableCell className="py-2 px-3 text-xs" colSpan={2}>
                    TOTAL — {productGroups.length} product{productGroups.length !== 1 ? "s" : ""}
                  </TableCell>
                  <TableCell className="py-2 px-3 text-right text-xs">{grandTotals.bales}</TableCell>
                  <TableCell className="py-2 px-3 text-right text-xs">{fmtKg(grandTotals.weight)}</TableCell>
                  <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">
                    {grandTotals.bales > 0 && grandTotals.cost > 0 ? fmt(grandTotals.cost / grandTotals.bales) : "—"}
                  </TableCell>
                  <TableCell className="py-2 px-3 text-right text-xs">
                    {grandTotals.cost > 0 ? fmt(grandTotals.cost) : "—"}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
