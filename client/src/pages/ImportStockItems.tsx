import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Upload, Download, CheckCircle2, Barcode, Package, Tag } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { UpdateCategoriesTab } from "./import-stock-items/UpdateCategoriesTab";
import { NewItemsTab } from "./ImportStockItemsNewItemsTab";
import { useBarcodesTabState } from "./ImportStockItemsUseBarcodesTabState";

// ═════════════════════════════════════════════════════════════════════════════
// Barcodes tab
// ═════════════════════════════════════════════════════════════════════════════

function BarcodesTab() {
  const {
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
  } = useBarcodesTabState();

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
