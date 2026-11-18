import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2, RotateCcw, AlertTriangle, Package, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { typeIcons, typeLabels, useDeletedItemsState } from "./useDeletedItemsState";
import { DeletedItemsCardSection } from "./DeletedItemsCardSection";
import { formatUsd } from "@/lib/moneyDisplay";

export default function DeletedItems() {
  const {
    bulkDeleteMutation,
    confirmAction,
    confirmDialog,
    data,
    detailItem,
    entriesLoading,
    error,
    filterType,
    formatDisplayDate,
    handlePermanentDelete,
    handleRestore,
    isLoading,
    itemKey,
    items,
    permanentDeleteMutation,
    restoreMutation,
    selectedItems,
    setConfirmDialog,
    setDetailItem,
    setFilterType,
    setSelectedItems,
    setShowBulkDeleteDialog,
    showBulkDeleteDialog,
    toggleAll,
    toggleItem,
    voucherEntries,
  } = useDeletedItemsState();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Failed to load deleted items</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:p-4 md:space-y-6 md:p-6">
      <PageHeader
        title={<span data-testid="title-deleted-items">Deleted Items</span>}
        subtitle="View and manage deleted records. You can restore items or permanently delete them."
        icon={<Trash2 className="h-5 w-5" />}
      />
      <DeletedItemsCardSection
        data={data}
        filterType={filterType}
        formatDisplayDate={formatDisplayDate}
        handlePermanentDelete={handlePermanentDelete}
        handleRestore={handleRestore}
        itemKey={itemKey}
        items={items}
        permanentDeleteMutation={permanentDeleteMutation}
        restoreMutation={restoreMutation}
        selectedItems={selectedItems}
        setDetailItem={setDetailItem}
        setFilterType={setFilterType}
        setSelectedItems={setSelectedItems}
        setShowBulkDeleteDialog={setShowBulkDeleteDialog}
        toggleAll={toggleAll}
        toggleItem={toggleItem}
      />

      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Permanently Delete {selectedItems.size} Item{selectedItems.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove all {selectedItems.size} selected item{selectedItems.size !== 1 ? "s" : ""}.
              This action cannot be undone and all associated data will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-bulk-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const toDelete = items
                  .filter((item) => selectedItems.has(itemKey(item)))
                  .map(({ type, id }) => ({ type, id }));
                bulkDeleteMutation.mutate(toDelete);
              }}
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {confirmDialog.action === "delete" && <AlertTriangle className="h-5 w-5 text-destructive" />}
              {confirmDialog.action === "restore" ? "Restore Item?" : "Permanently Delete Item?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.action === "restore" ? (
                <>
                  This will restore{" "}
                  <strong>
                    {confirmDialog.item?.name} ({confirmDialog.item?.code || "no code"})
                  </strong>{" "}
                  and make it active again.
                </>
              ) : (
                <>
                  This will permanently delete{" "}
                  <strong>
                    {confirmDialog.item?.name} ({confirmDialog.item?.code || "no code"})
                  </strong>
                  . This action cannot be undone and all associated data will be lost.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-dialog">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAction}
              className={
                confirmDialog.action === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
              data-testid="button-confirm-dialog"
            >
              {restoreMutation.isPending || permanentDeleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {confirmDialog.action === "restore" ? "Restore" : "Delete Forever"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={!!detailItem} onOpenChange={(open) => !open && setDetailItem(null)}>
        <SheetContent className="w-[95vw] sm:w-[400px] md:w-[540px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {detailItem &&
                (() => {
                  const IconComponent = typeIcons[detailItem.type] || Package;
                  return <IconComponent className="h-5 w-5" />;
                })()}
              {typeLabels[detailItem?.type || ""] || detailItem?.type} Details
            </SheetTitle>
            <SheetDescription>Viewing deleted item information</SheetDescription>
          </SheetHeader>
          {detailItem && (
            <div className="mt-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Type</p>
                  <p className="font-medium">{typeLabels[detailItem.type] || detailItem.type}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">ID</p>
                  <p className="font-medium font-mono">{detailItem.id}</p>
                </div>
              </div>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground">Code</p>
                <p className="font-medium font-mono">{detailItem.code || "-"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium">{detailItem.name}</p>
              </div>
              {detailItem.accountType && (
                <div>
                  <p className="text-sm text-muted-foreground">Account Type</p>
                  <p className="font-medium">{detailItem.accountType}</p>
                </div>
              )}
              {detailItem.voucherType && (
                <div>
                  <p className="text-sm text-muted-foreground">Voucher Type</p>
                  <p className="font-medium">{detailItem.voucherType}</p>
                </div>
              )}
              {detailItem.amount !== undefined && (
                <div>
                  <p className="text-sm text-muted-foreground">Amount</p>
                  <p className="font-medium">{formatUsd(detailItem.amount ?? 0, 0, 3)}</p>
                </div>
              )}
              {detailItem.date && (
                <div>
                  <p className="text-sm text-muted-foreground">Date</p>
                  <p className="font-medium">{formatDisplayDate(detailItem.date)}</p>
                </div>
              )}
              {detailItem.locationName && (
                <div>
                  <p className="text-sm text-muted-foreground">Location</p>
                  <p className="font-medium">{detailItem.locationName}</p>
                </div>
              )}
              {detailItem.type === "voucher" && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-2">Journal Entries</p>
                    {entriesLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-10 w-full" />
                        ))}
                      </div>
                    ) : voucherEntries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No entries found</p>
                    ) : (
                      <div className="rounded-md border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 z-30 bg-muted">
                            <tr className="border-b bg-muted/40">
                              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Account</th>
                              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Debit</th>
                              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {voucherEntries.map((entry, i: number) => (
                              <tr key={entry.id ?? i} className="border-b last:border-0">
                                <td className="px-3 py-2">
                                  <p className="font-medium text-xs">{entry.accountName || "—"}</p>
                                  {entry.description && (
                                    <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {parseFloat(entry.debitAmount || "0") > 0
                                    ? formatUsd(parseFloat(entry.debitAmount || "0"), 2)
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {parseFloat(entry.creditAmount || "0") > 0
                                    ? formatUsd(parseFloat(entry.creditAmount || "0"), 2)
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="sticky bottom-0 z-20 bg-background">
                            <tr className="bg-muted/50 font-semibold">
                              <td className="px-3 py-2 text-xs">Total</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {formatUsd(
                                  voucherEntries.reduce((s: number, e) => s + parseFloat(e.debitAmount || "0"), 0),
                                  2
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {formatUsd(
                                  voucherEntries.reduce((s: number, e) => s + parseFloat(e.creditAmount || "0"), 0),
                                  2
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground">Deleted At</p>
                <p className="font-medium">
                  {detailItem.deletedAt
                    ? `${formatDisplayDate(detailItem.deletedAt)} ${format(new Date(detailItem.deletedAt), "h:mm a")}`
                    : "-"}
                </p>
              </div>
              <div className="flex gap-2 pt-4">
                {detailItem.type !== "orphanedPosSale" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      handleRestore(detailItem);
                      setDetailItem(null);
                    }}
                    disabled={restoreMutation.isPending}
                    data-testid="button-restore-detail"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Restore
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => {
                    handlePermanentDelete(detailItem);
                    setDetailItem(null);
                  }}
                  disabled={permanentDeleteMutation.isPending}
                  data-testid="button-delete-detail"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Forever
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
