// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, X } from "lucide-react";
import { calculateLineTotal, useSupplierProformasStatePart1 } from "./useSupplierProformasStatePart1";
import { useSupplierProformasStatePart2 } from "./useSupplierProformasStatePart2";

export function useSupplierProformasState() {
  const {
    isError,
    refetch,
    addLineMutation,
    addingLine,
    commitRename,
    createDestinationId,
    createMutation,
    createNotes,
    createRef,
    deleteLineMutation,
    deleteMutation,
    destinationLabel,
    destinations,
    editLineData,
    editingLineId,
    fileInputRef,
    filterDestinationId,
    handleBack,
    importTarget,
    isLoading,
    newLine,
    ownerCompanyId,
    pendingDelete,
    proformas,
    recordChanges,
    renameInputRef,
    renameValue,
    renamingId,
    selectedProforma,
    selectedProformaId,
    setAddingLine,
    setCreateDestinationId,
    setCreateNotes,
    setCreateRef,
    setEditLineData,
    setEditingLineId,
    setFilterDestinationId,
    setImportTarget,
    setNewLine,
    setPendingDelete,
    setRenameValue,
    setRenamingId,
    setSelectedProformaId,
    setShowCreateDialog,
    showCreateDialog,
    starMutation,
    startRename,
    supplierId,
    toast,
    updateLineMutation,
  } = useSupplierProformasStatePart1();
  const { downloadTemplate, exportProformaExcel, handleFileImport, startEdit } = useSupplierProformasStatePart2({
    importTarget,
    selectedProformaId,
    setEditLineData,
    setEditingLineId,
    supplierId,
    toast,
  });
  return {
    isError,
    refetch,
    addLineMutation,
    addingLine,
    commitRename,
    createDestinationId,
    createMutation,
    createNotes,
    createRef,
    deleteLineMutation,
    deleteMutation,
    destinationLabel,
    destinations,
    downloadTemplate,
    editLineData,
    editingLineId,
    exportProformaExcel,
    fileInputRef,
    filterDestinationId,
    handleBack,
    handleFileImport,
    isLoading,
    newLine,
    ownerCompanyId,
    pendingDelete,
    proformas,
    recordChanges,
    renameInputRef,
    renameValue,
    renamingId,
    selectedProforma,
    selectedProformaId,
    setAddingLine,
    setCreateDestinationId,
    setCreateNotes,
    setCreateRef,
    setEditLineData,
    setEditingLineId,
    setFilterDestinationId,
    setImportTarget,
    setNewLine,
    setPendingDelete,
    setRenameValue,
    setRenamingId,
    setSelectedProformaId,
    setShowCreateDialog,
    showCreateDialog,
    starMutation,
    startEdit,
    startRename,
    supplierId,
    updateLineMutation,
  };
}

export function SupplierProformasTableRowSection({
  addLineMutation,
  newLine,
  setAddingLine,
  setNewLine,
}: Pick<ReturnType<typeof useSupplierProformasState>, "addLineMutation" | "newLine" | "setAddingLine" | "setNewLine">) {
  return (
    <TableRow>
      <TableCell>
        <Input
          value={newLine.barcode}
          onChange={(e) => setNewLine({ ...newLine, barcode: e.target.value })}
          placeholder="Barcode"
          className="h-8 text-xs"
          data-testid="input-new-barcode"
        />
      </TableCell>
      <TableCell>
        <Input
          value={newLine.itemName}
          onChange={(e) => setNewLine({ ...newLine, itemName: e.target.value })}
          placeholder="Item Name"
          className="h-8 text-xs"
          data-testid="input-new-itemname"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          value={newLine.qty}
          onChange={(e) => setNewLine({ ...newLine, qty: e.target.value })}
          className="h-8 text-xs w-16 text-right"
          data-testid="input-new-qty"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.01"
          value={newLine.pricePerBale}
          onChange={(e) => setNewLine({ ...newLine, pricePerBale: e.target.value })}
          className="h-8 text-xs w-20 text-right"
          data-testid="input-new-price"
        />
      </TableCell>
      <TableCell className="text-right font-mono">
        {calculateLineTotal(newLine.qty, newLine.pricePerBale).toFixed(2)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => addLineMutation.mutate(newLine)}
            data-testid="button-save-new-line"
          >
            <Save className="h-3 w-3" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setAddingLine(false)} data-testid="button-cancel-new-line">
            <X className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
