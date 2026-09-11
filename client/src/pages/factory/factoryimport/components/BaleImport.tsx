import type { ClientErrorLike } from "@/lib/clientError";
/**
 * BaleImport — extracted sub-component.
 *
 * Extracted from FactoryImport.tsx during the Phase 4 god-file split.
 */
import { useState, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FactoryBaleProduct } from "@shared/schema";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import Papa from "papaparse";

import type { BaleRow } from "../types";
import { EMPTY_BALE } from "../utils";
import { ImportModeChooser } from "./ImportModeChooser";
import { ManualEntryCard } from "./ManualEntryCard";
import { ImportResult } from "./ImportResult";

export function BaleImport() {
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

  if (result) {
    return (
      <ImportResult
        result={result}
        onReset={() => {
          setResult(null);
          setMode("choose");
          setCsvData([]);
          setRows([{ ...EMPTY_BALE }]);
        }}
      />
    );
  }

  if (mode === "choose") {
    return (
      <ImportModeChooser
        title="Import Bales Inventory"
        description="Import existing bales into the system. Reference numbers will be generated automatically."
        templateType="bales"
        onFileUpload={handleFileUpload}
        onManual={() => setMode("manual")}
      />
    );
  }

  if (mode === "csv") {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-lg">Preview Bale Data ({csvData.length} rows)</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setMode("choose");
                  setCsvData([]);
                }}
                data-testid="button-back-csv-bales"
              >
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
              <Button
                onClick={() => importMutation.mutate(csvData)}
                disabled={importMutation.isPending}
                data-testid="button-confirm-import-bales"
              >
                {importMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Import {csvData.length} Bales
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-auto max-h-96">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Bale Code</TableHead>
                  <TableHead>Article Code</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Weight (kg)</TableHead>
                  <TableHead>Cost/Kg</TableHead>
                  <TableHead className="text-right">Prod. Price</TableHead>
                  <TableHead className="text-right">Sell Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {csvData.map((row, i) => {
                  const matched = row.articleCode ? productByArticleCode.get(row.articleCode.toLowerCase()) : undefined;
                  return (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{row.baleCode}</TableCell>
                      <TableCell>{row.articleCode}</TableCell>
                      <TableCell>{row.productName || matched?.name || "-"}</TableCell>
                      <TableCell>{row.category}</TableCell>
                      <TableCell>{row.grade}</TableCell>
                      <TableCell>{row.weightKg}</TableCell>
                      <TableCell>{row.costPerKg}</TableCell>
                      <TableCell className="text-right font-mono">
                        {matched?.productionPrice && parseFloat(matched.productionPrice) > 0 ? (
                          parseFloat(matched.productionPrice).toLocaleString()
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {matched?.sellingPrice && parseFloat(matched.sellingPrice) > 0 ? (
                          parseFloat(matched.sellingPrice).toLocaleString()
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.status}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <ManualEntryCard
      title="Add Bales"
      columns={["Bale Code *", "Article Code", "Product", "Category", "Grade", "Weight (kg) *", "Cost/Kg", "Status"]}
      rows={rows}
      onAdd={() => setRows([...rows, { ...EMPTY_BALE }])}
      onRemove={(i) => setRows(rows.filter((_, idx) => idx !== i))}
      onChange={(i, field, value) => {
        const updated = [...rows];
        (updated[i] as unknown as BaleRow & { [key: string]: string })[field] = value;
        setRows(updated);
      }}
      onSubmit={() => importMutation.mutate(rows.filter((r) => r.baleCode && r.weightKg))}
      isPending={importMutation.isPending}
      onBack={() => setMode("choose")}
      renderRow={(row, i, onChange) => (
        <>
          <TableCell>
            <Input
              value={row.baleCode}
              onChange={(e) => onChange(i, "baleCode", e.target.value)}
              placeholder="Bale code"
              data-testid={`input-bale-code-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.articleCode}
              onChange={(e) => onChange(i, "articleCode", e.target.value)}
              placeholder="Article code"
              data-testid={`input-bale-article-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.productName}
              onChange={(e) => onChange(i, "productName", e.target.value)}
              placeholder="Product name"
              data-testid={`input-bale-product-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.category}
              onChange={(e) => onChange(i, "category", e.target.value)}
              placeholder="Category"
              data-testid={`input-bale-category-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.grade}
              onChange={(e) => onChange(i, "grade", e.target.value)}
              placeholder="Grade"
              data-testid={`input-bale-grade-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.weightKg}
              onChange={(e) => onChange(i, "weightKg", e.target.value)}
              placeholder="0"
              type="number"
              step="0.001"
              data-testid={`input-bale-weight-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.costPerKg}
              onChange={(e) => onChange(i, "costPerKg", e.target.value)}
              placeholder="0"
              type="number"
              step="0.01"
              data-testid={`input-bale-costperkg-${i}`}
            />
          </TableCell>
          <TableCell>
            <Select value={row.status} onValueChange={(v) => onChange(i, "status", v)}>
              <SelectTrigger data-testid={`select-bale-status-${i}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FINALIZED">Finalized</SelectItem>
                <SelectItem value="PENDING_PRESSING">Pending</SelectItem>
              </SelectContent>
            </Select>
          </TableCell>
        </>
      )}
    />
  );
}
