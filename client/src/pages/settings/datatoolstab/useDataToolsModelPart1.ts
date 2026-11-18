// Extracted from ./useDataToolsModel.ts to keep that module under the source-size cap.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { read, utils, writeFile } from "@/lib/excelHelper";
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

export function useDataToolsModelPart1() {
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
  return {
    allStockItems,
    appMode,
    bulkRenameOpen,
    costPriceErrors,
    costPriceFile,
    costPriceImportComplete,
    costPriceImportOpen,
    costPriceLocationId,
    costPricePreview,
    downloadCostPriceTemplate,
    downloadStockTemplate,
    dtCurrentUser,
    handleCostPriceDialogClose,
    handleCostPriceFileChange,
    handleCostPriceImport,
    isImportingCostPrice,
    isImportingStock,
    isSilentApplying,
    isSilentParsing,
    locations,
    modeApiRequest,
    selectedCompany,
    setBulkRenameOpen,
    setCostPriceImportOpen,
    setCostPriceLocationId,
    setIsImportingStock,
    setIsSilentApplying,
    setIsSilentParsing,
    setSilentAppliedCount,
    setSilentDstId,
    setSilentErrorLines,
    setSilentFile,
    setSilentImportLoading,
    setSilentImportMode,
    setSilentImportPreview,
    setSilentIncludeWarnings,
    setSilentParseError,
    setSilentProdApplying,
    setSilentProdDone,
    setSilentProdItems,
    setSilentProdLocId,
    setSilentProdOpen,
    setSilentProdSearchTerm,
    setSilentProdType,
    setSilentSrcId,
    setSilentStep,
    setSilentTransferOpen,
    setSilentValidItems,
    setSilentWarnItems,
    setStockErrors,
    setStockFile,
    setStockImportComplete,
    setStockImportOpen,
    setStockLocationId,
    setStockPreview,
    silentAppliedCount,
    silentDstId,
    silentErrorLines,
    silentFile,
    silentImportFileRef,
    silentImportLoading,
    silentImportMode,
    silentImportPreview,
    silentIncludeWarnings,
    silentLocInventory,
    silentLocInventoryLoading,
    silentParseError,
    silentProdApplying,
    silentProdDone,
    silentProdItems,
    silentProdLocId,
    silentProdOpen,
    silentProdSearchTerm,
    silentProdType,
    silentSrcId,
    silentStep,
    silentTransferOpen,
    silentValidItems,
    silentWarnItems,
    stockErrors,
    stockFile,
    stockImportComplete,
    stockImportOpen,
    stockLocationId,
    stockPreview,
    toast,
  };
}
