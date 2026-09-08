/**
 * Voucher details dialog.
 *
 * Keeps its original import path and named export; the per-voucher-type bodies
 * now live under ./voucherdetailsdialog (purchase, sales/POS, ledger/stock and
 * revision history). This file owns only the dialog frame, the summary header,
 * the profit filter chips and the footer actions.
 */
import { Edit } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getVoucherTypeBadge } from "@/lib/voucherTypeBadge";

import type { VoucherDetailsDialogProps } from "./voucherdetailsdialog/types";
import type { ViewVoucherEntry } from "./types";
import { createEntryNameResolver } from "./voucherdetailsdialog/utils";
import { PurchaseVoucherEntries } from "./voucherdetailsdialog/PurchaseVoucherEntries";
import { SalesVoucherEntries } from "./voucherdetailsdialog/SalesVoucherEntries";
import { LedgerVoucherEntries } from "./voucherdetailsdialog/LedgerVoucherEntries";
import { VoucherRevisionHistory } from "./voucherdetailsdialog/VoucherRevisionHistory";

const PROFIT_FILTERS = ["all", "gain", "loss", "even"] as const;
const GC_OWNER_WITHDRAWAL_CLEARING_NAME = "gc owner withdrawal clearing";
const GC_SALES_CASH_NAME = "gc sales cash";

function normalizedAccountName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function projectGcOwnerWithdrawalForDisplay(entries: ViewVoucherEntry[], entryBalances: Record<number, string>) {
  const isOwnerWithdrawal = entries.some(
    (entry) => normalizedAccountName(entry?.accountName) === GC_OWNER_WITHDRAWAL_CLEARING_NAME
  );
  if (!isOwnerWithdrawal) return { entries, entryBalances };

  const projectedEntries = entries.flatMap((entry) => {
    const accountName = normalizedAccountName(entry?.accountName);
    if (accountName === GC_OWNER_WITHDRAWAL_CLEARING_NAME) return [];

    if (
      accountName === GC_SALES_CASH_NAME &&
      parseFloat(entry?.debitAmount || "0") > 0 &&
      parseFloat(entry?.creditAmount || "0") === 0
    ) {
      return [
        {
          ...entry,
          debitAmount: "0",
          creditAmount: entry.debitAmount,
        },
      ];
    }

    return [entry];
  });

  const projectedBalances = { ...entryBalances };
  for (const entry of projectedEntries) {
    if (normalizedAccountName(entry?.accountName) !== GC_SALES_CASH_NAME) continue;
    const raw = Number(projectedBalances[entry.id]);
    if (Number.isFinite(raw)) projectedBalances[entry.id] = String(Math.abs(raw));
  }

  return { entries: projectedEntries, entryBalances: projectedBalances };
}

