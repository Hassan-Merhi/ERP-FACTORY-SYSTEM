/**
 * FinalizeProformaDialog — extracted from FactoryLocationInventory.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryLocationInventory } from "../../FactoryLocationInventoryModel";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, FileText, X, Plus, Check } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";

export function FinalizeProformaDialog({
  bulkCreateMutation,
  createCustomerMutation,
  customerSearch,
  editingProformaId,
  filteredCustomers,
  finalizeOpen,
  formatAmount,
  grandTotal,
  handleCloseFinalizeDialog,
  handleExportExcel,
  handleExportPdf,
  handleSaveProforma,
  newCustomerName,
  proformaName,
  proformaDestination,
  setProformaDestination,
  removeFromFinalize,
  replaceLinesMutation,
  savedProformaId,
  selectedCustomerId,
  selectedItems,
  setCustomerSearch,
  setNewCustomerName,
  setProformaName,
  setSelectedCustomerId,
  setShowCreateCustomer,
  showCreateCustomer,
  totalSelectedBales,
  updateFinalizePrice,
  updateFinalizeQty,
}: {
  bulkCreateMutation: FactoryLocationInventoryModel["bulkCreateMutation"];
  createCustomerMutation: FactoryLocationInventoryModel["createCustomerMutation"];
  customerSearch: FactoryLocationInventoryModel["customerSearch"];
  editingProformaId: FactoryLocationInventoryModel["editingProformaId"];
  filteredCustomers: FactoryLocationInventoryModel["filteredCustomers"];
  finalizeOpen: FactoryLocationInventoryModel["finalizeOpen"];
  formatAmount: FactoryLocationInventoryModel["formatAmount"];
  grandTotal: FactoryLocationInventoryModel["grandTotal"];
  handleCloseFinalizeDialog: FactoryLocationInventoryModel["handleCloseFinalizeDialog"];
  handleExportExcel: FactoryLocationInventoryModel["handleExportExcel"];
  handleExportPdf: FactoryLocationInventoryModel["handleExportPdf"];
  handleSaveProforma: FactoryLocationInventoryModel["handleSaveProforma"];
  newCustomerName: FactoryLocationInventoryModel["newCustomerName"];
  proformaName: FactoryLocationInventoryModel["proformaName"];
  proformaDestination: FactoryLocationInventoryModel["proformaDestination"];
  setProformaDestination: FactoryLocationInventoryModel["setProformaDestination"];
  removeFromFinalize: FactoryLocationInventoryModel["removeFromFinalize"];
  replaceLinesMutation: FactoryLocationInventoryModel["replaceLinesMutation"];
  savedProformaId: FactoryLocationInventoryModel["savedProformaId"];
  selectedCustomerId: FactoryLocationInventoryModel["selectedCustomerId"];
  selectedItems: FactoryLocationInventoryModel["selectedItems"];
  setCustomerSearch: FactoryLocationInventoryModel["setCustomerSearch"];
  setNewCustomerName: FactoryLocationInventoryModel["setNewCustomerName"];
  setProformaName: FactoryLocationInventoryModel["setProformaName"];
  setSelectedCustomerId: FactoryLocationInventoryModel["setSelectedCustomerId"];
  setShowCreateCustomer: FactoryLocationInventoryModel["setShowCreateCustomer"];
  showCreateCustomer: FactoryLocationInventoryModel["showCreateCustomer"];
  totalSelectedBales: FactoryLocationInventoryModel["totalSelectedBales"];
  updateFinalizePrice: FactoryLocationInventoryModel["updateFinalizePrice"];
  updateFinalizeQty: FactoryLocationInventoryModel["updateFinalizeQty"];
}) {
  return (
    <Dialog
      open={finalizeOpen}
      onOpenChange={(open) => {
        if (!open) handleCloseFinalizeDialog();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-finalize-title">
            {savedProformaId ? "Proforma Saved" : "Finalize Proforma"}
          </DialogTitle>
        </DialogHeader>

        {!savedProformaId ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Proforma Name</label>
              <Input
                placeholder="e.g. March 2026 Order"
                value={proformaName}
                onChange={(e) => setProformaName(e.target.value)}
                data-testid="input-proforma-name"
              />
            </div>

            {!editingProformaId ? (
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Destination <span className="text-destructive">*</span>
                </label>
                <Input
                  value={proformaDestination}
                  onChange={(e) => setProformaDestination(e.target.value)}
                  placeholder="e.g. L'SHI, MALI, KINSHASA"
                  list="location-proforma-destinations"
                />
                <datalist id="location-proforma-destinations">
                  <option value="L'SHI" />
                  <option value="MALI" />
                  <option value="KINSHASA" />
                </datalist>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Destination: {proformaDestination || "Not linked"}. To assign or change it, use Edit Proforma in
                Invoicing.
              </p>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">Customer</label>
              {showCreateCustomer ? (
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Customer name..."
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    className="flex-1"
                    data-testid="input-new-customer-name"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      if (newCustomerName.trim()) createCustomerMutation.mutate({ legalName: newCustomerName.trim() });
                    }}
                    disabled={!newCustomerName.trim() || createCustomerMutation.isPending}
                    data-testid="button-save-new-customer"
                  >
                    <Check className="h-4 w-4 mr-1" /> Save
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowCreateCustomer(false);
                      setNewCustomerName("");
                    }}
                    data-testid="button-cancel-new-customer"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search customers..."
                        value={customerSearch}
                        onChange={(e) => setCustomerSearch(e.target.value)}
                        className="pl-9"
                        data-testid="input-search-customers"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowCreateCustomer(true)}
                      data-testid="button-create-customer"
                    >
                      <Plus className="h-4 w-4 mr-1" /> New
                    </Button>
                  </div>
                  <div className="max-h-32 overflow-y-auto border rounded-md">
                    {filteredCustomers.length === 0 ? (
                      <div className="text-center text-muted-foreground text-sm py-3">No customers found</div>
                    ) : (
                      filteredCustomers.map((c) => (
                        <div
                          key={c.id}
                          className={`px-3 py-2 cursor-pointer text-sm hover-elevate ${selectedCustomerId === String(c.id) ? "bg-primary/10 font-medium" : ""}`}
                          onClick={() => setSelectedCustomerId(String(c.id))}
                          data-testid={`row-customer-${c.id}`}
                        >
                          {c.legalName}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">
                Items ({selectedItems.length} selected, {totalSelectedBales} bales)
              </label>
              <div className="rounded-md border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Article</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right w-[100px]">Qty</TableHead>
                      <TableHead className="text-right w-[120px]">Price/Bale</TableHead>
                      <TableHead className="text-right w-[120px]">Total</TableHead>
                      <TableHead className="w-[40px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedItems.map((item) => {
                      const lineTotal = item.selectedQty * parseFloat(item.pricePerBale || "0");
                      return (
                        <TableRow key={item.productId} data-testid={`row-finalize-item-${item.productId}`}>
                          <TableCell className="font-mono text-xs">{item.articleCode}</TableCell>
                          <TableCell className="text-sm">{item.productName}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              value={item.selectedQty}
                              onChange={(e) => updateFinalizeQty(item.productId, e.target.value)}
                              className="w-[80px] text-right ml-auto"
                              min={1}
                              data-testid={`input-finalize-qty-${item.productId}`}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              value={item.pricePerBale}
                              onChange={(e) => updateFinalizePrice(item.productId, e.target.value)}
                              className="w-[100px] text-right ml-auto"
                              step="0.01"
                              data-testid={`input-finalize-price-${item.productId}`}
                            />
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatAmount(lineTotal)}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeFromFinalize(item.productId)}
                              data-testid={`button-remove-finalize-${item.productId}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/50 font-bold">
                      <TableCell colSpan={2}>Grand Total</TableCell>
                      <TableCell className="text-right font-mono">{totalSelectedBales}</TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(grandTotal)}</TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" onClick={handleCloseFinalizeDialog} data-testid="button-cancel-finalize">
                Cancel
              </Button>
              <Button
                onClick={handleSaveProforma}
                disabled={
                  !selectedCustomerId ||
                  !proformaName.trim() ||
                  (!editingProformaId && !proformaDestination.trim()) ||
                  selectedItems.length === 0 ||
                  bulkCreateMutation.isPending ||
                  replaceLinesMutation.isPending
                }
                data-testid="button-save-proforma"
              >
                <FileText className="h-4 w-4 mr-1" />
                {bulkCreateMutation.isPending || replaceLinesMutation.isPending
                  ? "Saving..."
                  : editingProformaId
                    ? "Update Proforma"
                    : "Save Proforma"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 mb-3">
                <Check className="h-6 w-6 text-green-600 dark:text-green-300" />
              </div>
              <p className="text-sm text-muted-foreground">
                Proforma "{proformaName}" saved with {selectedItems.length} items, {totalSelectedBales} bales.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3">
              <ExportButton onClick={handleExportExcel} data-testid="button-export-excel" />
              <ExportButton kind="pdf" onClick={handleExportPdf} data-testid="button-export-pdf" />
            </div>
            <div className="flex justify-center pt-2">
              <Button onClick={handleCloseFinalizeDialog} data-testid="button-done-proforma">
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
