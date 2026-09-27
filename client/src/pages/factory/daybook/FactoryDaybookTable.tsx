/**
 * Condensed Factory Daybook table — matches the ERP Daybook layout:
 * Date/Type | Count | Total, with date separator rows, one collapsible row per
 * (date, txType, currency) group, and expanded entry sub-rows underneath.
 *
 * Split out of FactoryDaybook.tsx unchanged; the "Total" column disappears
 * entirely when ERP cost permissions hide daybook amounts.
 */
import { BookOpen, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { currencySymbol, formatTxType, getFactoryTxTypeBadge, mergeBaleEntries } from "./daybookUtils";
import type { DaybookEntry, DisplayEntry } from "./types";
import { FactoryDaybookEntryRow } from "./FactoryDaybookEntryRow";
import type { CondensedRow, FactoryDaybookModel } from "./useFactoryDaybookModel";

/**
 * Date/Type | Count | Total columns. The desktop widths (100px / 180px) leave no room for the
 * type on a 320px phone, so phones get a narrow count and a capped total column instead.
 */
export function daybookColumnsClass(showAmounts: boolean) {
  return showAmounts
    ? "grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,7.5rem)] sm:grid-cols-[minmax(0,1fr)_100px_180px]"
    : "grid-cols-[minmax(0,1fr)_2.5rem] sm:grid-cols-[minmax(0,1fr)_100px]";
}

function BaleSummaryRow({
  row,
  colsClass,
  expandedEntries,
  model,
}: {
  row: CondensedRow;
  colsClass: string;
  expandedEntries: DisplayEntry[];
  model: FactoryDaybookModel;
}) {
  const hasEntries = expandedEntries.length > 0;
  const mergedEntry = hasEntries
    ? mergeBaleEntries(expandedEntries.map((e) => (e as DisplayEntry)._source ?? (e as DaybookEntry)))
    : undefined;
  const viewButton = mergedEntry && (
    <Button
      size="icon"
      variant="ghost"
      title="View details"
      aria-label="View details"
      onClick={(e) => {
        e.stopPropagation();
        model.setViewEntry(mergedEntry);
      }}
      data-testid="button-view-bale-summary"
    >
      <Eye className="h-3 w-3" />
    </Button>
  );
  return (
    <div className={cn("flex w-full flex-wrap items-center border-t bg-muted/20 sm:grid", colsClass)}>
      <div className="min-w-0 flex-1 py-2 pl-8 pr-2 sm:pl-14">
        <span className="text-sm text-foreground">
          {row.count} bale{row.count !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="hidden sm:block" />
      {model.showAmounts ? (
        <div className="ml-auto flex items-center justify-end gap-1 py-1 pr-2 sm:ml-0 sm:py-2">
          <span className="text-sm font-mono font-medium">
            {currencySymbol(row.currencyCode)}
            {formatNumber(row.totalAmountCurrency)}
          </span>
          {viewButton}
        </div>
      ) : (
        <div className="ml-auto flex items-center justify-end gap-1 py-1 pr-2 sm:ml-0 sm:py-2">{viewButton}</div>
      )}
    </div>
  );
}

function CondensedGroupRow({
  row,
  colsClass,
  model,
}: {
  row: CondensedRow;
  colsClass: string;
  model: FactoryDaybookModel;
}) {
  const isExpanded = model.expandedRowKey === row.key;
  const expandedEntries = isExpanded ? model.getEntriesForCondensedRow(row.key) : [];
  const { variant: bv, className: bc } = getFactoryTxTypeBadge(row.txType);
  return (
    <div className="w-full border-b last:border-b-0">
      {/* Group type row */}
      <div
        data-testid={`row-condensed-${row.date}-${row.txType}`}
        onClick={() => model.setExpandedRowKey(isExpanded ? null : row.key)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            model.setExpandedRowKey(isExpanded ? null : row.key);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${formatTxType(row.txType)} on ${row.date}`}
        className={cn(
          "grid w-full cursor-pointer items-center gap-x-2 py-3 pl-3 pr-3 hover-elevate sm:gap-x-0 sm:pl-6 sm:pr-4",
          colsClass
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <Badge variant={bv} className={cn(bc, "min-w-0 whitespace-normal break-words sm:whitespace-nowrap")}>
            {formatTxType(row.txType)}
          </Badge>
        </div>
        <div className="text-center text-muted-foreground text-sm font-mono">{row.count}</div>
        {model.showAmounts && (
          <div className="min-w-0 break-words text-right font-mono text-sm font-medium">
            {currencySymbol(row.currencyCode)}
            {formatNumber(row.totalAmountCurrency)}
            {row.currencyCode !== "USD" && (
              <div className="text-xs text-muted-foreground font-mono">{row.currencyCode}</div>
            )}
          </div>
        )}
      </div>

      {/* Expanded entry sub-rows */}
      {isExpanded && row.txType === "BALE_STOCK_ENTRY" && (
        <BaleSummaryRow row={row} colsClass={colsClass} expandedEntries={expandedEntries} model={model} />
      )}
      {isExpanded &&
        row.txType !== "BALE_STOCK_ENTRY" &&
        expandedEntries.map((entry) => (
          <FactoryDaybookEntryRow
            key={(entry as DisplayEntry)._vKey ?? entry.id}
            entry={entry}
            colsClass={colsClass}
            model={model}
          />
        ))}
    </div>
  );
}

function CondensedRows({ model }: { model: FactoryDaybookModel }) {
  const { condensedRows, showAmounts, formatDisplayDate } = model;
  const dateMap = new Map<string, CondensedRow[]>();
  for (const row of condensedRows) {
    if (!dateMap.has(row.date)) dateMap.set(row.date, []);
    dateMap.get(row.date)!.push(row);
  }
  const colsClass = daybookColumnsClass(showAmounts);
  return (
    <>
      {Array.from(dateMap.entries()).map(([date, rows]) => {
        const dayTotal = rows.reduce((s, r) => s + r.totalAmountCurrency, 0);
        const dayCcy = rows[0]?.currencyCode ?? "USD";
        return (
          <div key={date} className="w-full">
            {/* Date separator row */}
            <div className={cn("grid w-full gap-x-2 border-b bg-muted/40 px-3 py-1.5 sm:gap-x-0 sm:px-4", colsClass)}>
              <span className="min-w-0 break-words text-sm font-semibold">{formatDisplayDate(date + "T00:00:00")}</span>
              <span />
              {showAmounts && (
                <span className="min-w-0 break-words text-right font-mono text-sm font-medium">
                  {currencySymbol(dayCcy)}
                  {formatNumber(dayTotal)}
                </span>
              )}
            </div>

            {/* Type rows under this date */}
            {rows.map((row) => (
              <CondensedGroupRow key={row.key} row={row} colsClass={colsClass} model={model} />
            ))}
          </div>
        );
      })}
    </>
  );
}

export function FactoryDaybookTable({ model }: { model: FactoryDaybookModel }) {
  const { isLoading, isError, error, refetch, filteredEntries, condensedRows, hasActiveFilters, showAmounts } = model;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Transactions
            {filteredEntries.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({`${condensedRows.length} group${condensedRows.length === 1 ? "" : "s"}`})
              </span>
            )}
          </CardTitle>
        </div>
        <CardDescription>All factory transactions in one view</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-6">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Could not load factory transactions"
            description={error instanceof Error ? error.message : "The factory daybook could not be loaded."}
            actionLabel="Try again"
            onAction={() => void refetch()}
            data-testid="factory-daybook-error"
          />
        ) : filteredEntries.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {hasActiveFilters ? (
              <div>
                <p className="mb-2">No transactions found matching your filters.</p>
                <Button variant="outline" onClick={model.clearFilters} data-testid="button-clear-filters-empty">
                  Clear Filters
                </Button>
              </div>
            ) : (
              <>
                <BookOpen className="mx-auto h-12 w-12 text-muted-foreground" />
                <h3 className="mt-4 text-lg font-semibold">No transactions found</h3>
                <p className="mt-2">Factory transactions will appear here as you perform operations</p>
              </>
            )}
          </div>
        ) : (
          /* ── CONDENSED VIEW — matches ERP Daybook: Date/Type | Count | Total ── */
          <div className="w-full">
            {/* Header */}
            <div
              className={cn(
                "sticky top-0 z-30 grid w-full gap-x-2 border-b bg-background px-3 py-2 sm:gap-x-0 sm:px-4",
                daybookColumnsClass(showAmounts)
              )}
            >
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Date / Type</span>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">
                Count
              </span>
              {showAmounts && (
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">
                  Total
                </span>
              )}
            </div>
            <CondensedRows model={model} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
