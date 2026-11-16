import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Upload, Download, CheckCircle2, AlertCircle, Barcode, Package, Tag } from "lucide-react";
import { utils, writeFile, read } from "@/lib/excelHelper";
import { useCompany } from "@/contexts/CompanyContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { UpdateCategoriesTab } from "./import-stock-items/UpdateCategoriesTab";
import { BarcodesTab } from "./ImportStockItemsBarcodesTab";

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
                <thead className="sticky top-0 z-30 bg-muted">
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
// Page shell
// ═════════════════════════════════════════════════════════════════════════════

export default function ImportStockItems() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import Stock Items"
        subtitle="Bulk import items or assign barcodes from Excel"
        backTarget="/create"
      />

      <Tabs defaultValue="items">
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Stock import sections">
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
        </div>

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
