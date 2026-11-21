/**
 * The All Daybook voucher list: header controls (hide amounts, hidden rows),
 * the desktop table, the mobile card list and the shared PaginationBar.
 *
 * Keeps the original test IDs, actions and conditional Amount column while
 * displaying company and voucher-type headers over server-grouped rows.
 */
import { Fragment } from "react";
import { AlertCircle, ChevronRight, Eye, EyeOff, ListFilter, RefreshCw, X } from "lucide-react";
import { PaginationBar } from "@/components/PaginationBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { companyColor, fmtDate, formatAmount } from "../utils";
import { VoucherTypeBadge } from "./VoucherTypeBadge";
import type { TransactionJournalModel } from "../useTransactionJournalModel";
import {
  voucherGroupLabel,
  typeGroupKey,
  groupBreaks,
  emptyStateText,
  RowActions,
  MobileCards,
} from "./JournalVoucherListParts";

function DesktopTable({ model }: { model: TransactionJournalModel }) {
  const { hideAmounts, isLoading, visibleVouchers } = model;
  return (
    <div className="hidden md:block">
      <div className="table-responsive px-3 pb-3 sm:px-4">
        {/* Phone landscape is wider than md; the rows restack as cards there too. */}
        <Table mobileLayout="cards" className="overflow-hidden rounded-xl text-sm">
          <TableHeader className="bg-slate-100/90 dark:bg-white/[0.055]">
            <TableRow className="border-b border-slate-200 dark:border-white/10">
              <TableHead className="w-[110px] text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                Date
              </TableHead>
              <TableHead className="w-[150px] text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                Company
              </TableHead>
              <TableHead className="w-[160px] text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                Type
              </TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                Description
              </TableHead>
              {!hideAmounts && (
                <TableHead className="w-[130px] text-right text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                  Amount
                </TableHead>
              )}
              <TableHead className="w-[120px] text-center text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: hideAmounts ? 5 : 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : visibleVouchers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={hideAmounts ? 5 : 6} className="text-center py-12 text-muted-foreground">
                  {emptyStateText(model)}
                </TableCell>
              </TableRow>
            ) : (
              visibleVouchers.map((v, index) => {
                const isHidden = model.hiddenRowIds.has(v.id);
                const { newCompany, newType } = groupBreaks(visibleVouchers, index);
                return (
                  <Fragment key={`${v.entryType || "voucher"}-${v.id}`}>
                    {newCompany && (
                      <TableRow
                        className="border-t-2 border-violet-200 bg-gradient-to-r from-violet-100 via-purple-50 to-violet-50 hover:from-violet-100 hover:to-violet-50 dark:border-violet-400/20 dark:from-violet-500/25 dark:via-purple-500/15 dark:to-violet-500/10 dark:hover:from-violet-500/25"
                        data-testid={`row-company-group-${v.companyId}`}
                      >
                        <TableCell colSpan={hideAmounts ? 5 : 6} className="py-2.5">
                          <span
                            className={`inline-block rounded-md px-2.5 py-1 text-xs font-bold ${companyColor(v.companyId)}`}
                          >
                            {v.companyName}
                          </span>
                        </TableCell>
                      </TableRow>
                    )}
                    {newType && (
                      <TableRow
                        className="bg-slate-50/90 hover:bg-slate-50/90 dark:bg-white/[0.035] dark:hover:bg-white/[0.035]"
                        data-testid={`row-type-group-${v.companyId}-${typeGroupKey(v.voucherType)}`}
                      >
                        <TableCell
                          colSpan={hideAmounts ? 5 : 6}
                          className="py-1.5 pl-6 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                        >
                          {voucherGroupLabel(v.voucherType)}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow
                      key={v.id}
                      data-testid={`row-voucher-${v.id}`}
                      className={`border-b border-slate-100 transition-colors hover:bg-violet-50/60 dark:border-white/[0.06] dark:hover:bg-violet-400/[0.08] ${isHidden && model.showHidden ? "opacity-50" : ""}`}
                    >
                      <TableCell className="whitespace-nowrap py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                        {fmtDate(v.voucherDate)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-block max-w-[140px] truncate rounded-md px-2 py-1 text-xs font-semibold ${companyColor(v.companyId)}`}
                        >
                          {v.companyName}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 flex-wrap">
                          <VoucherTypeBadge type={v.voucherType} />
                          {v.optional && (
                            <Badge variant="outline" className="text-xs">
                              Optional
                            </Badge>
                          )}
                          {v.deletedAt && (
                            <Badge variant="destructive" className="text-xs">
                              Deleted
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs py-2.5 text-sm text-slate-700 dark:text-slate-300">
                        <div className="flex items-center gap-1 truncate">
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                          <span className="truncate">{v.description || v.narration || "—"}</span>
                        </div>
                      </TableCell>
                      {!hideAmounts && (
                        <TableCell className="py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
                          <span className="text-xs text-muted-foreground mr-1">{v.currency}</span>
                          {formatAmount(v.totalAmount)}
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center justify-center gap-0.5">
                          <RowActions voucher={v} model={model} suffix="" />
                        </div>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ListHeader({ model }: { model: TransactionJournalModel }) {
  const { hideAmounts, hiddenRowIds, showHidden } = model;
  return (
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
          <ListFilter className="h-4 w-4" />
        </span>
        <CardTitle className="text-base font-bold tracking-tight">
          Transactions
          {!model.isLoading && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {model.totalVouchers.toLocaleString()} total
            </span>
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-lg text-xs text-slate-600 hover:bg-violet-50 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/10"
          onClick={model.toggleHideAmounts}
          title={hideAmounts ? "Show amounts" : "Hide amounts"}
          data-testid="button-toggle-hide-amounts"
        >
          {hideAmounts ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {hideAmounts ? "Amounts hidden" : "Hide amounts"}
        </Button>
        <Button
          variant={showHidden ? "secondary" : "outline"}
          size="sm"
          className="h-8 gap-1.5 rounded-lg border-slate-200 bg-white/80 text-xs text-slate-600 dark:border-white/15 dark:bg-white/[0.04] dark:text-slate-300"
          onClick={() => model.setShowHidden((v) => !v)}
          disabled={hiddenRowIds.size === 0}
          title={
            hiddenRowIds.size === 0
              ? "No hidden rows"
              : showHidden
                ? "Hide hidden rows"
                : `Show ${hiddenRowIds.size} hidden row${hiddenRowIds.size !== 1 ? "s" : ""}`
          }
          data-testid="button-toggle-show-hidden"
        >
          {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {showHidden ? "Showing hidden" : "Show hidden"}
          {hiddenRowIds.size > 0 && <Badge className="ml-1 text-xs">{hiddenRowIds.size}</Badge>}
        </Button>
        {hiddenRowIds.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg text-xs text-muted-foreground"
            onClick={model.clearHiddenRows}
            data-testid="button-clear-hidden-rows"
            title="Clear all hidden rows"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </CardHeader>
  );
}

function PaginationFooter({ model }: { model: TransactionJournalModel }) {
  return (
    <PaginationBar
      page={model.page}
      totalPages={model.totalPages}
      total={model.totalVouchers}
      pageSize={model.limit}
      onPageChange={(next) => model.setPage(next)}
      noun="transactions"
      ariaLabel="Transactions pages"
      data-testid="journal-pagination"
    />
  );
}

export function JournalVoucherList({ model }: { model: TransactionJournalModel }) {
  if (model.error) {
    const message = model.error instanceof Error ? model.error.message : "Unable to load transactions.";
    return (
      <Card className="overflow-hidden rounded-2xl border-slate-200/80 bg-white/90 shadow-sm dark:border-violet-400/20 dark:bg-slate-900/70">
        <CardContent
          className="flex flex-col items-center justify-center gap-3 py-12 text-center"
          data-testid="journal-error"
        >
          <AlertCircle className="h-8 w-8 text-destructive" />
          <div>
            <p className="font-medium">Could not load All Daybook</p>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" onClick={() => model.refetch()} data-testid="button-journal-retry">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200/80 bg-white/90 shadow-sm dark:border-violet-400/20 dark:bg-slate-900/70">
      <ListHeader model={model} />
      <CardContent className="p-0">
        <DesktopTable model={model} />
        <MobileCards model={model} />
        <PaginationFooter model={model} />
      </CardContent>
    </Card>
  );
}
