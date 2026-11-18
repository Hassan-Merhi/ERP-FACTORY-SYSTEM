/**
 * Condensed Factory Daybook table in the shared Daybook frame: the ERP Daybook's
 * results bar, table shell, condensed Date/Type | Count | Total table, states
 * and pagination. Factory keeps its own grouping — one date separator row, one
 * collapsible row per (date, txType, currency) group and the expanded entry
 * rows underneath — and its own per-entry actions.
 *
 * The "Total" figures disappear entirely when ERP cost permissions hide
 * daybook amounts.
 */
import { useEffect } from "react";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import { DaybookResults, DaybookTableState } from "@/components/daybook/DaybookFrame";
import { PaginationBar } from "@/components/PaginationBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErpListTable } from "@/erp-core";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { formatNumber } from "@/lib/formatNumber";
import { currencySymbol, formatTxType, getFactoryTxTypeBadge, mergeBaleEntries } from "./daybookUtils";
import type { DaybookEntry, DisplayEntry } from "./types";
import { FactoryDaybookEntryRow } from "./FactoryDaybookEntryRow";
import type { CondensedRow, FactoryDaybookModel } from "./useFactoryDaybookModel";

/** Groups shown per page; one group is one transaction type on one day. */
const GROUPS_PER_PAGE = 100;

function BaleSummaryRow({
  row,
  expandedEntries,
  model,
}: {
  row: CondensedRow;
  expandedEntries: DisplayEntry[];
  model: FactoryDaybookModel;
}) {
  const mergedEntry =
    expandedEntries.length > 0
      ? mergeBaleEntries(expandedEntries.map((e) => (e as DisplayEntry)._source ?? (e as DaybookEntry)))
      : undefined;
  return (
    <TableRow className="bg-muted/20">
      <TableCell className="sticky left-0 z-10 bg-inherit pl-16 text-sm">
        {row.count} bale{row.count !== 1 ? "s" : ""}
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {model.showAmounts && (
            <span className="whitespace-nowrap font-mono text-sm font-medium tabular-nums">
              {currencySymbol(row.currencyCode)}
              {formatNumber(row.totalAmountCurrency)}
            </span>
          )}
          {mergedEntry && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
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
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CondensedGroupRows({ row, model }: { row: CondensedRow; model: FactoryDaybookModel }) {
  const isExpanded = model.expandedRowKey === row.key;
  const expandedEntries = isExpanded ? model.getEntriesForCondensedRow(row.key) : [];
  const { variant, className } = getFactoryTxTypeBadge(row.txType);
  const toggle = () => model.setExpandedRowKey(isExpanded ? null : row.key);
  return (
    <>
      <TableRow
        data-testid={`row-condensed-${row.date}-${row.txType}`}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${formatTxType(row.txType)} on ${row.date}`}
        className="cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <TableCell className="sticky left-0 z-10 bg-inherit pl-10">
          <div className="flex min-w-0 items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <Badge variant={variant} className={className}>
              {formatTxType(row.txType)}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="text-right font-mono text-sm text-muted-foreground tabular-nums">{row.count}</TableCell>
        <TableCell className="text-right font-mono font-medium tabular-nums">
          {model.showAmounts && (
            <>
              {currencySymbol(row.currencyCode)}
              {formatNumber(row.totalAmountCurrency)}
              {row.currencyCode !== "USD" && <div className="text-xs text-muted-foreground">{row.currencyCode}</div>}
            </>
          )}
        </TableCell>
      </TableRow>
      {isExpanded && row.txType === "BALE_STOCK_ENTRY" && (
        <BaleSummaryRow row={row} expandedEntries={expandedEntries} model={model} />
      )}
      {isExpanded &&
        row.txType !== "BALE_STOCK_ENTRY" &&
        expandedEntries.map((entry) => (
          <FactoryDaybookEntryRow key={(entry as DisplayEntry)._vKey ?? entry.id} entry={entry} model={model} />
        ))}
    </>
  );
}

export function FactoryDaybookTable({ model }: { model: FactoryDaybookModel }) {
  const { isLoading, isError, error, refetch, filteredEntries, condensedRows, hasActiveFilters, showAmounts } = model;
  const { periodFilter, txTypeFilter, statusFilter, searchQuery, formatDisplayDate } = model;
  const pagination = useClientTablePagination(condensedRows.length, GROUPS_PER_PAGE);
  const { resetPage } = pagination;
  useEffect(() => {
    resetPage();
  }, [resetPage, periodFilter.fromDate, periodFilter.toDate, txTypeFilter, statusFilter, searchQuery]);

  const dateGroups = new Map<string, CondensedRow[]>();
  for (const row of pagination.paginate(condensedRows)) {
    if (!dateGroups.has(row.date)) dateGroups.set(row.date, []);
    dateGroups.get(row.date)!.push(row);
  }
  const showState = isLoading || isError || filteredEntries.length === 0;

  return (
    <DaybookResults
      description="All factory transactions in one view"
      count={
        filteredEntries.length > 0 ? `${condensedRows.length} group${condensedRows.length === 1 ? "" : "s"}` : undefined
      }
      footer={
        !showState && (
          <PaginationBar
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={condensedRows.length}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setPage}
            noun="groups"
          />
        )
      }
    >
      {showState ? (
        <DaybookTableState
          isLoading={isLoading}
          errorMessage={
            isError ? (error instanceof Error ? error.message : "The factory daybook could not be loaded.") : null
          }
          onRetry={() => void refetch()}
          isEmpty={filteredEntries.length === 0}
          emptyTitle={hasActiveFilters ? "No transactions found matching your filters." : "No transactions found"}
          emptyDescription={
            hasActiveFilters ? undefined : "Factory transactions will appear here as you perform operations"
          }
          emptyAction={
            hasActiveFilters ? (
              <Button variant="outline" onClick={model.clearFilters} data-testid="button-clear-filters-empty">
                Clear Filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ErpListTable
          pageKey="factory-daybook-condensed"
          scrollLabel="Condensed factory daybook"
          // Phones restack rows as cards; the Factory phone regression forbids sideways table scroll.
          mobileLayout="cards"
          wrapperClassName="max-h-[calc(100dvh-220px)]"
        >
          <TableHeader className="sticky top-0 z-20 bg-muted [&_th]:bg-muted [&_th]:text-foreground/90">
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-muted pl-4">Date / Type</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">
                {showAmounts ? "Total" : <span className="sr-only">Actions</span>}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground dark:[&_td]:border-border/70 dark:[&_tr]:border-border/70">
            {Array.from(dateGroups.entries()).map(([date, rows]) => {
              const dayTotal = rows.reduce((sum, row) => sum + row.totalAmountCurrency, 0);
              const dayCurrency = rows[0]?.currencyCode ?? "USD";
              return (
                <div key={date} style={{ display: "contents" }}>
                  <TableRow className="bg-muted/30 font-semibold hover:bg-muted/50" data-testid={`row-date-${date}`}>
                    <TableCell className="sticky left-0 z-10 bg-inherit pl-4 text-sm font-semibold">
                      {formatDisplayDate(date + "T00:00:00")}
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right font-mono font-semibold tabular-nums">
                      {showAmounts && (
                        <>
                          {currencySymbol(dayCurrency)}
                          {formatNumber(dayTotal)}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                  {rows.map((row) => (
                    <CondensedGroupRows key={row.key} row={row} model={model} />
                  ))}
                </div>
              );
            })}
          </TableBody>
        </ErpListTable>
      )}
    </DaybookResults>
  );
}
