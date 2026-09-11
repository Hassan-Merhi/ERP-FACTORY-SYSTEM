import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Upload, Download, FileSpreadsheet, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImportLocation {
  id: number;
  name: string;
}

interface ImportItem {
  sourceLocation?: string | null;
  barcode: string;
  quantity: string | number;
}

interface ImportPreview {
  items: ImportItem[];
}

interface ImportValidationItem {
  error?: string;
  stockItemName?: string;
  currentStock?: number;
}

interface ImportValidationResult {
  errors: string[];
  validatedItems: ImportValidationItem[];
}

interface StockTransferImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: ImportLocation[];
  importFile: File | null;
  handleImportFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  downloadImportTemplate: () => void;
  importDestLocation: string;
  setImportDestLocation: (loc: string) => void;
  importDate: string;
  setImportDate: (date: string) => void;
  importNotes: string;
  setImportNotes: (notes: string) => void;
  handleImportParse: () => void;
  importParsePending: boolean;
  handleImportValidate: () => void;
  importValidatePending: boolean;
  importIsValidated: boolean;
  importHasErrors: boolean;
  handleImportSubmit: () => void;
  importMutationPending: boolean;
  importValidItemsCount: number;
  importPreview: ImportPreview | null;
  importValidationResult: ImportValidationResult | null;
  formatNumber: (num: number, decimals?: number) => string;
}

