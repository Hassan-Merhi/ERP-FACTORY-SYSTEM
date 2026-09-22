import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { readFile, utils, writeFile } from "@/lib/excelHelper";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ImportPreviewRow, Location, LocationSummaryResponse, OrderItem } from "../stocktransferorder/types";

type StockItemOption = {
  id: number;
  name: string;
  code: string;
  uom: string;
};

type ExistingTransferItem = {
  stockItemId: number;
  sourceLocationId?: number | null;
  quantity: string | number;
};

type ExistingTransfer = {
  id: number;
  notes?: string | null;
  items?: ExistingTransferItem[];
};

type ImportSheetRow = {
  Code?: unknown;
  Name?: unknown;
  "Qty Change"?: unknown;
  "Item Name"?: unknown;
  Change?: unknown;
  Qty?: unknown;
};

type UseStockTransferOrderWorkflowsInput = {
  editVoucherId: number | null;
  existingTransfer: ExistingTransfer | undefined;
  existingDescription?: string | null;
  locations: Location[];
  stockItems: StockItemOption[];
  orderItems: OrderItem[];
  setOrderItems: Dispatch<SetStateAction<OrderItem[]>>;
  summaryData: LocationSummaryResponse | undefined;
  destinationLocationId: number | null;
  transferDate: Date;
  isOptional: boolean;
  revisionCount: number;
  validateOrder: () => string[];
  setValidationErrors: Dispatch<SetStateAction<string[]>>;
};

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
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");
  const [isSavingRevision, setIsSavingRevision] = useState(false);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const computeRevisionItems = () => {
    if (!existingTransfer?.items) return [];

    type RevKey = string;
    const originalMap = new Map<
      RevKey,
      {
        qty: number;
        name: string;
        srcName: string;
        stockItemId: number;
        sourceLocationId: number | null;
      }
    >();

    for (const item of existingTransfer.items) {
      const key: RevKey = `${item.stockItemId}-${item.sourceLocationId ?? "null"}`;
      const stockItem = stockItems.find((candidate) => candidate.id === item.stockItemId);
      const sourceLocation = locations.find((location) => location.id === item.sourceLocationId);
      originalMap.set(key, {
        qty: parseFloat(String(item.quantity)) || 0,
        name: stockItem?.name || "",
        srcName: sourceLocation?.name || "",
        stockItemId: item.stockItemId,
        sourceLocationId: item.sourceLocationId ?? null,
      });
    }

    const currentMap = new Map<RevKey, OrderItem>();
    for (const item of orderItems) {
      const key: RevKey = `${item.stockItemId}-${item.sourceLocationId ?? "null"}`;
      currentMap.set(key, item);
    }

    const allKeys = new Set([...originalMap.keys(), ...currentMap.keys()]);
    const result: Array<{
      stockItemId: number;
      stockItemName: string;
      sourceLocationId: number | null;
      sourceLocationName: string;
      originalQuantity: number;
      delta: number;
      newQuantity: number;
    }> = [];

    for (const key of allKeys) {
      const original = originalMap.get(key);
      const current = currentMap.get(key);
      const originalQuantity = original?.qty ?? 0;
      const currentQuantity = current?.quantity ?? 0;
      const delta = currentQuantity - originalQuantity;
      if (Math.abs(delta) < 0.001) continue;

      result.push({
        stockItemId: current?.stockItemId ?? original?.stockItemId ?? 0,
        stockItemName: current?.stockItemName || original?.name || "",
        sourceLocationId: current?.sourceLocationId ?? original?.sourceLocationId ?? null,
        sourceLocationName: current?.sourceLocationName || original?.srcName || "",
        originalQuantity,
        delta,
        newQuantity: currentQuantity,
      });
    }

    return result;
  };

  const downloadImportTemplate = async () => {
    const workbook = utils.book_new();
    const worksheet = workbook.addWorksheet("Transfer Import");
    worksheet.addRow(["Code", "Name", "Qty Change"]);
    worksheet.getRow(1).font = { bold: true };
    worksheet.getColumn(1).width = 16;
    worksheet.getColumn(2).width = 36;
    worksheet.getColumn(3).width = 14;
    worksheet.addRow(["ABC123", "Example Item", 10]);
    worksheet.addRow(["XYZ456", "Another Item", -5]);
    worksheet.getRow(2).font = { italic: true, color: { argb: "FF999999" } };
    worksheet.getRow(3).font = { italic: true, color: { argb: "FF999999" } };
    await writeFile(workbook, "transfer_import_template.xlsx");
  };

  const handleImportFile = async (file: File) => {
    setImportLoading(true);
    try {
      const workbook = await readFile(file);
      const worksheet = workbook.getWorksheet(1);
      if (!worksheet) {
        toast({
          title: "Error",
          description: "Could not read worksheet",
          variant: "destructive",
        });
        return;
      }

      const rows = utils.sheet_to_json<ImportSheetRow>(worksheet);
      const preview: ImportPreviewRow[] = rows
        .filter((row) => row.Code !== undefined || row.Name !== undefined || row["Item Name"] !== undefined)
        .map((row) => {
          const code = String(row.Code ?? "").trim();
          const name = String(row.Name ?? row["Item Name"] ?? "").trim();
          const change = parseFloat(String(row["Qty Change"] ?? row.Change ?? row.Qty ?? "0")) || 0;

          let matched = code ? stockItems.find((item) => item.code?.toLowerCase() === code.toLowerCase()) : undefined;
          if (!matched && name) {
            matched = stockItems.find((item) => item.name.toLowerCase() === name.toLowerCase());
          }

          if (!matched) {
            return {
              rawCode: code,
              rawName: name,
              stockItemId: null,
              stockItemName: name || code || "Unknown",
              currentQty: 0,
              change,
              newQty: Math.max(0, change),
              sourceLocationId: null,
              sourceLocationName: "",
              status: "not_found" as const,
            };
          }

          const currentQty = orderItems
            .filter((item) => item.stockItemId === matched.id)
            .reduce((sum, item) => sum + item.quantity, 0);
          const newQty = currentQty + change;

          let sourceLocationId: number | null = null;
          let sourceLocationName = "";
          const existingOrderItem = orderItems.find((item) => item.stockItemId === matched.id);
          if (existingOrderItem) {
            sourceLocationId = existingOrderItem.sourceLocationId;
            sourceLocationName = existingOrderItem.sourceLocationName;
          } else if (summaryData) {
            let bestQty = 0;
            for (const group of summaryData.stockGroups) {
              const summaryItem = group.items.find((item) => item.id === matched.id);
              if (!summaryItem) continue;

              for (const [locationIdValue, locationData] of Object.entries(summaryItem.locationData)) {
                if (locationData.quantity > bestQty) {
                  bestQty = locationData.quantity;
                  sourceLocationId = parseInt(locationIdValue);
                  sourceLocationName = locations.find((location) => location.id === sourceLocationId)?.name || "";
                }
              }
            }
          }

          const status: ImportPreviewRow["status"] = newQty <= 0 ? "remove" : currentQty === 0 ? "new_item" : "ok";
          return {
            rawCode: code,
            rawName: name,
            stockItemId: matched.id,
            stockItemName: matched.name,
            currentQty,
            change,
            newQty: Math.max(0, newQty),
            sourceLocationId,
            sourceLocationName,
            status,
          };
        });

      setImportPreview(preview);
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to read file";
      toast({ title: "Parse Error", description, variant: "destructive" });
    } finally {
      setImportLoading(false);
    }
  };

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
    await writeFile(workbook, "transfer_order_preview.xlsx");
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
    document.save("transfer_order_preview.pdf");
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
      toast({ title: "Error", description, variant: "destructive" });
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