export function VoucherDetailsDialog({
  open,
  onOpenChange,
  selectedVoucher,
  viewEntriesLoading,
  viewVoucherEntries,
  isStockTransferVoucher,
  voucherRevisions,
  revisionsLoading,
  revisionsError,
  revisionsErrorMessage,
  retryVoucherRevisions,
  formatAmount,
  formatDisplayDate,
  formatDisplayTime,
  cashAccountBalance,
  entryBalances,
  purchaseOrderData,
  poSupplierBalance,
  selectedDialogRow,
  setSelectedDialogRow,
  viewProfitFilter,
  setViewProfitFilter,
  user,
  handleEdit,
  canEdit,
  navigate,
  employees = [],
  ledgerAccounts = [],
  bankAccounts = [],
}: VoucherDetailsDialogProps) {
  const isStockTransferType =
    selectedVoucher?.voucherType === "Stock Transfer" ||
    selectedVoucher?.voucherType === "StockTransfer" ||
    selectedVoucher?.voucherType === "Transfer";

  const { data: voucherDetail } = useQuery({
    queryKey: ["/api/vouchers", selectedVoucher?.id, "detail-transfer"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/vouchers/${selectedVoucher!.id}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedVoucher?.id && isStockTransferType && open,
    staleTime: 30_000,
  });

  const transferDetail = voucherDetail?.transferData ?? null;

  if (!selectedVoucher) return null;

  const isPOSUser = !user || user?.role === "POS";
  const resolveEntryName = createEntryNameResolver(employees, ledgerAccounts, bankAccounts);
  const isInvoiceLike =
    selectedVoucher.voucherType === "Purchase" ||
    selectedVoucher.voucherType === "Sales" ||
    selectedVoucher.voucherType === "POS";
  const isSalesLike = selectedVoucher.voucherType === "Sales" || selectedVoucher.voucherType === "POS";
  const gcOwnerWithdrawalPresentation =
    selectedVoucher.voucherType === "Journal"
      ? projectGcOwnerWithdrawalForDisplay(viewVoucherEntries, entryBalances)
      : { entries: viewVoucherEntries, entryBalances };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[95vw] md:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Voucher Details</DialogTitle>
          <DialogDescription>
            {selectedVoucher.voucherType === "Purchase"
              ? "View voucher information"
              : `${selectedVoucher.voucherNumber} — ${formatDisplayDate(selectedVoucher.voucherDate)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {isInvoiceLike ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="text-sm font-medium">{formatDisplayDate(selectedVoucher.voucherDate)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Type</p>
                  <Badge {...getVoucherTypeBadge(selectedVoucher.voucherType)}>{selectedVoucher.voucherType}</Badge>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Description</p>
                  <p className="text-sm leading-relaxed">{selectedVoucher.description || "—"}</p>
                </div>
                {isSalesLike && selectedVoucher.locationName && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Location</p>
                    <p className="text-sm font-medium">{selectedVoucher.locationName}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-1">
                <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Description</span>
                <p className="text-sm leading-relaxed">{selectedVoucher.description || "No description provided."}</p>
              </div>
              <div className="space-y-1 md:text-right">
                <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Created At</span>
                <p className="text-sm font-mono">
                  {formatDisplayDate(selectedVoucher.createdAt)} {formatDisplayTime(selectedVoucher.createdAt)}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                Entries
                {viewEntriesLoading && <Skeleton className="h-4 w-4 rounded-full" />}
              </h3>
              {isSalesLike && !isPOSUser && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Filter:</span>
                  <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-lg">
                    {PROFIT_FILTERS.map((filter) => (
                      <Button
                        key={filter}
                        variant={viewProfitFilter === filter ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7 text-xs px-2.5 capitalize"
                        onClick={() => setViewProfitFilter(filter)}
                      >
                        {filter}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {viewEntriesLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                {selectedVoucher.voucherType === "Purchase" ? (
                  <PurchaseVoucherEntries
                    viewVoucherEntries={viewVoucherEntries}
                    purchaseOrderData={purchaseOrderData}
                    poSupplierBalance={poSupplierBalance}
                    isPOSUser={isPOSUser}
                    formatAmount={formatAmount}
                    onOpenChange={onOpenChange}
                    navigate={navigate}
                  />
                ) : isSalesLike ? (
                  <SalesVoucherEntries
                    viewVoucherEntries={viewVoucherEntries}
                    viewProfitFilter={viewProfitFilter}
                    isPOSUser={isPOSUser}
                    cashAccountBalance={cashAccountBalance}
                    entryBalances={entryBalances}
                    selectedDialogRow={selectedDialogRow}
                    setSelectedDialogRow={setSelectedDialogRow}
                    formatAmount={formatAmount}
                  />
                ) : (
                  <LedgerVoucherEntries
                    selectedVoucher={selectedVoucher}
                    viewVoucherEntries={gcOwnerWithdrawalPresentation.entries}
                    isPOSUser={isPOSUser}
                    isStockTransferType={isStockTransferType}
                    transferDetail={transferDetail}
                    cashAccountBalance={cashAccountBalance}
                    entryBalances={gcOwnerWithdrawalPresentation.entryBalances}
                    formatAmount={formatAmount}
                    resolveEntryName={resolveEntryName}
                    user={user}
                  />
                )}
              </div>
            )}

            {isStockTransferVoucher && (
              <VoucherRevisionHistory
                voucherRevisions={voucherRevisions}
                revisionsLoading={revisionsLoading}
                revisionsError={revisionsError}
                revisionsErrorMessage={revisionsErrorMessage}
                retryVoucherRevisions={retryVoucherRevisions}
              />
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-view-dialog">
            Close
          </Button>
          {canEdit(selectedVoucher) && (
            <Button
              onClick={() => {
                onOpenChange(false);
                if (selectedVoucher.voucherType === "Purchase" && purchaseOrderData?.id) {
                  navigate(`/purchase-orders/${purchaseOrderData.id}/edit`);
                } else {
                  handleEdit(selectedVoucher);
                }
              }}
              data-testid="button-edit-from-view-dialog"
            >
              <Edit className="w-4 h-4 mr-2" />
              Edit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
