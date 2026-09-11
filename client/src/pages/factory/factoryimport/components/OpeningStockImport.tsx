import type { ClientErrorLike } from "@/lib/clientError";
/**
 * OpeningStockImport — extracted sub-component.
 *
 * Extracted from FactoryImport.tsx during the Phase 4 god-file split.
 */
import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import Papa from "papaparse";

import type { OpeningStockRow } from "../types";
import { ImportModeChooser } from "./ImportModeChooser";

export function OpeningStockImport() {
  const [mode, setMode] = useState<"choose" | "csv">("choose");
  const [csvData, setCsvData] = useState<OpeningStockRow[]>([]);
  const [result, setResult] = useState<{
    imported: number;
    errors: string[];
    recalcStats?: { totalAllocatedKg: number };
  } | null>(null);
  const { toast } = useToast();

  const importMutation = useMutation({
    mutationFn: async (items: OpeningStockRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/import/opening-raw-stock", { items });
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Import complete", description: `${data.imported} opening stock records imported` });
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

    const parse = (rows: Record<string, unknown>[]) => {
      const parsed: OpeningStockRow[] = rows
        .map((row) => ({
          supplier: String(row.supplier || row.Supplier || "").trim(),
          kg: String(row.kg || row.Kg || row.KG || "").trim(),
          costPerKg: String(row.costPerKg || row.cost_per_kg || row["Cost Per Kg"] || row["costperkg"] || "").trim(),
          currency: String(row.currency || row.Currency || "USD").trim(),
          fxRateToUsd: String(
            row.fxRateToUsd || row.fx_rate_to_usd || row["FX Rate"] || row["fxratetousd"] || "1"
          ).trim(),
          openingDate: String(
            row.openingDate || row.opening_date || row["Opening Date"] || row["openingdate"] || ""
          ).trim(),
          notes: String(row.notes || row.Notes || "").trim(),
        }))
        .filter((r: OpeningStockRow) => r.supplier);
      setCsvData(parsed);
      setMode("csv");
    };

    if (ext === "csv" || ext === "txt") {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => parse(results.data),
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const XLSX = await import("@/lib/excelHelper");
        const wb = await XLSX.read(evt.target?.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        parse(XLSX.utils.sheet_to_json(ws));
      };
      reader.readAsBinaryString(file);
    }
    e.target.value = "";
  }, []);

  if (result) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4">
            {result.imported > 0 ? (
              <div className="h-14 w-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-green-600 dark:text-green-400" />
              </div>
            ) : (
              <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="h-7 w-7 text-destructive" />
              </div>
            )}
            <div className="text-center">
              <h3 className="text-lg font-semibold">Import Complete</h3>
              <div className="flex items-center gap-3 mt-2 justify-center flex-wrap">
                {result.imported > 0 && <Badge variant="secondary">{result.imported} records created</Badge>}
                {result.errors.length > 0 && <Badge variant="destructive">{result.errors.length} errors</Badge>}
                {result.recalcStats && result.recalcStats.totalAllocatedKg > 0 && (
                  <Badge variant="outline">{result.recalcStats.totalAllocatedKg.toFixed(1)} kg allocated</Badge>
                )}
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="w-full max-w-lg border rounded-md p-3 bg-destructive/5 max-h-48 overflow-auto">
                <p className="text-sm font-medium text-destructive mb-2">Errors:</p>
                <ul className="text-sm space-y-1">
                  {result.errors.map((err, i) => (
                    <li key={i} className="text-muted-foreground flex items-start gap-2">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              onClick={() => {
                setResult(null);
                setMode("choose");
                setCsvData([]);
              }}
              data-testid="button-import-again-opening"
            >
              Import More
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (mode === "choose") {
    return (
      <ImportModeChooser
        title="Import Opening Raw Stock"
        description="Import opening stock by supplier with per-supplier currency and rate. Existing bale consumption will be auto-deducted via FIFO allocation."
        templateType="opening-raw-stock"
        onFileUpload={handleFileUpload}
        onManual={() => {}}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-lg">Preview Opening Raw Stock ({csvData.length} rows)</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setMode("choose");
                setCsvData([]);
              }}
              data-testid="button-back-opening"
            >
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button
              onClick={() => importMutation.mutate(csvData)}
              disabled={importMutation.isPending}
              data-testid="button-confirm-import-opening"
            >
              {importMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Import {csvData.length} Records
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-auto max-h-96">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>KG</TableHead>
                <TableHead>Cost/kg</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>FX Rate</TableHead>
                <TableHead>Opening Date</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {csvData.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{row.supplier}</TableCell>
                  <TableCell className="font-mono">{row.kg}</TableCell>
                  <TableCell className="font-mono">{row.costPerKg}</TableCell>
                  <TableCell>{row.currency}</TableCell>
                  <TableCell className="font-mono">{row.fxRateToUsd}</TableCell>
                  <TableCell>{row.openingDate}</TableCell>
                  <TableCell className="text-muted-foreground max-w-[150px] truncate">{row.notes || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