export function StockTransferImportDialog({
  open,
  onOpenChange,
  locations,
  importFile,
  handleImportFileChange,
  downloadImportTemplate,
  importDestLocation,
  setImportDestLocation,
  importDate,
  setImportDate,
  importNotes,
  setImportNotes,
  handleImportParse,
  importParsePending,
  handleImportValidate,
  importValidatePending,
  importIsValidated,
  importHasErrors,
  handleImportSubmit,
  importMutationPending,
  importValidItemsCount,
  importPreview,
  importValidationResult,
  formatNumber,
}: StockTransferImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import Stock Transfer from Excel
          </DialogTitle>
          <DialogDescription>
            Upload an Excel file with columns: Source Location, Barcode, Quantity. Each row can have a different source
            location.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex-1 w-full sm:w-auto">
              <Label htmlFor="import-file">Excel File</Label>
              <Input
                id="import-file"
                type="file"
                accept=".xlsx,.xls"
                onChange={handleImportFileChange}
                className="mt-1"
                data-testid="input-import-file"
              />
              {importFile && <p className="text-sm text-muted-foreground mt-1">Selected: {importFile.name}</p>}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadImportTemplate}
              className="mt-6"
              data-testid="button-download-import-template"
            >
              <Download className="h-4 w-4 mr-2" />
              Template
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="import-dest-location">Destination Location</Label>
              <Select value={importDestLocation} onValueChange={setImportDestLocation}>
                <SelectTrigger id="import-dest-location" className="mt-1" data-testid="select-import-dest-location">
                  <SelectValue placeholder="Select destination..." />
                </SelectTrigger>
                <SelectContent>
                  {[...locations]
                    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                    .map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="import-date">Transfer Date</Label>
              <Input
                id="import-date"
                type="date"
                value={importDate}
                onChange={(e) => setImportDate(e.target.value)}
                className="mt-1"
                data-testid="input-import-date"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="import-notes">Notes (Optional)</Label>
            <Textarea
              id="import-notes"
              value={importNotes}
              onChange={(e) => setImportNotes(e.target.value)}
              placeholder="Optional notes for this transfer..."
              rows={2}
              className="mt-1"
              data-testid="input-import-notes"
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={handleImportParse}
              disabled={!importFile || importParsePending}
              variant="outline"
              data-testid="button-import-parse"
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {importParsePending ? "Parsing..." : "Parse File"}
            </Button>

            <Button
              onClick={handleImportValidate}
              disabled={!importPreview || !importDestLocation || importValidatePending}
              variant="outline"
              data-testid="button-import-validate"
            >
              {importIsValidated ? (
                importHasErrors ? (
                  <XCircle className="h-4 w-4 mr-2 text-destructive" />
                ) : (
                  <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                )
              ) : null}
              {importValidatePending ? "Validating..." : "Validate"}
            </Button>

            <Button
              onClick={handleImportSubmit}
              disabled={!importIsValidated || importMutationPending}
              data-testid="button-import-submit"
            >
              <Upload className="h-4 w-4 mr-2" />
              {importMutationPending
                ? "Importing..."
                : importHasErrors
                  ? `Import Transfer (${importValidItemsCount} valid)`
                  : "Import Transfer"}
            </Button>
          </div>

          {importValidationResult?.errors && importValidationResult.errors.length > 0 && (
            <div className="p-3 border border-destructive rounded-md bg-destructive/10">
              <p className="font-medium text-destructive mb-2">Validation Errors:</p>
              <ul className="list-disc list-inside space-y-1">
                {importValidationResult.errors.map((error: string, index: number) => (
                  <li key={index} className="text-sm text-destructive">
                    {error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {importPreview && (
            <div className="border rounded-md">
              <div className="p-3 border-b bg-muted/50">
                <p className="font-medium">Preview ({importPreview.items.length} items)</p>
              </div>
              <div className="hidden sm:block max-h-60 overflow-y-auto overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-20 bg-background">
                    <TableRow>
                      <TableHead className="sticky left-0 bg-muted z-10">Source Location</TableHead>
                      <TableHead>Barcode</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importPreview.items.map((item, index: number) => {
                      const validation = importValidationResult?.validatedItems?.[index];
                      const hasError = validation?.error;

                      return (
                        <TableRow
                          key={index}
                          className={hasError ? "bg-destructive/10" : ""}
                          data-testid={`import-preview-row-${index}`}
                        >
                          <TableCell className="sticky left-0 bg-background z-10">
                            {item.sourceLocation || "-"}
                          </TableCell>
                          <TableCell className="font-mono">{item.barcode}</TableCell>
                          <TableCell>
                            {validation?.stockItemName || <span className="text-muted-foreground italic">Unknown</span>}
                          </TableCell>
                          <TableCell className="text-right">{item.quantity}</TableCell>
                          <TableCell className="text-right">
                            {validation?.currentStock !== undefined ? formatNumber(validation.currentStock) : "-"}
                          </TableCell>
                          <TableCell>
                            {validation ? (
                              hasError ? (
                                <div className="flex items-center gap-1 text-destructive">
                                  <XCircle className="h-4 w-4" />
                                  <span className="text-sm">{validation.error}</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 text-green-600">
                                  <CheckCircle className="h-4 w-4" />
                                  <span className="text-sm">OK</span>
                                </div>
                              )
                            ) : (
                              <span className="text-sm text-muted-foreground">Not validated</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="sm:hidden max-h-60 overflow-y-auto p-2 space-y-2">
                {importPreview.items.map((item, index: number) => {
                  const validation = importValidationResult?.validatedItems?.[index];
                  const hasError = validation?.error;

                  return (
                    <div
                      key={index}
                      className={cn(
                        "p-3 rounded-md border text-sm space-y-1",
                        hasError ? "bg-destructive/10 border-destructive/30" : "bg-background"
                      )}
                      data-testid={`import-preview-card-${index}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {validation?.stockItemName || <span className="text-muted-foreground italic">Unknown</span>}
                        </span>
                        {validation ? (
                          hasError ? (
                            <XCircle className="h-4 w-4 text-destructive shrink-0" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                          )
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Source: {item.sourceLocation || "-"}</span>
                        <span className="font-mono">Code: {item.barcode}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span>
                          Qty: <span className="font-mono">{item.quantity}</span>
                        </span>
                        <span>
                          Avail:{" "}
                          <span className="font-mono">
                            {validation?.currentStock !== undefined ? formatNumber(validation.currentStock) : "-"}
                          </span>
                        </span>
                      </div>
                      {hasError && <div className="text-xs text-destructive">{validation.error}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
