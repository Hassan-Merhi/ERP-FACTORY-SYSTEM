// Extracted from ./DeletedItems.tsx
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw, Package } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { typeIcons, typeLabels, useDeletedItemsState } from "./useDeletedItemsState";
import { formatUsd } from "@/lib/moneyDisplay";

export function DeletedItemsSheet({
  detailItem,
  entriesLoading,
  formatDisplayDate,
  handlePermanentDelete,
  handleRestore,
  permanentDeleteMutation,
  restoreMutation,
  setDetailItem,
  voucherEntries,
}: Pick<
  ReturnType<typeof useDeletedItemsState>,
  | "detailItem"
  | "entriesLoading"
  | "formatDisplayDate"
  | "handlePermanentDelete"
  | "handleRestore"
  | "permanentDeleteMutation"
  | "restoreMutation"
  | "setDetailItem"
  | "voucherEntries"
>) {
  return (
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
  );
}
