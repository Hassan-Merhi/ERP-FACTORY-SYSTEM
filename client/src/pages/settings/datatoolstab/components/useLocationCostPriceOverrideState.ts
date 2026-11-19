// Extracted from ./LocationCostPriceOverride.tsx
import { useState } from "react";
import { getErrorDetails } from "@shared/errorUtils";
import { useAppMode } from "@/contexts/AppModeContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";

interface CostPriceSpreadsheetRow {
  barcode?: unknown;
  costPrice?: unknown;
}

interface CostPriceImportResponse {
  updated?: number;
}

export function useLocationCostPriceOverrideState() {
  const { toast } = useToast();
  const { t } = useApplicationLanguage();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [locationId, setLocationId] = useState("");
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Array<{ barcode: string; costPrice: number }>>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  const resetDialog = () => {
    setFile(null);
    setPreview([]);
    setErrors([]);
    setIsComplete(false);
  };

  const downloadTemplate = async () => {
    const template = [
      { barcode: "ITEM001", costPrice: "125.50" },
      { barcode: "ITEM002", costPrice: "95.75" },
    ];
    const ws = utils.json_to_sheet(template);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Cost Price Import");
    await writeFile(wb, "cost_price_import_template.xlsx");
    toast({
      title: t("settings.dataTools.costOverride.templateDownloaded"),
      description: t("settings.dataTools.costOverride.templateDownloadedDescription"),
    });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setErrors([]);
    setPreview([]);
    setIsComplete(false);
    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = utils.sheet_to_json<CostPriceSpreadsheetRow>(worksheet);
      if (rows.length === 0) {
        toast({
          title: t("settings.dataTools.costOverride.emptyFile"),
          description: t("settings.dataTools.costOverride.emptyFileDescription"),
          variant: "destructive",
        });
        return;
      }
      const headerRow = utils.sheet_to_json<string[]>(worksheet, { header: 1 })[0] || [];
      const columns = headerRow.map((header) => String(header || "").trim());
      const requiredColumns = ["barcode", "costPrice"];
      const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
      if (missingColumns.length > 0) {
        toast({
          title: t("settings.dataTools.costOverride.missingColumns"),
          description: t("settings.dataTools.costOverride.missingColumnsDescription"),
          variant: "destructive",
        });
        return;
      }
      const validationErrors: string[] = [];
      const validRows: Array<{ barcode: string; costPrice: number }> = [];
      rows.forEach((row, index) => {
        const rowNumber = index + 2;
        const barcode = String(row.barcode ?? "").trim();
        if (!barcode) {
          validationErrors.push(
            `${t("settings.dataTools.costOverride.row")} ${rowNumber}: ${t("settings.dataTools.costOverride.barcodeRequired")}`
          );
          return;
        }
        const numericCost =
          typeof row.costPrice === "number" ? row.costPrice : Number.parseFloat(String(row.costPrice ?? "0"));
        if (!Number.isFinite(numericCost) || numericCost <= 0) {
          validationErrors.push(
            `${t("settings.dataTools.costOverride.row")} ${rowNumber}: ${t("settings.dataTools.costOverride.costPositive")}`
          );
          return;
        }
        validRows.push({ barcode, costPrice: numericCost });
      });
      setPreview(validRows);
      setErrors(validationErrors);
    } catch {
      toast({
        title: t("settings.dataTools.costOverride.readError"),
        description: t("settings.dataTools.costOverride.readErrorDescription"),
        variant: "destructive",
      });
    }
  };

  const applyImport = async () => {
    if (!locationId) {
      toast({
        title: t("settings.dataTools.costOverride.noLocation"),
        description: t("settings.dataTools.costOverride.noLocationDescription"),
        variant: "destructive",
      });
      return;
    }
    if (errors.length > 0) {
      toast({
        title: t("settings.dataTools.costOverride.cannotImport"),
        description: t("settings.dataTools.costOverride.fixErrors"),
        variant: "destructive",
      });
      return;
    }
    setIsImporting(true);
    try {
      const response = await modeApiRequest("POST", `/api/locations/${locationId}/import-cost-prices`, {
        updates: preview,
      });
      const result = (await response.json()) as CostPriceImportResponse;
      queryClient.invalidateQueries({ queryKey: [`/api/locations/${locationId}/inventory`] });
      setIsComplete(true);
      toast({
        title: t("settings.dataTools.costOverride.importSuccessful"),
        description: `${t("settings.dataTools.costOverride.updatedPrefix")} ${result.updated ?? 0}.`,
      });
    } catch (error: unknown) {
      toast({
        title: t("settings.dataTools.costOverride.importFailed"),
        description: getErrorDetails(error).message || t("settings.dataTools.costOverride.importFailedDescription"),
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };
  return {
    t,
    locationId,
    setLocationId,
    setOpen,
    open,
    file,
    preview,
    errors,
    isImporting,
    isComplete,
    resetDialog,
    downloadTemplate,
    handleFileChange,
    applyImport,
  };
}
