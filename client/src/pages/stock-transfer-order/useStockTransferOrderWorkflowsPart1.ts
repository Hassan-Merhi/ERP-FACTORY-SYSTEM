// Extracted from ./useStockTransferOrderWorkflows.ts
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "wouter";
import { readFile, utils, writeFile } from "@/lib/excelHelper";
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

export type UseStockTransferOrderWorkflowsInput = {
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

export function useStockTransferOrderWorkflowsPart1({
  existingTransfer,
  locations,
  stockItems,
  orderItems,
  summaryData,
}: Pick<
  UseStockTransferOrderWorkflowsInput,
  "existingTransfer" | "locations" | "stockItems" | "orderItems" | "summaryData"
>) {
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
          title: "Import failed",
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
  return {
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
  };
}
