// Extracted from ./ImportStockItems.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ExcelJS, read, utils } from "@/lib/excelHelper";
import { downloadBlob } from "@/lib/downloadBlob";
import type { BarcodeRow } from "./useNewItemsTabState";

export function useBarcodesTabState() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<BarcodeRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    notFound: number;
    notFoundCodes: string[];
  } | null>(null);

  const downloadTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Barcodes");
    ws.columns = [
      { header: "Item Code", key: "itemCode", width: 20 },
      { header: "Barcode", key: "barcode", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ itemCode: "ITEM001", barcode: "6291041500213" });
    ws.addRow({ itemCode: "ITEM001", barcode: "6291041500220" });
    ws.addRow({ itemCode: "ITEM002", barcode: "5000112637922" });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    downloadBlob(blob, "barcode_import_template.xlsx");
    toast({ title: "Template Downloaded", description: "Fill in Item Code and Barcode columns, then upload" });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.currentTarget.value = "";
    setFile(f);
    setResult(null);
    try {
      const data = await f.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json(worksheet);

      if (jsonData.length === 0) {
        toast({ title: "Empty File", description: "The file has no data rows.", variant: "destructive" });
        return;
      }

      // Detect columns (case-insensitive)
      const firstRow = jsonData[0];
      const keys = Object.keys(firstRow);
      const itemCodeKey = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === "itemcode") ?? keys[0];
      const barcodeKey = keys.find((k) => k.toLowerCase() === "barcode") ?? keys[1];

      if (!itemCodeKey || !barcodeKey) {
        toast({
          title: "Column Not Found",
          description: `Expected "Item Code" and "Barcode" columns. Download the template for the correct format.`,
          variant: "destructive",
        });
        return;
      }

      const seen = new Set<string>();
      const parsed: BarcodeRow[] = jsonData.map((row) => {
        const itemCode = String(row[itemCodeKey] || "").trim();
        const barcode = String(row[barcodeKey] || "").trim();
        const key = `${itemCode.toLowerCase()}|${barcode.toLowerCase()}`;
        let status: BarcodeRow["status"] = "ok";
        if (!itemCode || !barcode) status = "empty";
        else if (seen.has(key)) status = "duplicate";
        else seen.add(key);
        return { itemCode, barcode, status };
      });

      setRows(parsed);
      const valid = parsed.filter((r) => r.status === "ok").length;
      const dups = parsed.filter((r) => r.status === "duplicate").length;
      const empty = parsed.filter((r) => r.status === "empty").length;
      toast({
        title: "File Loaded",
        description: `${valid} valid rows${dups ? `, ${dups} duplicate${dups > 1 ? "s" : ""}` : ""}${empty ? `, ${empty} empty` : ""}`,
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
    const validRows = rows.filter((r) => r.status === "ok");
    if (validRows.length === 0) {
      toast({ title: "Nothing to Import", description: "No valid rows found.", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    try {
      const response = await apiRequest("POST", "/api/stock-items/import-barcodes", {
        rows: validRows.map((r) => ({ itemCode: r.itemCode, barcode: r.barcode })),
      });
      const res = (await response.json()) as {
        imported: number;
        skipped: number;
        notFound: number;
        notFoundCodes: string[];
      };
      setResult(res);
      toast({
        title: "Import Complete",
        description: `${res.imported} barcodes added${res.skipped ? `, ${res.skipped} skipped (already exist)` : ""}${res.notFound ? `, ${res.notFound} item code(s) not found` : ""}`,
        variant: res.notFound > 0 ? "destructive" : "default",
      });
    } catch (error) {
      toast({ title: "Import Failed", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const validCount = rows.filter((r) => r.status === "ok").length;
  return {
    downloadTemplate,
    file,
    fileInputRef,
    handleFileChange,
    handleImport,
    isProcessing,
    result,
    rows,
    setFile,
    setResult,
    setRows,
    validCount,
  };
}
