/**
 * The All Daybook voucher list: header controls (hide amounts, hidden rows,
 * top pagination), the desktop table, the mobile card list and the pagination
 * footer.
 *
 * Split out of TransactionJournal.tsx unchanged — same test ids, same column
 * set (the Amount column disappears when amounts are hidden), same empty-state
 * copy and the same three per-row actions.
 */
import { AlertCircle, ChevronLeft, ChevronRight, Eye, EyeOff, Pencil, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { companyColor, fmtDate, formatAmount } from "../utils";
import { VoucherTypeBadge } from "./VoucherTypeBadge";
import type { JournalVoucher } from "../types";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

function emptyStateText(model: TransactionJournalModel): string {
  return model.allVouchers.length > 0 && model.hiddenRowIds.size > 0
    ? "All rows on this page are hidden."
    : "No transactions found for the selected filters.";
}

function RowActions({
  voucher,
  model,
  suffix,
}: {
  voucher: JournalVoucher;
  model: TransactionJournalModel;
  suffix: string;
}) {
  const isHidden = model.hiddenRowIds.has(voucher.id);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.openDetail(voucher.id)}
        data-testid={`button-preview-voucher${suffix}-${voucher.id}`}
        title="Preview"
      >
        <Eye className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.toggleHideRow(voucher.id)}
        data-testid={`button-hide-voucher${suffix}-${voucher.id}`}
        title={isHidden ? "Unhide row" : "Hide row"}
      >
        <EyeOff className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.openInCompany(voucher.companyId, `/daybook?voucherId=${voucher.id}`)}
        data-testid={`button-edit-voucher${suffix}-${voucher.id}`}
        title="Open in Daybook"
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </>
  );
}

function DesktopTable({ model }: { model: TransactionJournalModel }) {
  const { hideAmounts, isLoading, visibleVouchers } = model;
  return (
    <div className="hidden md:block">
      <div className="table-responsive">
        {/* Phone landscape is wider than md; the rows restack as cards there too. */}
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[110px]">Date</TableHead>
              <TableHead className="w-[150px]">Company</TableHead>
              <TableHead className="w-[160px]">Type</TableHead>
              <TableHead>Description</TableHead>
              {!hideAmounts && <TableHead className="text-right w-[130px]">Amount</TableHead>}
              <TableHead className="w-[120px] text-center">Actions</TableHead>
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
              visibleVouchers.map((v) => {
                const isHidden = model.hiddenRowIds.has(v.id);
                return (
                  <TableRow
                    key={v.id}
                    data-testid={`row-voucher-${v.id}`}
                    className={isHidden && model.showHidden ? "opacity-50" : ""}
                  >
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {fmtDate(v.voucherDate)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-block text-xs font-medium px-2 py-0.5 rounded truncate max-w-[140px] ${companyColor(v.companyId)}`}
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
                    <TableCell className="text-sm max-w-xs text-muted-foreground">
                      <div className="flex items-center gap-1 truncate">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                        <span className="truncate">{v.description || v.narration || "—"}</span>
                      </div>
                    </TableCell>
                    {!hideAmounts && (
                      <TableCell className="text-right text-sm font-mono">
                        <span className="text-xs text-muted-foreground mr-1">{v.currency}</span>
                        {formatAmount(v.totalAmount)}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <RowActions voucher={v} model={model} suffix="" />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function MobileCards({ model }: { model: TransactionJournalModel }) {
  const { hideAmounts, isLoading, visibleVouchers } = model;
  return (
    <div className="md:hidden">
      {isLoading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : visibleVouchers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm px-4">{emptyStateText(model)}</div>
      ) : (
        <div className="divide-y">
          {visibleVouchers.map((v) => {
            const isHidden = model.hiddenRowIds.has(v.id);
            return (
              <div
                key={v.id}
                className={`px-3 py-3 ${isHidden && model.showHidden ? "opacity-50" : ""}`}
                data-testid={`card-voucher-${v.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
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
                      <span
                        className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${companyColor(v.companyId)}`}
                      >
                        {v.companyName}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{v.description || v.narration || "—"}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{fmtDate(v.voucherDate)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {!hideAmounts && (
                      <div className="font-mono text-sm font-medium">
                        <span className="text-xs text-muted-foreground mr-0.5">{v.currency}</span>
                        {formatAmount(v.totalAmount)}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-0.5 mt-1">
                      <RowActions voucher={v} model={model} suffix="-mobile" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ListHeader({ model }: { model: TransactionJournalModel }) {
  const { hideAmounts, hiddenRowIds, showHidden, page, totalPages } = model;
  return (
    <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-2 flex-wrap">
        <CardTitle className="text-base">
          Vouchers
          {!model.isLoading && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {model.totalVouchers.toLocaleString()} total
            </span>
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8 text-xs"
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
          className="gap-1.5 h-8 text-xs"
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
            className="h-8 text-xs text-muted-foreground"
            onClick={model.clearHiddenRows}
            data-testid="button-clear-hidden-rows"
            title="Clear all hidden rows"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => model.setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            data-testid="button-prev-page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => model.setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            data-testid="button-next-page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </CardHeader>
  );
}

function PaginationFooter({ model }: { model: TransactionJournalModel }) {
  const { page, totalPages, totalVouchers, limit } = model;
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t">
      <span className="text-sm text-muted-foreground">
        Showing {(page - 1) * limit + 1}–{Math.min(page * limit, totalVouchers)} of {totalVouchers.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="default"
          onClick={() => model.setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          data-testid="button-prev-page-footer"
        >
          <ChevronLeft className="h-4 w-4 mr-1" /> Previous
        </Button>
        <Button
          variant="outline"
          size="default"
          onClick={() => model.setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          data-testid="button-next-page-footer"
        >
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

export function JournalVoucherList({ model }: { model: TransactionJournalModel }) {
  if (model.error) {
    const message = model.error instanceof Error ? model.error.message : "Unable to load transactions.";
    return (
      <Card>
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
    <Card>
      <ListHeader model={model} />
      <CardContent className="p-0">
        <DesktopTable model={model} />
        <MobileCards model={model} />
        <PaginationFooter model={model} />
      </CardContent>
    </Card>
  );
}
