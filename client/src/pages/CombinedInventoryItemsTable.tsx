// Extracted from ./CombinedInventory.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, FolderOpen, Layers } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import type { CombinedRow, StockGroupSummary } from "./CombinedInventoryTypes";

export function GroupsView({
  groups,
  onSelectGroup,
  formatAmount,
}: {
  groups: StockGroupSummary[];
  onSelectGroup: (id: number | null) => void;
  formatAmount: (v: number) => string;
  isLoadingOtw: boolean;
}) {
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
          <Layers className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No stock groups found</h2>
        <p className="text-sm text-muted-foreground">Try adjusting your search.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div
          key={g.stockGroupId ?? "__null__"}
          className="bg-card border rounded-xl p-4 flex items-center gap-4 cursor-pointer hover-elevate"
          onClick={() => onSelectGroup(g.stockGroupId)}
          data-testid={`row-group-${g.stockGroupId ?? "null"}`}
        >
          {/* Icon */}
          <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <FolderOpen className="h-5 w-5 text-primary" />
          </div>

          {/* Name + item count */}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm">{g.stockGroupName}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {g.itemCount} item{g.itemCount !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Stats */}
          <div className="hidden sm:flex items-center gap-6 shrink-0">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">OTW</p>
              {g.otwQty > 0 ? (
                <p className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400">
                  {formatNumber(g.otwQty, 0)}
                </p>
              ) : (
                <p className="text-sm font-mono text-muted-foreground">—</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">In-Hand</p>
              <p className="text-sm font-mono">{formatNumber(g.inHandQty, 0)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-sm font-mono font-semibold">{formatNumber(g.totalQty, 0)}</p>
            </div>
            <div className="text-right hidden md:block">
              <p className="text-xs text-muted-foreground">Value</p>
              <p className="text-sm font-mono">{g.combinedValue > 0 ? formatAmount(g.combinedValue) : "—"}</p>
            </div>
          </div>

          {/* Mobile: show total qty only */}
          <div className="sm:hidden text-right shrink-0">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-mono font-semibold">{formatNumber(g.totalQty, 0)}</p>
          </div>

          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
      ))}

      {/* Totals footer */}
      <div className="bg-muted/40 rounded-xl px-4 py-3 flex items-center gap-4">
        <div className="flex-1">
          <span className="text-sm font-semibold">
            Total ({groups.length} group{groups.length !== 1 ? "s" : ""})
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-6 shrink-0">
          <div className="text-right w-16">
            <p className="text-xs text-muted-foreground">OTW</p>
            <p className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400" data-testid="total-otw-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.otwQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right w-20">
            <p className="text-xs text-muted-foreground">In-Hand</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-inhand-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.inHandQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right w-20">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-combined-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.totalQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right hidden md:block w-28">
            <p className="text-xs text-muted-foreground">Value</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-combined-value">
              {formatAmount(groups.reduce((s, g) => s + g.combinedValue, 0))}
            </p>
          </div>
        </div>
        <div className="w-4 shrink-0" />
      </div>
    </div>
  );
}

export function ItemsTable({
  rows,
  formatAmount,
  emptyMessage,
}: {
  rows: CombinedRow[];
  formatAmount: (v: number) => string;
  emptyMessage: string;
}) {
  const totals = useMemo(
    () => ({
      otwQty: rows.reduce((s, r) => s + r.otwQty, 0),
      inHandQty: rows.reduce((s, r) => s + r.inHandQty, 0),
      totalQty: rows.reduce((s, r) => s + r.totalQty, 0),
      combinedValue: rows.reduce((s, r) => s + r.combinedValue, 0),
    }),
    [rows]
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
          <Layers className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No stock items found</h2>
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block phone-land:hidden">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Item Name</TableHead>
              <TableHead className="text-right">OTW Qty</TableHead>
              <TableHead className="text-right">In-Hand Qty</TableHead>
              <TableHead className="text-right">Total Qty</TableHead>
              <TableHead className="text-right">Avg Rate</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.stockItemId ?? row.stockItemName}
                data-testid={`row-combined-${row.stockItemId ?? row.stockItemName}`}
              >
                <TableCell className="font-medium">
                  {row.stockItemName}
                  {row.stockGroupName && (
                    <span className="ml-2">
                      <Badge variant="outline" className="text-xs font-normal">
                        {row.stockGroupName}
                      </Badge>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.otwQty > 0 ? (
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">
                      {formatNumber(row.otwQty, 0)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.inHandQty > 0 ? (
                    formatNumber(row.inHandQty, 0)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">{formatNumber(row.totalQty, 0)}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {row.avgRate > 0 ? formatAmount(row.avgRate) : <span>—</span>}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.combinedValue > 0 ? (
                    formatAmount(row.combinedValue)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="bg-muted/40">
            <TableRow className="font-semibold">
              <TableCell>
                Total ({rows.length} item{rows.length !== 1 ? "s" : ""})
              </TableCell>
              <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400">
                {formatNumber(totals.otwQty, 0)}
              </TableCell>
              <TableCell className="text-right font-mono">{formatNumber(totals.inHandQty, 0)}</TableCell>
              <TableCell className="text-right font-mono">{formatNumber(totals.totalQty, 0)}</TableCell>
              <TableCell className="text-right font-mono"></TableCell>
              <TableCell className="text-right font-mono">{formatAmount(totals.combinedValue)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden phone-land:block space-y-2">
        {rows.map((row) => (
          <div
            key={row.stockItemId ?? row.stockItemName}
            className="bg-card border rounded-xl p-4"
            data-testid={`row-combined-${row.stockItemId ?? row.stockItemName}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">{row.stockItemName}</p>
                {row.stockGroupName && <p className="text-xs text-muted-foreground mt-0.5">{row.stockGroupName}</p>}
              </div>
              <p className="text-sm font-mono font-semibold shrink-0">
                {row.combinedValue > 0 ? formatAmount(row.combinedValue) : "—"}
              </p>
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              {row.otwQty > 0 && (
                <div>
                  <span className="text-muted-foreground">OTW </span>
                  <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">
                    {formatNumber(row.otwQty, 0)}
                  </span>
                </div>
              )}
              {row.inHandQty > 0 && (
                <div>
                  <span className="text-muted-foreground">In-Hand </span>
                  <span className="font-mono">{formatNumber(row.inHandQty, 0)}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Total </span>
                <span className="font-mono font-semibold">{formatNumber(row.totalQty, 0)}</span>
              </div>
            </div>
          </div>
        ))}
        {/* Mobile total */}
        <div className="bg-muted/40 rounded-xl px-4 py-3 flex justify-between items-center">
          <span className="text-sm font-semibold">Total ({rows.length} items)</span>
          <div className="text-right">
            <p className="text-sm font-mono font-semibold">{formatAmount(totals.combinedValue)}</p>
            <p className="text-xs text-muted-foreground font-mono">{formatNumber(totals.totalQty, 0)} units</p>
          </div>
        </div>
      </div>
    </>
  );
}
