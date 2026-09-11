import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { read, readFile, utils, writeFile } from "@/lib/excelHelper";
import type { SilentImportRow } from "./types";

/** One parsed line from /api/inventory/silent-transfer/parse. */
export type SilentTransferItem = {
  rowNum: number;
  barcode: string;
  stockItemId: number;
  stockItemName: string;
  uom: string;
  quantity: number;
  currentStock: number;
  averageRate: number;
  afterTransfer: number;
};

export type SilentTransferWarnItem = SilentTransferItem & { warnReason: string };

export type SilentTransferErrorLine = { rowNum: number; barcode: string; reason: string };

type StockItemLight = { id: number; code: string; name: string; [key: string]: unknown };
type LocationRow = { id: number; name: string; [key: string]: unknown };

export function useDataToolsModel() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [costPriceLocationId, setCostPriceLocationId] = useState("");
  const [stockLocationId, setStockLocationId] = useState("");

  const [costPriceImportOpen, setCostPriceImportOpen] = useState(false);
  const [costPriceFile, setCostPriceFile] = useState<File | null>(null);
  const [costPricePreview, setCostPricePreview] = useState<Array<{ barcode: string; costPrice: number }>>([]);
  const [costPriceErrors, setCostPriceErrors] = useState<string[]>([]);
  const [isImportingCostPrice, setIsImportingCostPrice] = useState(false);
  const [costPriceImportComplete, setCostPriceImportComplete] = useState(false);

  const [stockImportOpen, setStockImportOpen] = useState(false);
  const [stockFile, setStockFile] = useState<File | null>(null);
  const [stockPreview, setStockPreview] = useState<
    Array<{ Item_barcode: string; stockGroupCode?: string; quantity: string; rate: string; value: string }>
  >([]);
  const [stockErrors, setStockErrors] = useState<string[]>([]);
  const [isImportingStock, setIsImportingStock] = useState(false);
  const [stockImportComplete, setStockImportComplete] = useState(false);

  const { data: dtCurrentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });

  const [silentProdOpen, setSilentProdOpen] = useState(false);
  const [silentProdType, setSilentProdType] = useState<"Production" | "Consumption">("Production");
  const [silentProdLocId, setSilentProdLocId] = useState("");
  const [silentProdItems, setSilentProdItems] = useState<
    { stockItemId: string; stockItemName: string; quantity: string; rate: string; currentQty: number }[]
  >([{ stockItemId: "", stockItemName: "", quantity: "", rate: "", currentQty: 0 }]);
  const [silentProdSearchTerm, setSilentProdSearchTerm] = useState("");
  const [silentProdApplying, setSilentProdApplying] = useState(false);
  const [silentProdDone, setSilentProdDone] = useState(0);

  const [silentImportMode, setSilentImportMode] = useState(false);
  const [silentImportPreview, setSilentImportPreview] = useState<SilentImportRow[]>([]);
  const [silentImportLoading, setSilentImportLoading] = useState(false);
  const silentImportFileRef = useRef<HTMLInputElement>(null);

  const [silentTransferOpen, setSilentTransferOpen] = useState(false);
  const [silentSrcId, setSilentSrcId] = useState("");
  const [silentDstId, setSilentDstId] = useState("");
  const [silentFile, setSilentFile] = useState<File | null>(null);
  const [silentValidItems, setSilentValidItems] = useState<SilentTransferItem[]>([]);
  const [silentWarnItems, setSilentWarnItems] = useState<SilentTransferWarnItem[]>([]);
  const [silentErrorLines, setSilentErrorLines] = useState<SilentTransferErrorLine[]>([]);
  const [silentIncludeWarnings, setSilentIncludeWarnings] = useState(false);
  const [silentParseError, setSilentParseError] = useState("");
  const [silentStep, setSilentStep] = useState<"setup" | "validation" | "done">("setup");
  const [isSilentParsing, setIsSilentParsing] = useState(false);
  const [isSilentApplying, setIsSilentApplying] = useState(false);
  const [silentAppliedCount, setSilentAppliedCount] = useState(0);

  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);

  const { data: locations = [] } = useQuery<LocationRow[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: allStockItems = [] } = useQuery<StockItemLight[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    enabled: !!selectedCompany && dtCurrentUser?.role === "Developer",
    staleTime: 10 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: silentLocInventory = [], isLoading: silentLocInventoryLoading } = useQuery<
    {
      stockItemId: number;
      stockItemName: string;
      stockItemCode: string;
      quantity: string;
    }[]
  >({
    queryKey: ["/api/inventory-by-location", silentProdLocId],
    queryFn: async () => {
      if (!silentProdLocId) return [];
      const res = await fetch(`/api/inventory-by-location/${silentProdLocId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!silentProdLocId && silentProdOpen,
  });

  const recalculateCostsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sales-report/recalculate-costs", {});
      const summary: { updatedCount?: number; totalChecked?: number } = await res.json();
      return summary;
    },
    onSuccess: (data: { updatedCount?: number; totalChecked?: number }) => {
      toast({
        title: "Cost Prices Updated",
        description: `Updated ${data.updatedCount} of ${data.totalChecked} sales items`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-report"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const downloadCostPriceTemplate = async () => {
    const template = [
      { barcode: "ITEM001", costPrice: "125.50" },
      { barcode: "ITEM002", costPrice: "95.75" },
    ];
    const worksheet = utils.json_to_sheet(template);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Cost Price Import");
    await writeFile(workbook, "cost_price_import_template.xlsx");
    toast({ title: "Template Downloaded", description: "Use this template to update cost prices" });
  };

  const handleCostPriceFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    setCostPriceFile(selectedFile);
    setCostPriceErrors([]);
    setCostPricePreview([]);
    setCostPriceImportComplete(false);

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
      const requiredColumns = ["barcode", "costPrice"];
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
      const rows: Array<{ barcode: string; costPrice: number }> = [];
      jsonData.forEach((row, index: number) => {
        const rowNumber = index + 2;
        if (!row.barcode || String(row.barcode).trim() === "") {
          errors.push(`Row ${rowNumber}: Barcode is required`);
          return;
        }
        const costPrice = parseFloat(String(row.costPrice ?? "0"));
        if (isNaN(costPrice) || costPrice <= 0) {
          errors.push(`Row ${rowNumber}: Cost price must be > 0`);
          return;
        }
        rows.push({ barcode: String(row.barcode).trim(), costPrice });
      });

      setCostPricePreview(rows);
      setCostPriceErrors(errors);
    } catch {
      toast({ title: "Error Reading File", description: "Please ensure valid Excel file.", variant: "destructive" });
    }
  };

  const handleCostPriceImport = async () => {
    if (!costPriceLocationId) {
      toast({ title: "No Location Selected", description: "Please select a location first", variant: "destructive" });
      return;
    }
    if (costPriceErrors.length > 0) {
      toast({ title: "Cannot Import", description: "Please fix validation errors first", variant: "destructive" });
      return;
    }

    setIsImportingCostPrice(true);
    try {
      const res = await modeApiRequest("POST", `/api/locations/${costPriceLocationId}/import-cost-prices`, {
        updates: costPricePreview,
      });
      const response = await res.json();
      queryClient.invalidateQueries({ queryKey: [`/api/locations/${costPriceLocationId}/inventory`] });
      setCostPriceImportComplete(true);
      toast({ title: "Import Successful", description: `Updated ${response.updated} cost prices.` });
    } catch (error: unknown) {
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : "Failed to import",
        variant: "destructive",
      });
    } finally {
      setIsImportingCostPrice(false);
    }
  };

  const handleCostPriceDialogClose = async () => {
    setCostPriceImportOpen(false);
    setCostPriceFile(null);
    setCostPricePreview([]);
    setCostPriceErrors([]);
    setCostPriceImportComplete(false);
  };

  const downloadStockTemplate = async () => {
    const template = [
      { Item_barcode: "ITEM-001", stockGroupCode: "GRP01", quantity: "100", rate: "50.00", value: "5000.00" },
      { Item_barcode: "ITEM-002", stockGroupCode: "GRP02", quantity: "50", rate: "100.00", value: "5000.00" },
    ];
    const worksheet = utils.json_to_sheet(template);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Stock Import");
    await writeFile(workbook, "stock_import_template.xlsx");
    toast({ title: "Template Downloaded", description: "Use this template to import stock" });
  };

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
        toast({ title: "Error", description: "Could not read worksheet", variant: "destructive" });
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

          let matched = code ? allStockItems.find((item) => item.code?.toLowerCase() === code.toLowerCase()) : undefined;
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
    await writeFile(workbook, "silent_adjustment_preview.xlsx");
  };

  const exportSilentPDF = async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const document = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    document.setFontSize(14);
    document.text("Silent Adjustment Preview", 14, 18);
    document.setFontSize(10);
    document.text(
      `Location: ${locations.find((location) => String(location.id) === silentProdLocId)?.name || ""}   Date: ${new Date().toLocaleDateString()}`,
      14,
      25
    );
    const rows = silentImportPreview
      .filter((row) => row.status !== "not_found")
      .map((row, index) => [index + 1, row.stockItemName, row.newQty]);
    autoTable(document, {
      startY: 30,
      head: [["#", "Item Name", "New Qty"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 30, 30] },
      columnStyles: { 0: { cellWidth: 12 }, 2: { cellWidth: 22, halign: "right" } },
    });
    document.save("silent_adjustment_preview.pdf");
  };

  const applySilentImport = async () => {
    const valid = silentImportPreview.filter((row) => row.stockItemId !== null && row.status !== "not_found");
    const productions = valid.filter((row) => row.change > 0);
    const consumptions = valid.filter((row) => row.change < 0);
    if (valid.length === 0) return;
    setSilentProdApplying(true);
    try {
      let totalApplied = 0;
      if (productions.length > 0) {
        const res = await apiRequest("POST", "/api/inventory/silent-production", {
          locationId: silentProdLocId,
          type: "Production",
          items: productions.map((row) => ({
            stockItemId: String(row.stockItemId),
            quantity: String(Math.abs(row.change)),
            rate: String(row.rate),
          })),
        });
        const data = await res.json();
        totalApplied += data.applied || productions.length;
      }
      if (consumptions.length > 0) {
        const res = await apiRequest("POST", "/api/inventory/silent-production", {
          locationId: silentProdLocId,
          type: "Consumption",
          items: consumptions.map((row) => ({
            stockItemId: String(row.stockItemId),
            quantity: String(Math.abs(row.change)),
            rate: "0",
          })),
        });
        const data = await res.json();
        totalApplied += data.applied || consumptions.length;
      }
      setSilentProdDone(totalApplied);
      setSilentImportPreview([]);
      setSilentImportMode(false);
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
    } catch (error: unknown) {
      toast({ title: "Error", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setSilentProdApplying(false);
    }
  };

  return {
    toast,
    selectedCompany,
    appMode,
    costPriceLocationId,
    setCostPriceLocationId,
    stockLocationId,
    setStockLocationId,
    costPriceImportOpen,
    setCostPriceImportOpen,
    costPriceFile,
    costPricePreview,
    costPriceErrors,
    isImportingCostPrice,
    costPriceImportComplete,
    downloadCostPriceTemplate,
    handleCostPriceFileChange,
    handleCostPriceImport,
    handleCostPriceDialogClose,
    stockImportOpen,
    setStockImportOpen,
    stockFile,
    stockPreview,
    stockErrors,
    isImportingStock,
    stockImportComplete,
    downloadStockTemplate,
    handleStockFileChange,
    handleStockImport,
    handleStockDialogClose,
    dtCurrentUser,
    silentProdOpen,
    setSilentProdOpen,
    silentProdType,
    setSilentProdType,
    silentProdLocId,
    setSilentProdLocId,
    silentProdItems,
    setSilentProdItems,
    silentProdSearchTerm,
    setSilentProdSearchTerm,
    silentProdApplying,
    setSilentProdApplying,
    silentProdDone,
    setSilentProdDone,
    silentImportMode,
    setSilentImportMode,
    silentImportPreview,
    setSilentImportPreview,
    silentImportLoading,
    silentImportFileRef,
    silentTransferOpen,
    setSilentTransferOpen,
    silentSrcId,
    setSilentSrcId,
    silentDstId,
    setSilentDstId,
    silentFile,
    setSilentFile,
    silentValidItems,
    setSilentValidItems,
    silentWarnItems,
    setSilentWarnItems,
    silentErrorLines,
    setSilentErrorLines,
    silentIncludeWarnings,
    setSilentIncludeWarnings,
    silentParseError,
    setSilentParseError,
    silentStep,
    setSilentStep,
    isSilentParsing,
    setIsSilentParsing,
    isSilentApplying,
    setIsSilentApplying,
    silentAppliedCount,
    setSilentAppliedCount,
    bulkRenameOpen,
    setBulkRenameOpen,
    locations,
    allStockItems,
    silentLocInventory,
    silentLocInventoryLoading,
    recalculateCostsMutation,
    downloadSilentTemplate,
    handleSilentImportFile,
    exportSilentExcel,
    exportSilentPDF,
    applySilentImport,
  };
}
