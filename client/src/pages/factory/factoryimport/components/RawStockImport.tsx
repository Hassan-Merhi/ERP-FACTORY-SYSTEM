import type { ClientErrorLike } from "@/lib/clientError";
/**
 * RawStockImport — extracted sub-component.
 *
 * Extracted from FactoryImport.tsx during the Phase 4 god-file split.
 */
import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import Papa from "papaparse";

import type { RawStockRow } from "../types";
import { EMPTY_RAW_STOCK } from "../utils";
import { ImportModeChooser } from "./ImportModeChooser";
import { ManualEntryCard } from "./ManualEntryCard";
import { ImportResult } from "./ImportResult";

export function RawStockImport() {
  const [mode, setMode] = useState<"choose" | "csv" | "manual">("choose");
  const [rows, setRows] = useState<RawStockRow[]>([{ ...EMPTY_RAW_STOCK }]);
  const [csvData, setCsvData] = useState<RawStockRow[]>([]);
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const { toast } = useToast();

  const importMutation = useMutation({
    mutationFn: async (items: RawStockRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/import/raw-stock", { items });
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Import complete", description: `${data.imported} raw stock records imported` });
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

    if (ext === "csv" || ext === "txt") {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const parsed: RawStockRow[] = results.data
            .map((row) => ({
              containerNumber: (row.containerNumber || row.container_number || "").trim(),
              supplierName: (row.supplierName || row.supplier_name || "").trim(),
              receivedKg: (row.receivedKg || row.received_kg || "").trim(),
              usedKg: (row.usedKg || row.used_kg || "0").trim(),
              costPerKg: (row.costPerKg || row.cost_per_kg || "").trim(),
              arrivalDate: (row.arrivalDate || row.arrival_date || "").trim(),
            }))
            .filter((r: RawStockRow) => r.containerNumber && r.receivedKg);
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
        const parsed: RawStockRow[] = data
          .map((row) => ({
            containerNumber: String(
              row.containerNumber || row.container_number || row["Container Number"] || ""
            ).trim(),
            supplierName: String(row.supplierName || row.supplier_name || row["Supplier Name"] || "").trim(),
            receivedKg: String(row.receivedKg || row.received_kg || row["Received Kg"] || "").trim(),
            usedKg: String(row.usedKg || row.used_kg || row["Used Kg"] || "0").trim(),
            costPerKg: String(row.costPerKg || row.cost_per_kg || row["Cost Per Kg"] || "").trim(),
            arrivalDate: String(row.arrivalDate || row.arrival_date || row["Arrival Date"] || "").trim(),
          }))
          .filter((r) => r.containerNumber && r.receivedKg);
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
          setRows([{ ...EMPTY_RAW_STOCK }]);
        }}
      />
    );
  }

  if (mode === "choose") {
    return (
      <ImportModeChooser
        title="Import Raw Stock Balances"
        description="Import opening raw material inventory. Containers will be created automatically if they don't exist."
        templateType="raw-stock"
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
            <CardTitle className="text-lg">Preview Raw Stock Data ({csvData.length} rows)</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setMode("choose");
                  setCsvData([]);
                }}
                data-testid="button-back-csv-rawstock"
              >
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
              <Button
                onClick={() => importMutation.mutate(csvData)}
                disabled={importMutation.isPending}
                data-testid="button-confirm-import-rawstock"
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
                  <TableHead>Container #</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Received Kg</TableHead>
                  <TableHead>Used Kg</TableHead>
                  <TableHead>Cost/Kg</TableHead>
                  <TableHead>Arrival Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {csvData.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{row.containerNumber}</TableCell>
                    <TableCell>{row.supplierName}</TableCell>
                    <TableCell>{row.receivedKg}</TableCell>
                    <TableCell>{row.usedKg}</TableCell>
                    <TableCell>{row.costPerKg}</TableCell>
                    <TableCell>{row.arrivalDate}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <ManualEntryCard
      title="Add Raw Stock Records"
      columns={["Container # *", "Supplier", "Received Kg *", "Used Kg", "Cost/Kg *", "Arrival Date"]}
      rows={rows}
      onAdd={() => setRows([...rows, { ...EMPTY_RAW_STOCK }])}
      onRemove={(i) => setRows(rows.filter((_, idx) => idx !== i))}
      onChange={(i, field, value) => {
        const updated = [...rows];
        (updated[i] as unknown as RawStockRow & { [key: string]: string })[field] = value;
        setRows(updated);
      }}
      onSubmit={() => importMutation.mutate(rows.filter((r) => r.containerNumber && r.receivedKg))}
      isPending={importMutation.isPending}
      onBack={() => setMode("choose")}
      renderRow={(row, i, onChange) => (
        <>
          <TableCell>
            <Input
              value={row.containerNumber}
              onChange={(e) => onChange(i, "containerNumber", e.target.value)}
              placeholder="Container number"
              data-testid={`input-rawstock-container-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.supplierName}
              onChange={(e) => onChange(i, "supplierName", e.target.value)}
              placeholder="Supplier name"
              data-testid={`input-rawstock-supplier-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.receivedKg}
              onChange={(e) => onChange(i, "receivedKg", e.target.value)}
              placeholder="0"
              type="number"
              step="0.001"
              data-testid={`input-rawstock-received-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.usedKg}
              onChange={(e) => onChange(i, "usedKg", e.target.value)}
              placeholder="0"
              type="number"
              step="0.001"
              data-testid={`input-rawstock-used-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.costPerKg}
              onChange={(e) => onChange(i, "costPerKg", e.target.value)}
              placeholder="0"
              type="number"
              step="0.0001"
              data-testid={`input-rawstock-cost-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.arrivalDate}
              onChange={(e) => onChange(i, "arrivalDate", e.target.value)}
              placeholder="YYYY-MM-DD"
              type="date"
              data-testid={`input-rawstock-date-${i}`}
            />
          </TableCell>
        </>
      )}
    />
  );
}
