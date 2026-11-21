// Extracted from ./JournalVoucherList.tsx
import { Fragment } from "react";
import { Eye, EyeOff, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { companyColor, fmtDate, formatAmount } from "../utils";
import { VoucherTypeBadge } from "./VoucherTypeBadge";
import type { JournalVoucher } from "../types";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

// The API sorts before pagination. These headers make each contiguous company
// and voucher-type run easy to scan without changing row actions or totals.
export function voucherGroupLabel(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "stocktransfer") return "Stock Transfer";
  if (normalized === "sale" || normalized === "sales") return "Sales";
  return type.trim() || "Other";
}

export function typeGroupKey(type: string): string {
  return voucherGroupLabel(type).toLowerCase().replace(/\s+/g, "-");
}

export function groupBreaks(vouchers: JournalVoucher[], index: number) {
  const current = vouchers[index];
  const previous = vouchers[index - 1];
  const newCompany = !previous || previous.companyId !== current.companyId;
  return {
    newCompany,
    newType: newCompany || typeGroupKey(previous.voucherType) !== typeGroupKey(current.voucherType),
  };
}

export function emptyStateText(model: TransactionJournalModel): string {
  return model.allVouchers.length > 0 && model.hiddenRowIds.size > 0
    ? "All rows on this page are hidden."
    : "No transactions found for the selected filters.";
}

export function RowActions({
  voucher,
  model,
  suffix,
}: {
  voucher: JournalVoucher;
  model: TransactionJournalModel;
  suffix: string;
}) {
  const isHidden = model.hiddenRowIds.has(voucher.id);
  if (voucher.entryType === "offload") {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-slate-600 hover:bg-violet-100 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/15 dark:hover:text-violet-200"
          onClick={() => model.openInCompany(voucher.companyId, `/offloads/${voucher.offloadId}`)}
          data-testid={`button-view-offload${suffix}-${voucher.offloadId}`}
          title="View offload"
        >
          <Eye className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-slate-600 hover:bg-violet-100 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/15 dark:hover:text-violet-200"
          onClick={() => model.openInCompany(voucher.companyId, `/containers/${voucher.containerId}`)}
          data-testid={`button-open-offload-container${suffix}-${voucher.offloadId}`}
          title="Open container"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 rounded-lg text-slate-600 hover:bg-violet-100 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/15 dark:hover:text-violet-200"
        onClick={() => model.openDetail(voucher.id)}
        data-testid={`button-preview-voucher${suffix}-${voucher.id}`}
        title="Preview"
      >
        <Eye className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 rounded-lg text-slate-600 hover:bg-violet-100 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/15 dark:hover:text-violet-200"
        onClick={() => model.toggleHideRow(voucher.id)}
        data-testid={`button-hide-voucher${suffix}-${voucher.id}`}
        title={isHidden ? "Unhide row" : "Hide row"}
      >
        <EyeOff className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 rounded-lg text-slate-600 hover:bg-violet-100 hover:text-violet-700 dark:text-slate-300 dark:hover:bg-violet-400/15 dark:hover:text-violet-200"
        onClick={() => model.openInCompany(voucher.companyId, `/daybook?voucherId=${voucher.id}`)}
        data-testid={`button-edit-voucher${suffix}-${voucher.id}`}
        title="Open in Daybook"
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </>
  );
}

export function MobileCards({ model }: { model: TransactionJournalModel }) {
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
          {visibleVouchers.map((v, index) => {
            const isHidden = model.hiddenRowIds.has(v.id);
            const { newCompany, newType } = groupBreaks(visibleVouchers, index);
            return (
              <Fragment key={`${v.entryType || "voucher"}-${v.id}`}>
                {newCompany && (
                  <div
                    className="border-t border-violet-200 bg-violet-100/80 px-3 py-2 dark:border-violet-400/20 dark:bg-violet-500/15"
                    data-testid={`card-company-group-${v.companyId}`}
                  >
                    <span
                      className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-sm ${companyColor(v.companyId)}`}
                    >
                      {v.companyName}
                    </span>
                  </div>
                )}
                {newType && (
                  <div
                    className="bg-slate-50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:bg-white/[0.035] dark:text-slate-400"
                    data-testid={`card-type-group-${v.companyId}-${typeGroupKey(v.voucherType)}`}
                  >
                    {voucherGroupLabel(v.voucherType)}
                  </div>
                )}
                <div
                  className={`px-3 py-3 transition-colors hover:bg-violet-50/60 dark:hover:bg-violet-400/[0.08] ${isHidden && model.showHidden ? "opacity-50" : ""}`}
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
                          className={`inline-block text-xs font-medium px-2 py-0.5 rounded-sm ${companyColor(v.companyId)}`}
                        >
                          {v.companyName}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {v.description || v.narration || "—"}
                      </div>
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
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
