// Extracted from ./MovementLog.tsx
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { fmtDate, fmtDateTime } from "../utils";
import { formatUsd } from "@/lib/moneyDisplay";
import { useMovementLogState } from "./useMovementLogState";

export const usd = (value: string | number) => formatUsd(parseFloat(String(value) || "0"), 2);

export function MovementLogContent({
  byDay,
  dayTotal,
}: Pick<ReturnType<typeof useMovementLogState>, "byDay" | "dayTotal">) {
  return (
    <div className="space-y-4">
      {byDay.map(([day, entries]) => {
        const dt = dayTotal(entries);
        return (
          <div key={day} className="rounded-xl border overflow-hidden">
            {/* Day header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b">
              <span className="text-sm font-semibold">{fmtDate(day + "T12:00:00")}</span>
              <div className="flex items-center gap-3 text-xs font-mono">
                {dt.inPcs > 0 && (
                  <span className="text-green-600 dark:text-green-400 flex items-center gap-1">
                    <ArrowUpCircle className="h-3 w-3" />+{dt.inPcs.toLocaleString()}
                  </span>
                )}
                {dt.outPcs > 0 && (
                  <span className="text-red-600 dark:text-red-400 flex items-center gap-1">
                    <ArrowDownCircle className="h-3 w-3" />-{dt.outPcs.toLocaleString()}
                  </span>
                )}
                <span
                  className={`font-semibold ${dt.net >= 0 ? "text-blue-600 dark:text-blue-400" : "text-amber-600 dark:text-amber-400"}`}
                >
                  Net: {dt.net >= 0 ? "+" : ""}
                  {dt.net.toLocaleString()} pcs
                </span>
              </div>
            </div>
            {/* Entries table */}
            <div className="overflow-x-auto">
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow className="bg-muted/20">
                    <TableHead className="w-36 text-xs">Time</TableHead>
                    <TableHead className="text-xs">Item</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs w-20">Action</TableHead>
                    <TableHead className="text-right text-xs">Packs</TableHead>
                    <TableHead className="text-right text-xs">Pcs</TableHead>
                    <TableHead className="text-right text-xs">Unit $</TableHead>
                    <TableHead className="text-right text-xs">Value</TableHead>
                    <TableHead className="text-xs">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow
                      key={e.id}
                      className={
                        e.action === "IN"
                          ? "bg-green-50/40 dark:bg-green-950/10"
                          : e.action === "OUT"
                            ? "bg-red-50/40 dark:bg-red-950/10"
                            : "bg-blue-50/30 dark:bg-blue-950/10"
                      }
                    >
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {fmtDateTime(e.createdAt).split(",")[1]?.trim() ?? ""}
                      </TableCell>
                      <TableCell className="text-sm font-medium">{e.itemName}</TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={`text-[11px] ${
                            e.itemType === "Sheet"
                              ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                              : e.itemType === "Sack"
                                ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {e.itemType}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`text-[11px] font-bold ${
                            e.action === "IN"
                              ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 border-green-200"
                              : e.action === "OUT"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-200"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200"
                          }`}
                          variant="outline"
                        >
                          {e.action === "IN" ? "↑ IN" : e.action === "OUT" ? "↓ OUT" : "⟳ ADJ"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {e.packs != null ? e.packs.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">
                        {e.pieces.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {usd(e.unitPrice)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-medium">{usd(e.totalValue)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                        {e.notes || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {/* Day totals footer */}
                <tfoot>
                  {(() => {
                    const dt = dayTotal(entries);
                    return (
                      <tr className="border-t bg-muted/20 text-xs font-semibold">
                        <td colSpan={5} className="px-4 py-1.5 text-muted-foreground">
                          Day total
                        </td>
                        <td colSpan={4} className="px-4 py-1.5 text-right font-mono">
                          {dt.inPcs > 0 && (
                            <span className="text-green-600 dark:text-green-400 mr-3">
                              +{dt.inPcs.toLocaleString()}
                            </span>
                          )}
                          {dt.outPcs > 0 && (
                            <span className="text-red-600 dark:text-red-400 mr-3">−{dt.outPcs.toLocaleString()}</span>
                          )}
                          <span
                            className={
                              dt.net >= 0 ? "text-blue-600 dark:text-blue-400" : "text-amber-600 dark:text-amber-400"
                            }
                          >
                            Net {dt.net >= 0 ? "+" : ""}
                            {dt.net.toLocaleString()} pcs
                          </span>
                        </td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </Table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
