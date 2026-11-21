import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  useStockTransferOrderWorkflowsPart1,
  type UseStockTransferOrderWorkflowsInput,
} from "./useStockTransferOrderWorkflowsPart1";

export function useStockTransferOrderWorkflows({
  editVoucherId,
  existingTransfer,
  existingDescription,
  locations,
  stockItems,
  orderItems,
  setOrderItems,
  summaryData,
  destinationLocationId,
  transferDate,
  isOptional,
  revisionCount,
  validateOrder,
  setValidationErrors,
}: UseStockTransferOrderWorkflowsInput) {
  const {
    toast,
    navigate,
    setRevisionDialogOpen,
    revisionDialogOpen,
    revisionNote,
    setRevisionNote,
    setIsSavingRevision,
    isSavingRevision,
    setImportDialogOpen,
    importDialogOpen,
    importPreview,
    setImportPreview,
    importLoading,
    importFileRef,
    computeRevisionItems,
    downloadImportTemplate,
    handleImportFile,
  } = useStockTransferOrderWorkflowsPart1({ existingTransfer, locations, stockItems, orderItems, summaryData });

  const applyImport = () => {
    const updated = [...orderItems];

    for (const row of importPreview) {
      if (row.status === "not_found") continue;
      const index = updated.findIndex((item) => item.stockItemId === row.stockItemId);
      if (index >= 0) {
        const newQty = updated[index].quantity + row.change;
        if (newQty <= 0) updated.splice(index, 1);
        else updated[index] = { ...updated[index], quantity: newQty };
        continue;
      }

      if (!row.stockItemId || row.newQty <= 0 || !row.sourceLocationId) continue;
      const stockItem = stockItems.find((item) => item.id === row.stockItemId);
      let availableQty = 0;

      if (summaryData) {
        for (const group of summaryData.stockGroups) {
          const summaryItem = group.items.find((item) => item.id === row.stockItemId);
          const locationData = summaryItem?.locationData[row.sourceLocationId];
          if (locationData) availableQty = locationData.quantity;
        }
      }

      updated.push({
        stockItemId: row.stockItemId,
        stockItemName: row.stockItemName,
        stockItemCode: stockItem?.code || "",
        uom: stockItem?.uom || "",
        sourceLocationId: row.sourceLocationId,
        sourceLocationName: row.sourceLocationName,
        quantity: row.newQty,
        availableQty,
        rate: 0,
      });
    }

    setOrderItems(updated);
    setImportDialogOpen(false);
    setImportPreview([]);
    toast({
      title: "Import Applied",
      description: `${importPreview.filter((row) => row.status !== "not_found").length} items updated`,
    });
  };

  const exportPreviewExcel = async () => {
    const workbook = utils.book_new();
    const worksheet = workbook.addWorksheet("Transfer Order");
    worksheet.addRow(["Item Name", "Qty"]);
    worksheet.getRow(1).font = { bold: true };

    for (const row of importPreview.filter((item) => item.newQty > 0 && item.status !== "not_found")) {
      worksheet.addRow([row.stockItemName, row.newQty]);
    }

    worksheet.getColumn(1).width = 36;
    worksheet.getColumn(2).width = 12;
    await writeFile(workbook, exportFileName("transfer order preview", "xlsx"));
  };

  const exportPreviewPDF = async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const document = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    document.setFontSize(14);
    document.text("Transfer Order Preview", 14, 18);
    document.setFontSize(10);
    document.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 25);

    const rows = importPreview
      .filter((row) => row.newQty > 0 && row.status !== "not_found")
      .map((row, index) => [index + 1, row.stockItemName, row.newQty]);
    autoTable(document, {
      startY: 30,
      head: [["#", "Item Name", "Qty"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 30, 30] },
      columnStyles: {
        0: { cellWidth: 12 },
        2: { cellWidth: 20, halign: "right" },
      },
    });
    document.save(exportFileName("transfer order preview", "pdf"));
  };

  const handleSaveAsRevision = async () => {
    const errors = validateOrder();
    if (errors.length > 0) {
      setValidationErrors(errors);
      toast({
        title: "Cannot Save",
        description: "Please fix validation errors first",
        variant: "destructive",
      });
      return;
    }
    setRevisionDialogOpen(true);
  };

  const confirmSaveAsRevision = async () => {
    const revisionItems = computeRevisionItems();
    if (revisionItems.length === 0) {
      toast({
        title: "No Changes",
        description: "No differences found compared to the saved order",
        variant: "destructive",
      });
      setRevisionDialogOpen(false);
      return;
    }

    if (!destinationLocationId || !existingTransfer?.id || !editVoucherId) return;

    setIsSavingRevision(true);
    try {
      const nonZeroItems = orderItems.filter((item) => item.quantity > 0);
      const persistedDescription =
        existingTransfer.notes?.trim() ||
        existingDescription?.trim() ||
        `Stock Transfer Order - ${nonZeroItems.length} items`;

      await apiRequest("PATCH", `/api/vouchers/${editVoucherId}`, {
        voucherDate: format(transferDate, "yyyy-MM-dd"),
        description: persistedDescription,
        optional: isOptional,
      });

      if (nonZeroItems.length === 0) {
        toast({
          title: "Cannot Save",
          description: "All items have been removed — cannot save an empty transfer as a revision",
          variant: "destructive",
        });
        setRevisionDialogOpen(false);
        return;
      }

      await apiRequest("PUT", `/api/stock-transfers/${existingTransfer.id}`, {
        destinationLocationId,
        notes: persistedDescription,
        items: nonZeroItems.map((item) => ({
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: item.quantity,
          rate: item.rate,
        })),
      });
      await apiRequest("POST", `/api/stock-transfers/${existingTransfer.id}/revisions`, {
        note: revisionNote.trim() || null,
        items: revisionItems,
      });

      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers", editVoucherId] });
      queryClient.invalidateQueries({
        queryKey: ["/api/stock-transfers", existingTransfer.id, "revisions"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      setRevisionNote("");
      setRevisionDialogOpen(false);
      toast({
        title: "Revision Saved",
        description: `Rev ${revisionCount + 1} recorded and order updated`,
      });
      navigate("/daybook");
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to save revision";
      toast({ title: "Save failed", description, variant: "destructive" });
    } finally {
      setIsSavingRevision(false);
    }
  };

  return {
    revisionDialogOpen,
    setRevisionDialogOpen,
    revisionNote,
    setRevisionNote,
    isSavingRevision,
    importDialogOpen,
    setImportDialogOpen,
    importPreview,
    setImportPreview,
    importLoading,
    importFileRef,
    computeRevisionItems,
    downloadImportTemplate,
    handleImportFile,
    applyImport,
    exportPreviewExcel,
    exportPreviewPDF,
    handleSaveAsRevision,
    confirmSaveAsRevision,
  };
}
