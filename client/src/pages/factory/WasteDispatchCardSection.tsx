// Extracted from ./WasteDispatch.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, History, Loader2, Printer, Search, Trash2 } from "lucide-react";
import type { WasteDispatchHistoryBale } from "./wastedispatch/types";
import { fmt, fmtKg } from "./wastedispatch/utils";
import { useWasteDispatchState } from "./useWasteDispatchState";

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
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-48 h-8 text-xs"
                data-testid="input-search-bales"
              />
            </div>
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

export function WasteDispatchCardSection2({
  expandedHistoryIds,
  handleHistoryPrint,
  history,
  setDeleteDispatchId,
  setShowAllHistory,
  showAllHistory,
  toggleHistoryItem,
}: Pick<
  ReturnType<typeof useWasteDispatchState>,
  | "expandedHistoryIds"
  | "handleHistoryPrint"
  | "history"
  | "setDeleteDispatchId"
  | "setShowAllHistory"
  | "showAllHistory"
  | "toggleHistoryItem"
>) {
  return (
    <Card>
      <CardHeader className="pb-2 px-4 pt-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" />
          Dispatch History
        </CardTitle>
        {history.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {history.length} dispatch{history.length !== 1 ? "es" : ""}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No dispatches yet.</p>
        ) : (
          <div className="divide-y">
            {(showAllHistory ? history : history.slice(0, 10)).map((d) => {
              const isOpen = expandedHistoryIds.has(d.id);
              const dispatchBales = d.bales || [];
              return (
                <div key={d.id}>
                  <div
                    className="flex items-center justify-between px-4 py-2.5 hover-elevate cursor-pointer"
                    onClick={() => toggleHistoryItem(d.id)}
                    data-testid={`row-dispatch-${d.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      <div>
                        <p className="font-semibold text-xs">{d.dispatchNumber}</p>
                        <p className="text-xs text-muted-foreground">{d.dispatchDate}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">
                        {d.totalBales} bale{d.totalBales !== 1 ? "s" : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {fmtKg(parseFloat(String(d.totalWeightKg || "0")))} kg
                      </span>
                      <Badge variant="outline" className="text-destructive border-destructive/30 text-xs">
                        {fmt(parseFloat(String(d.totalCostWrittenOff || "0")))}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 h-6 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleHistoryPrint(d);
                        }}
                        data-testid={`button-reprint-${d.id}`}
                      >
                        <Printer className="w-3 h-3" />
                        Print
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteDispatchId(d.id);
                        }}
                        data-testid={`button-delete-dispatch-${d.id}`}
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="bg-muted/30 px-4 pb-4 pt-1">
                      {d.notes && (
                        <p className="text-xs text-muted-foreground mb-2">
                          <span className="font-medium">Note:</span> {d.notes}
                        </p>
                      )}
                      {dispatchBales.length > 0 ? (
                        <table className="w-full text-xs mt-1 border-collapse">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-1.5 font-semibold text-muted-foreground">Reference</th>
                              <th className="text-left py-1.5 font-semibold text-muted-foreground">Product</th>
                              <th className="text-right py-1.5 font-semibold text-muted-foreground">Weight (kg)</th>
                              <th className="text-right py-1.5 font-semibold text-muted-foreground">Cost W/O</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dispatchBales.map((b: WasteDispatchHistoryBale) => (
                              <tr key={b.id} className="border-b border-border/40 last:border-0">
                                <td className="py-1 font-mono text-primary">{b.referenceNumber}</td>
                                <td className="py-1">{b.productName}</td>
                                <td className="py-1 text-right">{fmtKg(parseFloat(String(b.weightKg || "0")))}</td>
                                <td className="py-1 text-right">{fmt(parseFloat(String(b.totalCost || "0")))}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t font-semibold">
                              <td className="pt-1.5" colSpan={2}>
                                TOTAL — {dispatchBales.length} bale{dispatchBales.length !== 1 ? "s" : ""}
                              </td>
                              <td className="pt-1.5 text-right">
                                {fmtKg(
                                  dispatchBales.reduce(
                                    (s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.weightKg || 0)),
                                    0
                                  )
                                )}
                              </td>
                              <td className="pt-1.5 text-right text-destructive">
                                {fmt(
                                  dispatchBales.reduce(
                                    (s: number, b: WasteDispatchHistoryBale) =>
                                      s + parseFloat(String(b.totalCost || 0)),
                                    0
                                  )
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      ) : (
                        <p className="text-xs text-muted-foreground">No bale details available.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {history.length > 10 && (
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {showAllHistory
                    ? `Showing all ${history.length} dispatches`
                    : `Showing 10 of ${history.length} dispatches`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-3"
                  onClick={() => setShowAllHistory((v) => !v)}
                  data-testid="button-toggle-history"
                >
                  {showAllHistory ? "Show less" : `Show all ${history.length}`}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
