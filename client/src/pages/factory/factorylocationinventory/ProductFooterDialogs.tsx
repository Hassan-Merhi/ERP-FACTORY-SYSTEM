import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, Zap } from "lucide-react";

import { FinalizeProformaDialog } from "../factory-location-inventory/dialogs/FinalizeProformaDialog";
import { PrintBarcodesDialog } from "../factory-location-inventory/dialogs/PrintBarcodesDialog";
import { RemoveBalesDialog } from "../factory-location-inventory/dialogs/RemoveBalesDialog";
import { RenameLocationDialog } from "../factory-location-inventory/dialogs/RenameLocationDialog";
import { StockOverloadWarningDialog } from "../factory-location-inventory/dialogs/StockOverloadWarningDialog";
import type { useFactoryLocationInventory } from "../FactoryLocationInventoryModel";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

export function FactoryLocationInventoryProductFooterDialogs({
  inventory,
}: {
  inventory: FactoryLocationInventoryModel;
}) {
  const {
    bulkCreateMutation,
    colors,
    createCustomerMutation,
    customerSearch,
    deleteDialogOpen,
    deleteProduct,
    deleteQty,
    deleteReason,
    deleteSupervisorPass,
    deleteSupervisorUser,
    editingProformaId,
    filteredCustomers,
    finalizeOpen,
    fmt,
    formatAmount,
    grandTotal,
    handleCloseFinalizeDialog,
    handleDoPrint,
    handleExportExcel,
    handleExportPdf,
    handleFinalize,
    handleSaveProforma,
    newCustomerName,
    openBrowserReprintLabels,
    overloadWarning,
    proformaAutoSave,
    proformaMode,
    proformaName,
    removeBalesMutation,
    removeFromFinalize,
    renameDialogOpen,
    renameInput,
    renameLocationMutation,
    renamingLocation,
    replaceLinesMutation,
    reprintBales,
    reprintDesignPickerOpen,
    reprintDialogOpen,
    reprintLoading,
    reprintPendingLabels,
    reprintProduct,
    savedProformaId,
    selectedCustomerId,
    selectedItems,
    selectedLocation,
    selections,
    setCustomerSearch,
    setDeleteDialogOpen,
    setDeleteProduct,
    setDeleteQty,
    setDeleteReason,
    setDeleteSupervisorPass,
    setDeleteSupervisorUser,
    setNewCustomerName,
    setOverloadWarning,
    setProformaName,
    setRenameDialogOpen,
    setRenameInput,
    setReprintBales,
    setReprintDesignPickerOpen,
    setReprintDialogOpen,
    setReprintProduct,
    setSelectedCustomerId,
    setShowCreateCustomer,
    showCreateCustomer,
    totalSelectedBales,
    totalSelectedKg,
    updateFinalizePrice,
    updateFinalizeQty,
  } = inventory;

  return (
    <>
      {proformaMode && selections.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/80 px-4 py-3 shadow-lg">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="secondary" className="text-sm">
                {selections.size} items
              </Badge>
              <span className="text-sm font-mono font-medium">{totalSelectedBales} bales</span>
              <span className="text-sm font-mono text-muted-foreground">{fmt(totalSelectedKg)} KG</span>
              <span className="text-sm font-mono text-muted-foreground">{formatAmount(grandTotal)} total</span>
            </div>
            <div className="flex items-center gap-2">
              {editingProformaId && proformaAutoSave && (
                <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <Zap className="h-3.5 w-3.5 fill-green-500" />
                  {replaceLinesMutation.isPending ? "Saving…" : "Auto-saving"}
                </span>
              )}
              <Button
                onClick={editingProformaId ? handleSaveProforma : handleFinalize}
                disabled={(bulkCreateMutation.isPending || replaceLinesMutation.isPending) && !!editingProformaId}
                data-testid="button-finalize-proforma-bar"
              >
                <FileText className="h-4 w-4 mr-1" />
                {editingProformaId ? "Update Proforma" : "Finalize Proforma"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <FinalizeProformaDialog
        bulkCreateMutation={bulkCreateMutation}
        createCustomerMutation={createCustomerMutation}
        customerSearch={customerSearch}
        editingProformaId={editingProformaId}
        filteredCustomers={filteredCustomers}
        finalizeOpen={finalizeOpen}
        formatAmount={formatAmount}
        grandTotal={grandTotal}
        handleCloseFinalizeDialog={handleCloseFinalizeDialog}
        handleExportExcel={handleExportExcel}
        handleExportPdf={handleExportPdf}
        handleSaveProforma={handleSaveProforma}
        newCustomerName={newCustomerName}
        proformaName={proformaName}
        removeFromFinalize={removeFromFinalize}
        replaceLinesMutation={replaceLinesMutation}
        savedProformaId={savedProformaId}
        selectedCustomerId={selectedCustomerId}
        selectedItems={selectedItems}
        setCustomerSearch={setCustomerSearch}
        setNewCustomerName={setNewCustomerName}
        setProformaName={setProformaName}
        setSelectedCustomerId={setSelectedCustomerId}
        setShowCreateCustomer={setShowCreateCustomer}
        showCreateCustomer={showCreateCustomer}
        totalSelectedBales={totalSelectedBales}
        updateFinalizePrice={updateFinalizePrice}
        updateFinalizeQty={updateFinalizeQty}
      />

      <StockOverloadWarningDialog overloadWarning={overloadWarning} setOverloadWarning={setOverloadWarning} />

      <RemoveBalesDialog
        deleteDialogOpen={deleteDialogOpen}
        deleteProduct={deleteProduct}
        deleteQty={deleteQty}
        deleteReason={deleteReason}
        deleteSupervisorPass={deleteSupervisorPass}
        deleteSupervisorUser={deleteSupervisorUser}
        removeBalesMutation={removeBalesMutation}
        selectedLocation={selectedLocation}
        setDeleteDialogOpen={setDeleteDialogOpen}
        setDeleteProduct={setDeleteProduct}
        setDeleteQty={setDeleteQty}
        setDeleteReason={setDeleteReason}
        setDeleteSupervisorPass={setDeleteSupervisorPass}
        setDeleteSupervisorUser={setDeleteSupervisorUser}
      />

      <PrintBarcodesDialog
        handleDoPrint={handleDoPrint}
        reprintBales={reprintBales}
        reprintDialogOpen={reprintDialogOpen}
        reprintLoading={reprintLoading}
        reprintProduct={reprintProduct}
        selectedLocation={selectedLocation}
        setReprintBales={setReprintBales}
        setReprintDialogOpen={setReprintDialogOpen}
        setReprintProduct={setReprintProduct}
      />

      <Dialog open={reprintDesignPickerOpen} onOpenChange={setReprintDesignPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Choose A4 Label Design</DialogTitle>
            <DialogDescription>Pick a color design for the A4 label sheet.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            {colors.map((option) => (
              <Button
                key={option.value}
                variant="outline"
                onClick={() => {
                  setReprintDesignPickerOpen(false);
                  openBrowserReprintLabels(reprintPendingLabels, option.value);
                }}
                data-testid={`button-inv-design-${option.value}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full mr-2 shrink-0 border border-border/50"
                  style={{ background: option.color }}
                />
                {option.label}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setReprintDesignPickerOpen(false)}
              data-testid="button-inv-design-cancel"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenameLocationDialog
        renameDialogOpen={renameDialogOpen}
        renameInput={renameInput}
        renameLocationMutation={renameLocationMutation}
        renamingLocation={renamingLocation}
        setRenameDialogOpen={setRenameDialogOpen}
        setRenameInput={setRenameInput}
      />
    </>
  );
}
