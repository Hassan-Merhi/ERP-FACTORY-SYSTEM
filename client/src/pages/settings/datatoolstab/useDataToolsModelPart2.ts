// Extracted from ./useDataToolsModel.ts to keep that module under the source-size cap.
import { queryClient } from "@/lib/queryClient";
import { read, readFile, utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import type { SilentImportRow } from "./types";
import { useDataToolsModelPart1 } from "./useDataToolsModelPart1";

export function useDataToolsModelPart2({
  allStockItems,
  modeApiRequest,
  setIsImportingStock,
  setSilentImportLoading,
  setSilentImportPreview,
  setStockErrors,
  setStockFile,
  setStockImportComplete,
  setStockImportOpen,
  setStockPreview,
  silentImportPreview,
  silentLocInventory,
  stockErrors,
  stockLocationId,
  stockPreview,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useDataToolsModelPart1>>,
  | "allStockItems"
  | "modeApiRequest"
  | "setIsImportingStock"
  | "setSilentImportLoading"
  | "setSilentImportPreview"
  | "setStockErrors"
  | "setStockFile"
  | "setStockImportComplete"
  | "setStockImportOpen"
  | "setStockPreview"
  | "silentImportPreview"
  | "silentLocInventory"
  | "stockErrors"
  | "stockLocationId"
  | "stockPreview"
  | "toast"
>) {
  const handleStockFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    setStockFile(selectedFile);
    setStockErrors([]);
    setStockPreview([]);
    setStockImportComplete(false);

    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json<Record<string, unknown>>(worksheet);

      if (jsonData.length === 0) {
        toast({ title: "Empty File", description: "The Excel file is empty.", variant: "destructive" });
        return;
      }

      const headerRow = utils.sheet_to_json<string[]>(worksheet, { header: 1 })[0] || [];
      const columns = headerRow.map((header) => String(header || "").trim());
      const requiredColumns = ["Item_barcode", "quantity", "rate", "value"];
      const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
      if (missingColumns.length > 0) {
        toast({
          title: "Missing Required Columns",
          description: `Expected: ${requiredColumns.join(", ")}. Download template for format.`,
          variant: "destructive",
        });
        return;
      }

      const errors: string[] = [];
      const rows: Array<{
        Item_barcode: string;
        stockGroupCode?: string;
        quantity: string;
        rate: string;
        value: string;
      }> = [];
      jsonData.forEach((row, index: number) => {
        const rowNumber = index + 2;
        if (!row.Item_barcode || String(row.Item_barcode).trim() === "") {
          errors.push(`Row ${rowNumber}: Item_barcode is required`);
          return;
        }
        const quantity = parseFloat(String(row.quantity ?? "0"));
        const rate = parseFloat(String(row.rate ?? "0"));
        const value = parseFloat(String(row.value ?? "0"));
        if (isNaN(quantity) || quantity === 0) {
          errors.push(`Row ${rowNumber}: Quantity must be a non-zero number (negative quantities are allowed)`);
          return;
        }
        if (isNaN(rate) || rate < 0) {
          errors.push(`Row ${rowNumber}: Rate must be >= 0`);
          return;
        }
        rows.push({
          Item_barcode: String(row.Item_barcode).trim(),
          stockGroupCode: row.stockGroupCode ? String(row.stockGroupCode).trim() : undefined,
          quantity: String(quantity),
          rate: String(rate),
          value: String(value),
        });
      });
      setStockPreview(rows);
      setStockErrors(errors);
    } catch {
      toast({ title: "Error Reading File", description: "Please ensure valid Excel file.", variant: "destructive" });
    }
  };

  const handleStockImport = async () => {
    if (!stockLocationId) {
      toast({ title: "No Location Selected", description: "Please select a location first", variant: "destructive" });
      return;
    }
    if (stockErrors.length > 0) {
      toast({ title: "Cannot Import", description: "Please fix validation errors first", variant: "destructive" });
      return;
    }

    setIsImportingStock(true);
    try {
      const res = await modeApiRequest("POST", `/api/locations/${stockLocationId}/import-inventory`, {
        items: stockPreview,
      });
      const response = await res.json();
      queryClient.invalidateQueries({ queryKey: [`/api/locations/${stockLocationId}/inventory`] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      setStockImportComplete(true);
      toast({
        title: "Import Successful",
        description: `Imported ${response.imported || stockPreview.length} inventory items`,
      });
    } catch (error: unknown) {
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : "Failed to import",
        variant: "destructive",
      });
    } finally {
      setIsImportingStock(false);
    }
  };

  const handleStockDialogClose = async () => {
    setStockImportOpen(false);
    setStockFile(null);
    setStockPreview([]);
    setStockErrors([]);
    setStockImportComplete(false);
  };

  const downloadSilentTemplate = async () => {
    const workbook = utils.book_new();
    const worksheet = workbook.addWorksheet("Silent Adjustment");
    worksheet.addRow(["Code", "Name", "Qty Change", "Rate"]);
    worksheet.getRow(1).font = { bold: true };
    worksheet.getColumn(1).width = 16;
    worksheet.getColumn(2).width = 36;
    worksheet.getColumn(3).width = 14;
    worksheet.getColumn(4).width = 12;
    worksheet.addRow(["ABC123", "Example Item A", 50, 10.5]);
    worksheet.addRow(["XYZ456", "Example Item B", -20, ""]);
    worksheet.getRow(2).font = { italic: true, color: { argb: "FF999999" } };
    worksheet.getRow(3).font = { italic: true, color: { argb: "FF999999" } };
    await writeFile(workbook, "silent_adjustment_template.xlsx");
    toast({ title: "Template Downloaded" });
  };

  const getCurrentQty = (stockItemId: number): number => {
    const locationRow = silentLocInventory.find((inventory) => inventory.stockItemId === stockItemId);
    return locationRow ? parseFloat(locationRow.quantity || "0") : 0;
  };

  const handleSilentImportFile = async (file: File) => {
    setSilentImportLoading(true);
    try {
      const workbook = await readFile(file);
      const worksheet = workbook.getWorksheet(1);
      if (!worksheet) {
        toast({ title: "Import failed", description: "Could not read worksheet", variant: "destructive" });
        return;
      }
      const rows = utils.sheet_to_json<{
        Code?: unknown;
        Name?: unknown;
        "Qty Change"?: unknown;
        "Item Name"?: unknown;
        Change?: unknown;
        Rate?: unknown;
      }>(worksheet);

      const preview: SilentImportRow[] = rows
        .filter((row) => row.Code !== undefined || row.Name !== undefined || row["Item Name"] !== undefined)
        .map((row) => {
          const code = String(row.Code ?? "").trim();
          const name = String(row.Name ?? row["Item Name"] ?? "").trim();
          const change = parseFloat(String(row["Qty Change"] ?? row.Change ?? "0")) || 0;
          const rate = parseFloat(String(row.Rate ?? "0")) || 0;

          let matched = code
            ? allStockItems.find((item) => item.code?.toLowerCase() === code.toLowerCase())
            : undefined;
          if (!matched && name) {
            matched = allStockItems.find((item) => item.name.toLowerCase() === name.toLowerCase());
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
              rate,
              status: "not_found" as const,
            };
          }

          const currentQty = getCurrentQty(matched.id);
          const newQty = currentQty + change;
          const status: SilentImportRow["status"] = newQty <= 0 ? "to_zero" : "ok";
          return {
            rawCode: code,
            rawName: name,
            stockItemId: matched.id,
            stockItemName: matched.name,
            currentQty,
            change,
            newQty: Math.max(0, newQty),
            rate,
            status,
          };
        });
      setSilentImportPreview(preview);
    } catch (error: unknown) {
      toast({
        title: "Parse Error",
        description: error instanceof Error ? error.message : "Failed to read file",
        variant: "destructive",
      });
    } finally {
      setSilentImportLoading(false);
    }
  };

  const exportSilentExcel = async () => {
    const workbook = utils.book_new();
    const worksheet = workbook.addWorksheet("Adjustment");
    worksheet.addRow(["Item Name", "Qty"]);
    worksheet.getRow(1).font = { bold: true };
    for (const row of silentImportPreview.filter((item) => item.status !== "not_found")) {
      worksheet.addRow([row.stockItemName, row.newQty]);
    }
    worksheet.getColumn(1).width = 36;
    worksheet.getColumn(2).width = 12;
    await writeFile(workbook, exportFileName("silent adjustment preview", "xlsx"));
  };
  return {
    downloadSilentTemplate,
    exportSilentExcel,
    handleSilentImportFile,
    handleStockDialogClose,
    handleStockFileChange,
    handleStockImport,
  };
}
