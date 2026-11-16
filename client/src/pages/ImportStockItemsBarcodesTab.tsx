// Extracted from ./ImportStockItems.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, Download, Upload } from "lucide-react";
import { ExcelJS, read, utils } from "@/lib/excelHelper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

// ─── Barcodes tab types ───────────────────────────────────────────────────────

interface BarcodeRow {
  itemCode: string;
  barcode: string;
  status: "ok" | "duplicate" | "empty";
}

// ═════════════════════════════════════════════════════════════════════════════
// Barcodes tab
// ═════════════════════════════════════════════════════════════════════════════

export function BarcodesTab() {
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "barcode_import_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Upload Barcode File</CardTitle>
          <CardDescription>
            Match barcodes to existing items using their Item Code. Each row assigns one barcode to one item — you can
            have multiple rows for the same item.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-1">
            <p className="font-medium">Required columns</p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded-sm">Item Code</span> — must match the primary code
              of an existing item exactly
            </p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded-sm">Barcode</span> — the barcode/alias to register
              (e.g. EAN-13, UPC)
            </p>
            <p className="text-muted-foreground">
              One item can have many barcodes — just add multiple rows with the same Item Code.
            </p>
          </div>

          <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-barcode-template">
            <Download className="h-4 w-4 mr-2" />
            Download Template
          </Button>

          <div className="space-y-2">
            <Label htmlFor="barcode-file-upload">Select Excel File</Label>
            <Input
              id="barcode-file-upload"
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              disabled={isProcessing}
              data-testid="input-barcode-file-upload"
            />
            {file && <p className="text-sm text-muted-foreground">Selected: {file.name}</p>}
          </div>

          {result && (
            <Alert variant={result.notFound > 0 ? "destructive" : "default"}>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="space-y-1">
                <p>
                  <strong>{result.imported}</strong> barcodes imported successfully
                </p>
                {result.skipped > 0 && (
                  <p className="text-muted-foreground">{result.skipped} skipped (already assigned)</p>
                )}
                {result.notFound > 0 && (
                  <div>
                    <p>{result.notFound} item code(s) not found:</p>
                    <p className="font-mono text-xs mt-1">
                      {result.notFoundCodes.slice(0, 10).join(", ")}
                      {result.notFoundCodes.length > 10 ? ` +${result.notFoundCodes.length - 10} more` : ""}
                    </p>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              Preview
              <Badge variant="secondary">{validCount} valid</Badge>
              {rows.filter((r) => r.status === "duplicate").length > 0 && (
                <Badge variant="outline">{rows.filter((r) => r.status === "duplicate").length} duplicate</Badge>
              )}
              {rows.filter((r) => r.status === "empty").length > 0 && (
                <Badge variant="outline">{rows.filter((r) => r.status === "empty").length} empty</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Only "valid" rows will be imported. Duplicates and empty rows are skipped.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-auto max-h-96">
              <table className="w-full">
                <thead className="sticky top-0 z-30 bg-muted">
                  <tr className="border-b">
                    <th className="text-left p-2 text-sm font-medium w-8">#</th>
                    <th className="text-left p-2 text-sm font-medium">Item Code</th>
                    <th className="text-left p-2 text-sm font-medium">Barcode</th>
                    <th className="text-left p-2 text-sm font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((row, i) => (
                    <tr
                      key={i}
                      className={`border-b last:border-b-0 ${row.status !== "ok" ? "opacity-50" : ""}`}
                      data-testid={`row-barcode-preview-${i}`}
                    >
                      <td className="p-2 text-sm text-muted-foreground">{i + 2}</td>
                      <td className="p-2 text-sm font-mono">
                        {row.itemCode || <span className="text-muted-foreground italic">empty</span>}
                      </td>
                      <td className="p-2 text-sm font-mono">
                        {row.barcode || <span className="text-muted-foreground italic">empty</span>}
                      </td>
                      <td className="p-2">
                        {row.status === "ok" && <Badge className="bg-green-600 text-white border-0">Valid</Badge>}
                        {row.status === "duplicate" && <Badge variant="outline">Duplicate</Badge>}
                        {row.status === "empty" && <Badge variant="outline">Empty</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 200 && (
                <div className="p-2 text-center text-sm text-muted-foreground border-t">
                  Showing first 200 of {rows.length} rows
                </div>
              )}
            </div>

            <div className="flex gap-4 mt-4">
              <Button
                onClick={handleImport}
                disabled={isProcessing || validCount === 0 || !!result}
                data-testid="button-import-barcodes"
              >
                <Upload className="h-4 w-4 mr-2" />
                {isProcessing ? "Importing..." : `Import ${validCount} Barcode${validCount !== 1 ? "s" : ""}`}
              </Button>
              {result && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setFile(null);
                    setRows([]);
                    setResult(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  data-testid="button-import-barcodes-reset"
                >
                  Import Another File
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
