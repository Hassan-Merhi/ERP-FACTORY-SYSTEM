// Extracted from ./BaleImport.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FactoryBaleProduct } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import Papa from "papaparse";
import type { BaleRow } from "../types";
import { EMPTY_BALE } from "../utils";

export function useBaleImportState() {
  const [mode, setMode] = useState<"choose" | "csv" | "manual">("choose");
  const [rows, setRows] = useState<BaleRow[]>([{ ...EMPTY_BALE }]);
  const [csvData, setCsvData] = useState<BaleRow[]>([]);
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("import.xlsx");
  const { toast } = useToast();

  const { data: baleProducts } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });

  const productByArticleCode = new Map<string, FactoryBaleProduct>();
  if (baleProducts) {
    for (const p of baleProducts) {
      if (p.articleCode) productByArticleCode.set(p.articleCode.toLowerCase(), p);
    }
  }

  const importMutation = useMutation({
    mutationFn: async (bales: BaleRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/import/bales", { bales, fileName: uploadedFileName });
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Import complete", description: `${data.imported} bales imported` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    setUploadedFileName(file.name);

    if (ext === "csv" || ext === "txt") {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const parsed: BaleRow[] = results.data
            .map((row) => ({
              baleCode: (row.baleCode || row.bale_code || "").trim(),
              articleCode: (row.articleCode || row.article_code || "").trim(),
              productName: (row.productName || row.product_name || "").trim(),
              category: (row.category || "").trim(),
              grade: (row.grade || "").trim(),
              weightKg: (row.weightKg || row.weight_kg || "").trim(),
              costPerKg: (row.costPerKg || row.cost_per_kg || "0").trim(),
              status: (row.status || "FINALIZED").trim().toUpperCase(),
            }))
            .filter((r: BaleRow) => r.baleCode && r.weightKg);
          setCsvData(parsed);
          setMode("csv");
        },
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const XLSX = await import("@/lib/excelHelper");
        const wb = await XLSX.read(evt.target?.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);
        const parsed: BaleRow[] = data
          .map((row) => ({
            baleCode: String(row.baleCode || row.bale_code || row["Bale Code"] || "").trim(),
            articleCode: String(row.articleCode || row.article_code || row["Article Code"] || "").trim(),
            productName: String(row.productName || row.product_name || row["Product Name"] || "").trim(),
            category: String(row.category || row.Category || "").trim(),
            grade: String(row.grade || row.Grade || "").trim(),
            weightKg: String(row.weightKg || row.weight_kg || row["Weight Kg"] || "").trim(),
            costPerKg: String(row.costPerKg || row.cost_per_kg || row["Cost Per Kg"] || "0").trim(),
            status: String(row.status || row.Status || "FINALIZED")
              .trim()
              .toUpperCase(),
          }))
          .filter((r) => r.baleCode && r.weightKg);
        setCsvData(parsed);
        setMode("csv");
      };
      reader.readAsBinaryString(file);
    }
    e.target.value = "";
  }, []);
  return {
    setMode,
    mode,
    setRows,
    rows,
    setCsvData,
    csvData,
    result,
    setResult,
    productByArticleCode,
    importMutation,
    handleFileUpload,
  };
}
