import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { deletedItemsExportColumns } from "@/pages/deleted-items/deletedItemsExport";
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
import { Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { typeLabels, useDeletedItemsState } from "./useDeletedItemsState";
import { DeletedItemsCardSection } from "./DeletedItemsCardSection";
import { DeletedItemsSheet } from "./DeletedItemsSheet";

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
      >
        <RowsExportMenu
          title="Deleted Items"
          rows={items}
          columns={deletedItemsExportColumns(typeLabels, formatDisplayDate)}
          resource="erp.accounts"
        />
      </PageHeader>
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

      <DeletedItemsSheet
        detailItem={detailItem}
        entriesLoading={entriesLoading}
        formatDisplayDate={formatDisplayDate}
        handlePermanentDelete={handlePermanentDelete}
        handleRestore={handleRestore}
        permanentDeleteMutation={permanentDeleteMutation}
        restoreMutation={restoreMutation}
        setDetailItem={setDetailItem}
        voucherEntries={voucherEntries}
      />
    </div>
  );
}
