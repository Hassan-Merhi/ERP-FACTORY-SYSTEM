// Extracted from ./ImportStockItems.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { useCompany } from "@/contexts/CompanyContext";

// ─── New Items tab types ──────────────────────────────────────────────────────

interface ImportRow {
  code: string;
  name: string;
  unit?: string;
  stockGroupCode?: string;
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

// ─── Barcodes tab types ───────────────────────────────────────────────────────

export interface BarcodeRow {
  itemCode: string;
  barcode: string;
  status: "ok" | "duplicate" | "empty";
}

export function useNewItemsTabState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportRow[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importComplete, setImportComplete] = useState(false);

  const downloadTemplate = async () => {
    const template = [
      { code: "ITEM001", name: "Cotton Bale Grade A", unit: "Bale", stockGroupCode: "GRP001" },
      { code: "ITEM002", name: "Cotton Bale Grade B", unit: "Bale", stockGroupCode: "GRP001" },
    ];
    const ws = utils.json_to_sheet(template);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Stock Items");
    await writeFile(wb, "stock_items_template.xlsx");
    toast({ title: "Template Downloaded", description: "Use this template to prepare your stock items data" });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    e.currentTarget.value = "";
    setFile(selectedFile);
    setErrors([]);
    setPreviewData([]);
    setImportComplete(false);
    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json(worksheet);
      if (jsonData.length === 0) {
        toast({ title: "Empty File", description: "The Excel file is empty.", variant: "destructive" });
        return;
      }
      const headerRow = utils.sheet_to_json<string[]>(worksheet, { header: 1 })[0] || [];
      const columns = headerRow.map((h) => String(h || "").trim());
      const missingCols = ["code", "name"].filter((c) => !columns.includes(c));
      if (missingCols.length > 0) {
        toast({
          title: "Missing Required Columns",
          description: `Expected: code, name. Found: ${columns.slice(0, 5).join(", ")}. Download the template.`,
          variant: "destructive",
        });
        return;
      }
      const validationErrors: ValidationError[] = [];
      const rows: ImportRow[] = [];
      jsonData.forEach((row, index) => {
        const rowNumber = index + 2;
        if (!row.code || String(row.code).trim() === "")
          validationErrors.push({ row: rowNumber, field: "code", message: "Code is required" });
        if (!row.name || String(row.name).trim() === "")
          validationErrors.push({ row: rowNumber, field: "name", message: "Name is required" });
        rows.push({
          code: String(row.code || "").trim(),
          name: String(row.name || "").trim(),
          unit: row.unit ? String(row.unit).trim() : "Bale",
          stockGroupCode: row.stockGroupCode ? String(row.stockGroupCode).trim() : undefined,
        });
      });
      setPreviewData(rows);
      setErrors(validationErrors);
      if (validationErrors.length === 0)
        toast({ title: "File Validated", description: `${rows.length} stock items ready to import` });
      else
        toast({
          title: "Validation Errors Found",
          description: `${validationErrors.length} errors found. Please fix them.`,
          variant: "destructive",
        });
    } catch {
      toast({
        title: "Error Reading File",
        description: "Please ensure the file is a valid Excel file (.xlsx)",
        variant: "destructive",
      });
    }
  };

  const handleImport = async () => {
    if (!selectedCompany) {
      toast({ title: "No Company Selected", variant: "destructive" });
      return;
    }
    if (errors.length > 0) {
      toast({ title: "Cannot Import", description: "Fix validation errors first", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    try {
      const stockGroupsData: { id: number; code: string }[] = await fetch("/api/stock-groups", {
        credentials: "include",
      }).then((r) => r.json());
      const stockGroupMap = new Map(stockGroupsData.map((sg) => [sg.code, sg.id]));
      const itemsToImport = previewData.map((row) => {
        const item: {
          companyId: number;
          code: string;
          name: string;
          uom: string;
          active: boolean;
          stockGroupId?: number;
        } = {
          companyId: selectedCompany.id,
          code: row.code,
          name: row.name,
          uom: row.unit || "Bale",
          active: true,
        };
        if (row.stockGroupCode && stockGroupMap.has(row.stockGroupCode))
          item.stockGroupId = stockGroupMap.get(row.stockGroupCode);
        return item;
      });
      await apiRequest("POST", "/api/stock-items/import", { items: itemsToImport });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setImportComplete(true);
      toast({ title: "Import Successful", description: `Successfully imported ${itemsToImport.length} stock items` });
    } catch (error) {
      toast({
        title: "Import Failed",
        description: getErrorDetails(error).message || "Failed to import stock items",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };
  return {
    downloadTemplate,
    errors,
    file,
    handleFileChange,
    handleImport,
    importComplete,
    isProcessing,
    previewData,
    setErrors,
    setFile,
    setImportComplete,
    setPreviewData,
  };
}
