// Extracted from ./ImportStockItems.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, Download, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNewItemsTabState } from "./useNewItemsTabState";

// ═════════════════════════════════════════════════════════════════════════════
// New Items tab
// ═════════════════════════════════════════════════════════════════════════════

export function NewItemsTab() {
  const {
    downloadTemplate,
    errors,
    file,
    handleFileChange,
    handleImport,
    importComplete,
    isProcessing,
    previewData,
    setErrors,
    setFile,
    setImportComplete,
    setPreviewData,
  } = useNewItemsTabState();

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
