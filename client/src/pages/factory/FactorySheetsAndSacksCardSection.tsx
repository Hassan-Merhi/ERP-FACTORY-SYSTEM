// Extracted from ./FactorySheetsAndSacks.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Layers, Loader2, MinusCircle, Pencil, Plus, PlusCircle, Trash2 } from "lucide-react";
import { fmtInt } from "./factorysheetsandsacks/utils";
import { useFactorySheetsAndSacksState } from "./useFactorySheetsAndSacksState";
import { formatUsd } from "@/lib/moneyDisplay";

export function FactorySheetsAndSacksCardSection({
  allVisibleSelected,
  canEdit,
  colTotals,
  columnVisible,
  filtered,
  isLoading,
  items,
  selectedIds,
  setDeductItem,
  setDeleteItem,
  setEditItem,
  setRestockItem,
  setSelectedIds,
  setShowAddDialog,
  someVisibleSelected,
  toggleVisibleSelection,
  typeBadge,
}: Pick<
  ReturnType<typeof useFactorySheetsAndSacksState>,
  | "allVisibleSelected"
  | "canEdit"
  | "colTotals"
  | "columnVisible"
  | "filtered"
  | "isLoading"
  | "items"
  | "selectedIds"
  | "setDeductItem"
  | "setDeleteItem"
  | "setEditItem"
  | "setRestockItem"
  | "setSelectedIds"
  | "setShowAddDialog"
  | "someVisibleSelected"
  | "toggleVisibleSelection"
  | "typeBadge"
>) {
  return (
    <Card className="rounded-none border-0 bg-transparent shadow-none">
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Layers className="h-10 w-10 mb-3 opacity-25" />
            <p className="text-sm font-medium">
              {items.length === 0 ? "No items yet. Add your first sheet or sack." : "No items match your search."}
            </p>
            {items.length === 0 && canEdit && (
              <Button variant="outline" className="mt-4" onClick={() => setShowAddDialog(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Item
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table
              mobileLayout="cards"
              data-testid="factory-sheets-sacks-table"
              wrapperClassName="rounded-none border-0"
              className="text-sm"
            >
              <TableHeader className="bg-slate-100 dark:bg-muted">
                <TableRow className="border-slate-200 bg-slate-100 hover:bg-slate-100 dark:border-slate-700 dark:bg-muted dark:hover:bg-muted">
                  <TableHead className="w-9 px-3">
                    <Checkbox
                      aria-label="Select all visible stock rows"
                      checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                      onCheckedChange={(checked) => toggleVisibleSelection(checked === true)}
                    />
                  </TableHead>
                  <TableHead className="w-7 px-1" />
                  <TableHead className="min-w-40 text-xs font-bold uppercase tracking-wide">Name</TableHead>
                  {columnVisible("type") && (
                    <TableHead className="text-xs font-bold uppercase tracking-wide">Type</TableHead>
                  )}
                  {columnVisible("size") && (
                    <TableHead className="text-xs font-bold uppercase tracking-wide">Size / Weight</TableHead>
                  )}
                  {columnVisible("packs") && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Qty (packs)</TableHead>
                  )}
                  {columnVisible("perPack") && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide"># / Pack</TableHead>
                  )}
                  {columnVisible("pieces") && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Total Pcs</TableHead>
                  )}
                  {columnVisible("price") && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Price / Pc</TableHead>
                  )}
                  {columnVisible("value") && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Total Value</TableHead>
                  )}
                  {columnVisible("notes") && (
                    <TableHead className="text-xs font-bold uppercase tracking-wide">Notes</TableHead>
                  )}
                  {canEdit && (
                    <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => {
                  const totalPcs = parseFloat(item.quantity || "0");
                  const totalVal = totalPcs * parseFloat(item.unitPrice || "0");
                  const bg = item.rowColor ? `${item.rowColor}18` : undefined;
                  const selected = selectedIds.includes(item.id);
                  return (
                    <TableRow
                      key={item.id}
                      data-state={selected ? "selected" : undefined}
                      className="border-slate-200/70 transition-colors hover:bg-indigo-50/70 dark:border-slate-700/60 dark:hover:bg-indigo-500/10"
                      style={bg ? { backgroundColor: bg } : undefined}
                    >
                      <TableCell className="px-3">
                        <Checkbox
                          aria-label={`Select ${item.name}`}
                          checked={selected}
                          onCheckedChange={(checked) =>
                            setSelectedIds((ids) =>
                              checked ? [...new Set([...ids, item.id])] : ids.filter((id) => id !== item.id)
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="px-1">
                        <span
                          className="inline-block h-3 w-3 rounded-full border border-black/10 shadow-sm dark:border-white/20"
                          style={{ backgroundColor: item.rowColor || "transparent" }}
                        />
                      </TableCell>
                      <TableCell className="font-semibold text-foreground">{item.name}</TableCell>
                      {columnVisible("type") && <TableCell>{typeBadge(item.type)}</TableCell>}
                      {columnVisible("size") && (
                        <TableCell className="text-muted-foreground">{item.size || "—"}</TableCell>
                      )}
                      {columnVisible("packs") && (
                        <TableCell className="text-right font-mono">{fmtInt(item.packQty)}</TableCell>
                      )}
                      {columnVisible("perPack") && (
                        <TableCell className="text-right font-mono">{fmtInt(item.pcsPerPack)}</TableCell>
                      )}
                      {columnVisible("pieces") && (
                        <TableCell className="text-right font-mono font-semibold">
                          {totalPcs > 0 ? totalPcs.toLocaleString("en-US") : "0"}
                        </TableCell>
                      )}
                      {columnVisible("price") && (
                        <TableCell className="text-right font-mono">
                          {formatUsd(parseFloat(String(item.unitPrice) || "0"), 2)}
                        </TableCell>
                      )}
                      {columnVisible("value") && (
                        <TableCell className="text-right font-mono font-semibold">{formatUsd(totalVal, 2)}</TableCell>
                      )}
                      {columnVisible("notes") && (
                        <TableCell className="max-w-[210px] truncate text-xs text-muted-foreground">
                          {item.notes || "—"}
                        </TableCell>
                      )}
                      {canEdit && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setRestockItem(item)}
                              title="Add Stock"
                              aria-label={`Add Stock ${item.name}`}
                              className="h-8 w-8 rounded-lg hover:bg-emerald-500/10"
                            >
                              <PlusCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeductItem(item)}
                              title="Deduct"
                              aria-label={`Deduct ${item.name}`}
                              className="h-8 w-8 rounded-lg hover:bg-amber-500/10"
                            >
                              <MinusCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditItem(item)}
                              title="Edit"
                              aria-label={`Edit ${item.name}`}
                              className="h-8 w-8 rounded-lg hover:bg-blue-500/10"
                            >
                              <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeleteItem(item)}
                              title="Delete"
                              aria-label={`Delete ${item.name}`}
                              className="h-8 w-8 rounded-lg hover:bg-red-500/10"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
              <tfoot className="border-t-2 border-indigo-200 bg-indigo-50/70 font-semibold dark:border-indigo-400/20 dark:bg-indigo-500/10">
                <tr>
                  <td className="px-3 py-3" />
                  <td className="px-1 py-3" />
                  <td className="px-4 py-3 text-sm">
                    Totals <span className="font-normal text-muted-foreground">({filtered.length} items)</span>
                  </td>
                  {columnVisible("type") && <td className="px-4 py-3" />}
                  {columnVisible("size") && <td className="px-4 py-3" />}
                  {columnVisible("packs") && (
                    <td className="px-4 py-3 text-right font-mono text-sm">
                      {colTotals.packQty > 0 ? colTotals.packQty.toLocaleString("en-US") : "—"}
                    </td>
                  )}
                  {columnVisible("perPack") && <td className="px-4 py-3" />}
                  {columnVisible("pieces") && (
                    <td className="px-4 py-3 text-right font-mono text-sm">{colTotals.pcs.toLocaleString("en-US")}</td>
                  )}
                  {columnVisible("price") && <td className="px-4 py-3" />}
                  {columnVisible("value") && (
                    <td className="px-4 py-3 text-right font-mono text-sm font-bold">
                      {formatUsd(colTotals.value, 2)}
                    </td>
                  )}
                  {columnVisible("notes") && <td className="px-4 py-3" />}
                  {canEdit && <td className="px-4 py-3" />}
                </tr>
              </tfoot>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
