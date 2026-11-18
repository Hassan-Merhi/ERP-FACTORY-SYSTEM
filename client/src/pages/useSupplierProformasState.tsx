// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Save, X } from "lucide-react";
import * as XLSX from "@/lib/excelHelper";
import {
  calculateLineTotal,
  useSupplierProformasStatePart1,
  type ProformaLine,
} from "./useSupplierProformasStatePart1";

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

function useSupplierProformasStatePart2({
  importTarget,
  selectedProformaId,
  setEditLineData,
  setEditingLineId,
  supplierId,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useSupplierProformasStatePart1>>,
  "importTarget" | "selectedProformaId" | "setEditLineData" | "setEditingLineId" | "supplierId" | "toast"
>) {
  const importLinesMutation = useMutation({
    mutationFn: async ({ proformaId, lines }: { proformaId: number; lines: unknown[] }) => {
      const res = await apiRequest("POST", `/api/suppliers/${supplierId}/proformas/${proformaId}/import-lines`, {
        lines,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId] });
      toast({ title: "Import complete", description: `${data.imported} lines imported` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Import error", description: e.message, variant: "destructive" });
    },
  });

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !importTarget) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = await XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        /** Parse a human-entered decimal from Excel into a plain number, 0 on failure. */
        const parseExcelNum = (v: unknown): number => {
          const raw = String(v ?? "").trim();
          const stripped = raw.replace(/^[^0-9\-(]+/, "").replace(/[^0-9.]+$/, "");
          const noCommas = stripped.replace(/,(?=\d{3}(?:[,.]|$))/g, "");
          if (!/^-?\d+(\.\d+)?$/.test(noCommas)) return 0;
          const n = parseFloat(noCommas);
          return isFinite(n) ? n : 0;
        };
        const lines = rows
          .map((r) => ({
            barcode: String(r.Barcode || r.barcode || "").trim(),
            itemName: String(r["Item Name"] || r.itemName || r.Name || "").trim(),
            qty: Math.max(0, Math.trunc(parseExcelNum(r.Qty ?? r.qty ?? r.Quantity))),
            weightPerBale: String(parseExcelNum(r["Weight per Bale"] ?? r.weightPerBale ?? r.Weight)),
            pricePerBale: String(parseExcelNum(r["Price per Bale"] ?? r.pricePerBale ?? r.Price)),
          }))
          .filter((l) => l.barcode);
        if (lines.length === 0) {
          toast({
            title: "No data found",
            description: "Check that your Excel has columns: Barcode, Item Name, Qty, Weight per Bale, Price per Bale",
            variant: "destructive",
          });
          return;
        }
        importLinesMutation.mutate({ proformaId: importTarget, lines });
      } catch (err) {
        toast({ title: "Parse error", description: getErrorDetails(err).message, variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const downloadTemplate = async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Barcode", "Item Name", "Qty", "Weight per Bale", "Price per Bale"],
      ["SAMPLE001", "Sample Item", 10, 45, 25.5],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Proforma");
    await XLSX.writeFile(wb, "proforma_template.xlsx");
  };

  const exportProformaExcel = async () => {
    try {
      await downloadFromUrl(`/api/suppliers/${supplierId}/proformas/${selectedProformaId}/export-excel`, {
        fileName: exportFileName(`supplier proforma ${selectedProformaId}`, "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const startEdit = (line: ProformaLine) => {
    setEditingLineId(line.id);
    setEditLineData({
      barcode: line.barcode,
      itemName: line.itemName,
      qty: String(line.qty),
      weightPerBale: line.weightPerBale,
      pricePerBale: line.pricePerBale,
    });
  };
  return { downloadTemplate, exportProformaExcel, handleFileImport, startEdit };
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
