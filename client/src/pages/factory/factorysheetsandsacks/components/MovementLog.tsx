/**
 * MovementLog — extracted sub-component.
 *
 * Extracted from FactorySheetsAndSacks.tsx during the Phase 4 god-file split.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { History, ArrowDownCircle, ArrowUpCircle, TrendingDown, TrendingUp, BarChart3, Calendar } from "lucide-react";

import type { SheetsAndSacksItem } from "../types";
import { DATE_PRESETS, fmtDateTime } from "../utils";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { useMovementLogState } from "./useMovementLogState";
import { MovementLogContent, usd } from "./MovementLogContent";

export function MovementLog({ items }: { items: SheetsAndSacksItem[] }) {
  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    direction,
    setDirection,
    filterItemId,
    setFilterItemId,
    from,
    to,
    isLoading,
    isError,
    logEntriesData,
    refetch,
    logEntries,
    byDay,
    totals,
    dayTotal,
  } = useMovementLogState();

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
          <RowsExportMenu
            title="Sheets and Sacks Movements"
            sheetName="Movements"
            rows={byDay.flatMap(([, entries]) => entries)}
            columns={[
              { header: "Date", value: (e) => fmtDateTime(e.createdAt) },
              { header: "Item", value: (e) => e.itemName },
              { header: "Type", value: (e) => e.itemType },
              { header: "Action", value: (e) => (e.action === "IN" ? "IN" : e.action === "OUT" ? "OUT" : "ADJ") },
              { header: "Packs", value: (e) => e.packs, type: "number" },
              { header: "Pcs", value: (e) => e.pieces, type: "number" },
              { header: "Unit $", value: (e) => e.unitPrice, type: "number" },
              { header: "Value", value: (e) => e.totalValue, type: "number" },
              { header: "Notes", value: (e) => e.notes },
            ]}
            period={{ from: from || null, to: to || null }}
            resource="factory.production"
            className="h-7 text-xs"
          />
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
            <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">{usd(totals.inVal)}</p>
          </div>
          <div className="rounded-lg border bg-red-50 dark:bg-red-950/20 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400 mb-1">
              <ArrowDownCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Total Out</span>
            </div>
            <p className="font-mono font-bold text-sm text-red-700 dark:text-red-300">
              {totals.outPcs.toLocaleString()} pcs
            </p>
            <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">{usd(totals.outVal)}</p>
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
        <LoadingState className="py-16" />
      ) : isError && !logEntriesData ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-16" />
      ) : logEntries.length === 0 ? (
        <EmptyState
          icon={History}
          title="No movement records for this period."
          description='Use "Add Stock" (↑) or "Deduct" (↓) buttons to log movements.'
          className="py-16"
        />
      ) : (
        <MovementLogContent byDay={byDay} dayTotal={dayTotal} />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
