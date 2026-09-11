import type { ClientErrorLike } from "@/lib/clientError";
/**
 * SupplierImport — extracted sub-component.
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

import type { SupplierRow } from "../types";
import { EMPTY_SUPPLIER } from "../utils";
import { ImportModeChooser } from "./ImportModeChooser";
import { ManualEntryCard } from "./ManualEntryCard";
import { ImportResult } from "./ImportResult";

export function SupplierImport() {
  const [mode, setMode] = useState<"choose" | "csv" | "manual">("choose");
  const [rows, setRows] = useState<SupplierRow[]>([{ ...EMPTY_SUPPLIER }]);
  const [csvData, setCsvData] = useState<SupplierRow[]>([]);
  const [result, setResult] = useState<{ imported: number; updated: number; errors: string[] } | null>(null);
  const { toast } = useToast();

  const importMutation = useMutation({
    mutationFn: async (suppliers: SupplierRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/import/suppliers", { suppliers });
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Import complete", description: `${data.imported} created, ${data.updated} updated` });
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
          const parsed: SupplierRow[] = results.data
            .map((row) => ({
              name: (row.name || "").trim(),
              openingBalance: (row.openingBalance || row.opening_balance || "0").trim(),
              contactPerson: (row.contactPerson || row.contact_person || "").trim(),
              phone: (row.phone || "").trim(),
              email: (row.email || "").trim(),
            }))
            .filter((r: SupplierRow) => r.name);
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
        const parsed: SupplierRow[] = data
          .map((row) => ({
            name: String(row.name || row.Name || "").trim(),
            openingBalance: String(row.openingBalance || row.opening_balance || row["Opening Balance"] || "0").trim(),
            contactPerson: String(row.contactPerson || row.contact_person || row["Contact Person"] || "").trim(),
            phone: String(row.phone || row.Phone || "").trim(),
            email: String(row.email || row.Email || "").trim(),
          }))
          .filter((r) => r.name);
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
          setRows([{ ...EMPTY_SUPPLIER }]);
        }}
      />
    );
  }

  if (mode === "choose") {
    return (
      <ImportModeChooser
        title="Import Supplier Balances"
        description="Import opening balances for factory suppliers. Existing suppliers will be updated, new ones will be created."
        templateType="suppliers"
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
            <CardTitle className="text-lg">Preview Supplier Data ({csvData.length} rows)</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setMode("choose");
                  setCsvData([]);
                }}
                data-testid="button-back-csv"
              >
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
              <Button
                onClick={() => importMutation.mutate(csvData)}
                disabled={importMutation.isPending}
                data-testid="button-confirm-import-suppliers"
              >
                {importMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Import {csvData.length} Suppliers
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-auto max-h-96">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Opening Balance</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {csvData.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>{row.openingBalance}</TableCell>
                    <TableCell>{row.contactPerson}</TableCell>
                    <TableCell>{row.phone}</TableCell>
                    <TableCell>{row.email}</TableCell>
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
      title="Add Supplier Balances"
      columns={["Name *", "Opening Balance", "Contact", "Phone", "Email"]}
      rows={rows}
      onAdd={() => setRows([...rows, { ...EMPTY_SUPPLIER }])}
      onRemove={(i) => setRows(rows.filter((_, idx) => idx !== i))}
      onChange={(i, field, value) => {
        const updated = [...rows];
        (updated[i] as unknown as SupplierRow & { [key: string]: string })[field] = value;
        setRows(updated);
      }}
      onSubmit={() => importMutation.mutate(rows.filter((r) => r.name))}
      isPending={importMutation.isPending}
      onBack={() => setMode("choose")}
      renderRow={(row, i, onChange) => (
        <>
          <TableCell>
            <Input
              value={row.name}
              onChange={(e) => onChange(i, "name", e.target.value)}
              placeholder="Supplier name"
              data-testid={`input-supplier-name-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.openingBalance}
              onChange={(e) => onChange(i, "openingBalance", e.target.value)}
              placeholder="0"
              type="number"
              step="0.01"
              data-testid={`input-supplier-balance-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.contactPerson}
              onChange={(e) => onChange(i, "contactPerson", e.target.value)}
              placeholder="Contact person"
              data-testid={`input-supplier-contact-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.phone}
              onChange={(e) => onChange(i, "phone", e.target.value)}
              placeholder="Phone"
              data-testid={`input-supplier-phone-${i}`}
            />
          </TableCell>
          <TableCell>
            <Input
              value={row.email}
              onChange={(e) => onChange(i, "email", e.target.value)}
              placeholder="Email"
              data-testid={`input-supplier-email-${i}`}
            />
          </TableCell>
        </>
      )}
    />
  );
}
