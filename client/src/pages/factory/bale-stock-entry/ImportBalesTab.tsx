import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Upload, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import * as XLSX from "@/lib/excelHelper";
import type { Location } from "@shared/schema";

interface ImportBaleRow {
  itemName: string;
  weight: string;
  barcode: string;
  quantity: number;
  productionDate?: string;
  refNumber?: string;
}

export function ImportBalesTab() {
  const [fileName, setFileName] = useState("");
  const [importRows, setImportRows] = useState<ImportBaleRow[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const activeLocations = (locations || []).filter((l) => l.active);

  const downloadTemplate = async () => {
    const headers = ["ITEM NAME", "WEIGHT", "ITEM BARCODE", "QUANTITY", "PRODUCTION DATE", "REF NUMBER"];
    const sampleRows = [
      ["Cotton Bale B1", 25, "ART001", 1, "2026-03-14", "MYREF-001"],
      ["Cotton Bale B2", 30, "ART002", 1, "2026-03-14", "MYREF-002"],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
    ws["!cols"] = headers.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Bale Import Template");
    await XLSX.writeFile(wb, "bale_import_template.xlsx");
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = await XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(jsonData.length, 10); i++) {
          const row = jsonData[i];
          if (row && row.some((cell) => String(cell).toUpperCase().includes("ITEM NAME"))) {
            headerRowIdx = i;
            break;
          }
        }

        if (headerRowIdx === -1) {
          toast({
            title: "Error",
            description: "Could not find header row with 'ITEM NAME' column",
            variant: "destructive",
          });
          return;
        }

        const headers = jsonData[headerRowIdx].map((h) => String(h).toUpperCase().trim());
        const nameIdx = headers.findIndex((h) => h.includes("ITEM NAME"));
        const weightIdx = headers.findIndex((h) => h.includes("WEIGHT"));
        const barcodeIdx = headers.findIndex((h) => h.includes("BARCODE"));
        const qtyIdx = headers.findIndex((h) => h.includes("QUANTITY"));
        const dateIdx = headers.findIndex((h) => h.includes("PRODUCTION DATE"));
        const refIdx = headers.findIndex(
          (h) => h.includes("REF NUMBER") || h === "REF" || h === "REF CODE" || h === "REFERENCE"
        );

        const parseExcelDate = (val: unknown): string => {
          if (!val && val !== 0) return "";
          const raw = String(val).trim();
          if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
          if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(raw)) {
            const parts = raw.split(/[/-]/);
            return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
          }
          const serial = parseFloat(raw);
          if (!isNaN(serial) && serial > 0) {
            const ms = (serial - 25569) * 86400000;
            const d = new Date(ms);
            if (!isNaN(d.getTime())) {
              const y = d.getUTCFullYear();
              const m = String(d.getUTCMonth() + 1).padStart(2, "0");
              const day = String(d.getUTCDate()).padStart(2, "0");
              return `${y}-${m}-${day}`;
            }
          }
          return raw;
        };

        const rows: ImportBaleRow[] = [];
        for (let i = headerRowIdx + 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          if (!row || !row[nameIdx]) continue;
          const itemName = String(row[nameIdx] || "").trim();
          if (!itemName) continue;
          rows.push({
            itemName,
            weight: String(row[weightIdx] || "").trim(),
            barcode: String(row[barcodeIdx] || "").trim(),
            quantity: parseInt(String(row[qtyIdx] || "1")) || 1,
            productionDate: dateIdx >= 0 ? parseExcelDate(row[dateIdx]) : "",
            refNumber: refIdx >= 0 ? String(row[refIdx] || "").trim() : undefined,
          });
        }

        if (rows.length === 0) {
          toast({ title: "Warning", description: "No data rows found in the Excel file", variant: "destructive" });
          return;
        }

        setImportRows(rows);
        toast({ title: "File Parsed", description: `Found ${rows.length} bale(s) to import` });
      } catch (err) {
        toast({
          title: "Parse Error",
          description: getErrorDetails(err).message || "Failed to parse Excel file",
          variant: "destructive",
        });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      const response = await modeApiRequest("POST", "/api/factory/bales/import", {
        erpLocationId: parseInt(selectedLocationId),
        bales: importRows,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to import bales");
      }
      return await response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Import Complete",
        description: `${result.imported || importRows.length} bale(s) imported successfully`,
      });
      setImportRows([]);
      setFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (error: Error) => {
      toast({ title: "Import Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <p className="text-sm text-muted-foreground mb-1.5">Warehouse Location</p>
          <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
            <SelectTrigger data-testid="select-import-location">
              <SelectValue placeholder="Select Location..." />
            </SelectTrigger>
            <SelectContent>
              {activeLocations?.map((loc) => (
                <SelectItem key={loc.id} value={loc.id.toString()}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1.5">Upload Excel File</p>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv"
              onChange={handleFileUpload}
              className="hidden"
              data-testid="input-import-file"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="button-upload-excel">
              <Upload className="h-4 w-4 mr-2" />
              {fileName || "Choose File..."}
            </Button>
            <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-template">
              <Download className="h-4 w-4 mr-2" />
              Download Template
            </Button>
            {fileName && (
              <Badge variant="secondary" data-testid="badge-file-name">
                <FileSpreadsheet className="h-3 w-3 mr-1" />
                {fileName}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {importRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-lg">Preview ({importRows.length} rows)</CardTitle>
              <Button
                onClick={() => importMutation.mutate()}
                disabled={!selectedLocationId || importMutation.isPending}
                data-testid="button-import-submit"
              >
                {importMutation.isPending ? "Importing..." : `Import ${importRows.length} Bales`}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Ref Number</TableHead>
                    <TableHead className="text-center">Qty</TableHead>
                    <TableHead>Production Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importRows.map((row, idx) => (
                    <TableRow key={idx} data-testid={`row-import-${idx}`}>
                      <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                      <TableCell className="font-medium" data-testid={`text-import-name-${idx}`}>
                        {row.itemName}
                      </TableCell>
                      <TableCell className="text-right" data-testid={`text-import-weight-${idx}`}>
                        {row.weight}
                      </TableCell>
                      <TableCell className="font-mono text-sm" data-testid={`text-import-barcode-${idx}`}>
                        {row.barcode}
                      </TableCell>
                      <TableCell className="font-mono text-sm" data-testid={`text-import-ref-${idx}`}>
                        {row.refNumber || <span className="text-muted-foreground text-xs">auto</span>}
                      </TableCell>
                      <TableCell className="text-center" data-testid={`text-import-qty-${idx}`}>
                        {row.quantity}
                      </TableCell>
                      <TableCell data-testid={`text-import-date-${idx}`}>{row.productionDate}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {importRows.length === 0 && (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-muted-foreground">
              <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium" data-testid="text-import-empty">
                Upload an Excel file to preview bales for import
              </p>
              <p className="text-sm mt-1">
                Expected columns: ITEM NAME, WEIGHT, ITEM BARCODE, QUANTITY, PRODUCTION DATE, REF NUMBER (optional)
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
