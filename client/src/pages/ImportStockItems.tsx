import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Upload, Download, CheckCircle2, AlertCircle, Barcode, Package, Tag } from "lucide-react";
import { utils, writeFile, read, ExcelJS } from "@/lib/excelHelper";
import { useCompany } from "@/contexts/CompanyContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";

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

interface BarcodeRow {
  itemCode: string;
  barcode: string;
  status: "ok" | "duplicate" | "empty";
}

// ═════════════════════════════════════════════════════════════════════════════
// New Items tab
// ═════════════════════════════════════════════════════════════════════════════

function NewItemsTab() {
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Upload Excel File</CardTitle>
          <CardDescription>Download the template, fill in your stock items data, and upload it here</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-template">
            <Download className="h-4 w-4 mr-2" />
            Download Template
          </Button>
          <div className="space-y-2">
            <Label htmlFor="file-upload">Select Excel File</Label>
            <Input
              id="file-upload"
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              disabled={isProcessing || importComplete}
              data-testid="input-file-upload"
            />
            {file && <p className="text-sm text-muted-foreground">Selected: {file.name}</p>}
          </div>
          {errors.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-semibold mb-2">
                  {errors.length} validation error{errors.length > 1 ? "s" : ""} found:
                </div>
                <ul className="list-disc list-inside space-y-1">
                  {errors.slice(0, 10).map((e, i) => (
                    <li key={i} className="text-sm">
                      Row {e.row}, {e.field}: {e.message}
                    </li>
                  ))}
                  {errors.length > 10 && <li className="text-sm">... and {errors.length - 10} more</li>}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {importComplete && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                Import completed successfully! {previewData.length} stock items created.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {previewData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Preview ({previewData.length} items)</CardTitle>
            <CardDescription>Review the data before importing</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-auto max-h-96">
              <table className="w-full">
                <thead className="sticky top-0 z-30 bg-muted/50">
                  <tr className="border-b">
                    <th className="text-left p-2 text-sm font-medium">Code</th>
                    <th className="text-left p-2 text-sm font-medium">Name</th>
                    <th className="text-left p-2 text-sm font-medium">Unit</th>
                    <th className="text-left p-2 text-sm font-medium">Stock Group</th>
                  </tr>
                </thead>
                <tbody>
                  {previewData.slice(0, 50).map((item, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="p-2 text-sm">{item.code}</td>
                      <td className="p-2 text-sm">{item.name}</td>
                      <td className="p-2 text-sm">{item.unit}</td>
                      <td className="p-2 text-sm text-muted-foreground">{item.stockGroupCode || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewData.length > 50 && (
                <div className="p-2 text-center text-sm text-muted-foreground border-t">
                  ... and {previewData.length - 50} more items
                </div>
              )}
            </div>
            <div className="flex gap-4 mt-4">
              <Button
                onClick={handleImport}
                disabled={isProcessing || errors.length > 0 || importComplete}
                data-testid="button-import"
              >
                <Upload className="h-4 w-4 mr-2" />
                {isProcessing ? "Importing..." : "Import Stock Items"}
              </Button>
              {importComplete && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setFile(null);
                    setPreviewData([]);
                    setErrors([]);
                    setImportComplete(false);
                  }}
                  data-testid="button-import-another"
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

// ═════════════════════════════════════════════════════════════════════════════
// Barcodes tab
// ═════════════════════════════════════════════════════════════════════════════

function BarcodesTab() {
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
              <span className="font-mono bg-background px-1 rounded">Item Code</span> — must match the primary code of
              an existing item exactly
            </p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded">Barcode</span> — the barcode/alias to register
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
                <thead className="sticky top-0 z-30 bg-muted/50">
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

// ═════════════════════════════════════════════════════════════════════════════
// Update Categories tab
// ═════════════════════════════════════════════════════════════════════════════

interface CategoryRow {
  itemCode: string;
  categoryName: string;
  status: "ok" | "duplicate" | "empty";
}

function UpdateCategoriesTab() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{
    updated: number;
    notFound: number;
    categoryNotFound: number;
    notFoundCodes: string[];
    categoryNotFoundNames: string[];
  } | null>(null);

  const downloadTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Categories");
    ws.columns = [
      { header: "Item Code", key: "itemCode", width: 20 },
      { header: "Category Name", key: "categoryName", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ itemCode: "ITEM001", categoryName: "AJ" });
    ws.addRow({ itemCode: "ITEM002", categoryName: "AJ" });
    ws.addRow({ itemCode: "ITEM003", categoryName: "BL" });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "update_categories_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Template Downloaded", description: "Fill in Item Code and Category Name, then upload" });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setResult(null);
    try {
      const data = await f.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json(worksheet);
      if (jsonData.length === 0) {
        toast({ title: "Empty File", variant: "destructive" });
        return;
      }

      const keys = Object.keys(jsonData[0]);
      const itemCodeKey = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === "itemcode") ?? keys[0];
      const catKey = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === "categoryname") ?? keys[1];

      const seen = new Set<string>();
      const parsed: CategoryRow[] = jsonData.map((row) => {
        const itemCode = String(row[itemCodeKey] || "").trim();
        const categoryName = String(row[catKey] || "").trim();
        const key = itemCode.toLowerCase();
        let status: CategoryRow["status"] = "ok";
        if (!itemCode || !categoryName) status = "empty";
        else if (seen.has(key)) status = "duplicate";
        else seen.add(key);
        return { itemCode, categoryName, status };
      });

      setRows(parsed);
      const valid = parsed.filter((r) => r.status === "ok").length;
      toast({ title: "File Loaded", description: `${valid} valid rows ready to update` });
    } catch {
      toast({ title: "Error Reading File", description: "Please upload a valid .xlsx file", variant: "destructive" });
    }
  };

  const handleImport = async () => {
    const valid = rows.filter((r) => r.status === "ok");
    if (valid.length === 0) {
      toast({ title: "Nothing to import", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    try {
      const res = await apiRequest("POST", "/api/stock-items/update-categories", {
        rows: valid.map((r) => ({ itemCode: r.itemCode, categoryName: r.categoryName })),
      });
      const data = await res.json();
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({
        title: "Update Complete",
        description: `${data.updated} items updated${data.notFound ? `, ${data.notFound} item codes not found` : ""}${data.categoryNotFound ? `, ${data.categoryNotFound} category names not found` : ""}`,
        variant: data.notFound > 0 || data.categoryNotFound > 0 ? "destructive" : "default",
      });
    } catch (err) {
      toast({ title: "Update Failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const validCount = rows.filter((r) => r.status === "ok").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Update Item Categories</CardTitle>
          <CardDescription>
            Upload an Excel file to bulk-assign categories (stock groups) to existing stock items by their item code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-1">
            <p className="font-medium">Required columns</p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded">Item Code</span> — must match an existing item's
              code exactly
            </p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded">Category Name</span> — must match an existing stock
              group name exactly
            </p>
            <p className="text-muted-foreground">
              Each row updates one item. Duplicate item codes are skipped (first row wins).
            </p>
          </div>

          <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-categories-template">
            <Download className="h-4 w-4 mr-2" /> Download Template
          </Button>

          <div className="space-y-2">
            <Label htmlFor="cat-file-upload">Select Excel File</Label>
            <Input
              id="cat-file-upload"
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              disabled={isProcessing}
              data-testid="input-categories-file-upload"
            />
          </div>

          {result && (
            <Alert variant={result.notFound > 0 || result.categoryNotFound > 0 ? "destructive" : "default"}>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="space-y-1">
                <p>
                  <strong>{result.updated}</strong> items updated successfully
                </p>
                {result.notFound > 0 && (
                  <div>
                    <p className="text-muted-foreground">
                      {result.notFound} item code(s) not found:{" "}
                      <span className="font-mono text-xs">
                        {result.notFoundCodes.slice(0, 8).join(", ")}
                        {result.notFoundCodes.length > 8 ? ` +${result.notFoundCodes.length - 8} more` : ""}
                      </span>
                    </p>
                  </div>
                )}
                {result.categoryNotFound > 0 && (
                  <div>
                    <p className="text-muted-foreground">
                      {result.categoryNotFound} category name(s) not found:{" "}
                      <span className="font-mono text-xs">
                        {result.categoryNotFoundNames.slice(0, 8).join(", ")}
                        {result.categoryNotFoundNames.length > 8
                          ? ` +${result.categoryNotFoundNames.length - 8} more`
                          : ""}
                      </span>
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
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-auto max-h-80">
              <table className="w-full">
                <thead className="sticky top-0 z-30 bg-muted/50">
                  <tr className="border-b">
                    <th className="text-left p-2 text-sm font-medium w-8">#</th>
                    <th className="text-left p-2 text-sm font-medium">Item Code</th>
                    <th className="text-left p-2 text-sm font-medium">Category</th>
                    <th className="text-left p-2 text-sm font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((row, i) => (
                    <tr key={i} className={`border-b last:border-b-0 ${row.status !== "ok" ? "opacity-50" : ""}`}>
                      <td className="p-2 text-sm text-muted-foreground">{i + 2}</td>
                      <td className="p-2 text-sm font-mono">
                        {row.itemCode || <span className="text-muted-foreground italic">empty</span>}
                      </td>
                      <td className="p-2 text-sm">
                        {row.categoryName || <span className="text-muted-foreground italic">empty</span>}
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
                data-testid="button-update-categories"
              >
                <Upload className="h-4 w-4 mr-2" />
                {isProcessing ? "Updating..." : `Update ${validCount} Item${validCount !== 1 ? "s" : ""}`}
              </Button>
              {result && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRows([]);
                    setResult(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Upload Another File
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page shell
// ═════════════════════════════════════════════════════════════════════════════

export default function ImportStockItems() {
  const [_location, navigate] = useLocation();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/accounting-create")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <PageHeader title="Import Stock Items" subtitle="Bulk import items or assign barcodes from Excel" />
      </div>

      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items" data-testid="tab-new-items">
            <Package className="h-4 w-4 mr-2" />
            New Items
          </TabsTrigger>
          <TabsTrigger value="barcodes" data-testid="tab-barcodes">
            <Barcode className="h-4 w-4 mr-2" />
            Barcodes
          </TabsTrigger>
          <TabsTrigger value="categories" data-testid="tab-categories">
            <Tag className="h-4 w-4 mr-2" />
            Update Categories
          </TabsTrigger>
        </TabsList>

        <TabsContent value="items" className="mt-4">
          <NewItemsTab />
        </TabsContent>

        <TabsContent value="barcodes" className="mt-4">
          <BarcodesTab />
        </TabsContent>

        <TabsContent value="categories" className="mt-4">
          <UpdateCategoriesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
