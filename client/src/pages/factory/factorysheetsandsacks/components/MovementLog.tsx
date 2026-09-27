/**
 * MovementLog — extracted sub-component.
 *
 * Extracted from FactorySheetsAndSacks.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2,
  History,
  ArrowDownCircle,
  ArrowUpCircle,
  TrendingDown,
  TrendingUp,
  BarChart3,
  Calendar,
} from "lucide-react";

import type { LogEntry, SheetsAndSacksItem } from "../types";
import { DATE_PRESETS, fmt, fmtDate, fmtDateTime, getPresetDates, localDayOf } from "../utils";

export function MovementLog({ items }: { items: SheetsAndSacksItem[] }) {
  const [preset, setPreset] = useState("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [direction, setDirection] = useState<"all" | "IN" | "OUT">("all");
  const [filterItemId, setFilterItemId] = useState<string>("all");

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return getPresetDates(preset);
  }, [preset, customFrom, customTo]);

  const { data: logEntries = [], isLoading } = useQuery<LogEntry[]>({
    queryKey: ["/api/factory/sheets-sacks/log", from, to, direction, filterItemId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (direction !== "all") params.set("action", direction);
      if (filterItemId !== "all") params.set("itemId", filterItemId);
      const res = await apiRequest("GET", `/api/factory/sheets-sacks/log?${params}`);
      return res.json();
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // Group by local calendar day
  const byDay = useMemo(() => {
    const groups: Record<string, LogEntry[]> = {};
    for (const e of logEntries) {
      const day = localDayOf(e.createdAt);
      if (!groups[day]) groups[day] = [];
      groups[day].push(e);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [logEntries]);

  // Period totals — only count IN and OUT; ADJUST is shown but excluded from IN/OUT sums
  const totals = useMemo(() => {
    let inPcs = 0,
      outPcs = 0,
      inVal = 0,
      outVal = 0;
    for (const e of logEntries) {
      const pieces = Number(e.pieces) || 0;
      if (e.action === "IN") {
        inPcs += pieces;
        inVal += parseFloat(e.totalValue || "0");
      }
      if (e.action === "OUT") {
        outPcs += pieces;
        outVal += parseFloat(e.totalValue || "0");
      }
    }
    return { inPcs, outPcs, inVal, outVal, net: inPcs - outPcs };
  }, [logEntries]);

  const dayTotal = (entries: LogEntry[]) => {
    let inPcs = 0,
      outPcs = 0;
    for (const e of entries) {
      const pieces = Number(e.pieces) || 0;
      if (e.action === "IN") inPcs += pieces;
      if (e.action === "OUT") outPcs += pieces;
    }
    return { inPcs, outPcs, net: inPcs - outPcs };
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Date presets */}
        <div className="flex items-center gap-1 flex-wrap">
          {DATE_PRESETS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key ? "default" : "outline"}
              className="text-xs h-7 px-2.5"
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant={preset === "custom" ? "default" : "outline"}
            className="text-xs h-7 px-2.5"
            onClick={() => setPreset("custom")}
          >
            <Calendar className="h-3 w-3 mr-1" />
            Custom
          </Button>
        </div>

        {/* Custom date range */}
        {preset === "custom" && (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-7 text-xs w-36"
            />
            <span className="text-muted-foreground text-xs">→</span>
            <Input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-7 text-xs w-36"
            />
          </div>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Direction filter */}
          <Select
            value={direction}
            onValueChange={(v) => setDirection(v as React.SetStateAction<"all" | "IN" | "OUT">)}
          >
            <SelectTrigger className="h-7 text-xs w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Moves</SelectItem>
              <SelectItem value="IN">Stock In ↑</SelectItem>
              <SelectItem value="OUT">Stock Out ↓</SelectItem>
            </SelectContent>
          </Select>

          {/* Item filter */}
          <Select value={filterItemId} onValueChange={setFilterItemId}>
            <SelectTrigger className="h-7 text-xs w-40">
              <SelectValue placeholder="All Items" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Items</SelectItem>
              {items.map((i) => (
                <SelectItem key={i.id} value={String(i.id)}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Period summary cards */}
      {logEntries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg border bg-green-50 dark:bg-green-950/20 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400 mb-1">
              <ArrowUpCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Total In</span>
            </div>
            <p className="font-mono font-bold text-sm text-green-700 dark:text-green-300">
              {totals.inPcs.toLocaleString()} pcs
            </p>
            <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">${fmt(totals.inVal)}</p>
          </div>
          <div className="rounded-lg border bg-red-50 dark:bg-red-950/20 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400 mb-1">
              <ArrowDownCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Total Out</span>
            </div>
            <p className="font-mono font-bold text-sm text-red-700 dark:text-red-300">
              {totals.outPcs.toLocaleString()} pcs
            </p>
            <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">${fmt(totals.outVal)}</p>
          </div>
          <div
            className={`rounded-lg border px-3 py-2.5 ${totals.net >= 0 ? "bg-blue-50 dark:bg-blue-950/20" : "bg-amber-50 dark:bg-amber-950/20"}`}
          >
            <div
              className={`flex items-center gap-1.5 text-xs mb-1 ${totals.net >= 0 ? "text-blue-700 dark:text-blue-400" : "text-amber-700 dark:text-amber-400"}`}
            >
              {totals.net >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              <span className="font-medium">Net Change</span>
            </div>
            <p
              className={`font-mono font-bold text-sm ${totals.net >= 0 ? "text-blue-700 dark:text-blue-300" : "text-amber-700 dark:text-amber-300"}`}
            >
              {totals.net >= 0 ? "+" : ""}
              {totals.net.toLocaleString()} pcs
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <BarChart3 className="h-3.5 w-3.5" />
              <span className="font-medium">Transactions</span>
            </div>
            <p className="font-bold text-sm">{logEntries.length}</p>
          </div>
        </div>
      )}

      {/* Day-by-day log */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : logEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <History className="h-10 w-10 mb-3 opacity-25" />
          <p className="text-sm font-medium">No movement records for this period.</p>
          <p className="text-xs mt-1 opacity-70">Use "Add Stock" (↑) or "Deduct" (↓) buttons to log movements.</p>
        </div>
      ) : (
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
                              className={`text-[10px] ${
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
                              className={`text-[10px] font-bold ${
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
                            ${fmt(e.unitPrice)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">
                            ${fmt(e.totalValue)}
                          </TableCell>
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
                                <span className="text-red-600 dark:text-red-400 mr-3">
                                  −{dt.outPcs.toLocaleString()}
                                </span>
                              )}
                              <span
                                className={
                                  dt.net >= 0
                                    ? "text-blue-600 dark:text-blue-400"
                                    : "text-amber-600 dark:text-amber-400"
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
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
