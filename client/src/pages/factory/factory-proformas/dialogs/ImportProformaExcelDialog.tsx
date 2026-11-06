/**
 * ImportProformaExcelDialog — extracted from FactoryProformas.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryProformasModel } from "../../factoryproformas/useFactoryProformasModel";

type FactoryProformasModel = ReturnType<typeof useFactoryProformasModel>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Upload, AlertCircle } from "lucide-react";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Customer } from "../../factoryproformas/types";

export function ImportProformaExcelDialog({
  bulkImportMutation,
  customerId,
  customers,
  downloadProformaTemplate,
  excelFileInputRef,
  excelImportErrors,
  excelImportLines,
  excelImportLoading,
  excelImportName,
  excelImportDestination,
  setExcelImportDestination,
  handleExcelFile,
  isExcelImportOpen,
  setExcelImportErrors,
  setExcelImportLines,
  setExcelImportName,
  setIsExcelImportOpen,
}: {
  bulkImportMutation: FactoryProformasModel["bulkImportMutation"];
  customerId: number | null;
  customers: Customer[];
  downloadProformaTemplate: () => Promise<void>;
  excelFileInputRef: React.RefObject<HTMLInputElement | null>;
  excelImportErrors: string[];
  excelImportLines: { articleCode: string; productName: string; quantity: string; pricePerBale: string }[];
  excelImportLoading: boolean;
  excelImportName: string;
  excelImportDestination: string;
  setExcelImportDestination: FactoryProformasModel["setExcelImportDestination"];
  handleExcelFile: (file: File) => Promise<void>;
  isExcelImportOpen: boolean;
  setExcelImportErrors: React.Dispatch<React.SetStateAction<string[]>>;
  setExcelImportLines: React.Dispatch<
    React.SetStateAction<{ articleCode: string; productName: string; quantity: string; pricePerBale: string }[]>
  >;
  setExcelImportName: React.Dispatch<React.SetStateAction<string>>;
  setIsExcelImportOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <Dialog
      open={isExcelImportOpen}
      onOpenChange={(open) => {
        if (!open) {
          setIsExcelImportOpen(false);
          setExcelImportLines([]);
          setExcelImportErrors([]);
          if (excelFileInputRef.current) excelFileInputRef.current.value = "";
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import Proforma from Excel</DialogTitle>
          <DialogDescription>
            Upload an Excel file (.xlsx) with columns: <strong>Article Code</strong>, <strong>Product Name</strong>,{" "}
            <strong>Quantity</strong>, <strong>Price Per Bale</strong>. Column names are flexible — any common variation
            is detected automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {/* Customer info */}
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted">
            <div>
              <p className="text-xs text-muted-foreground">Customer</p>
              <p className="text-sm font-medium">
                {customers.find((c: Customer) => c.id === customerId)?.legalName ?? "—"}
              </p>
            </div>
          </div>

          {/* Proforma name */}
          <div>
            <Label className="text-sm font-medium mb-1 block">Proforma Name</Label>
            <Input
              placeholder="e.g. Summer 2024 Pricing"
              value={excelImportName}
              onChange={(e) => setExcelImportName(e.target.value)}
              data-testid="input-excel-import-name"
            />
          </div>

          <div>
            <Label className="text-sm font-medium mb-1 block">
              Destination <span className="text-destructive">*</span>
            </Label>
            <Input
              value={excelImportDestination}
              onChange={(e) => setExcelImportDestination(e.target.value)}
              placeholder="e.g. L'SHI, MALI, KINSHASA"
              list="excel-proforma-destinations"
              data-testid="input-excel-import-destination"
            />
            <datalist id="excel-proforma-destinations">
              <option value="L'SHI" />
              <option value="MALI" />
              <option value="KINSHASA" />
            </datalist>
          </div>
          {/* File upload */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm font-medium">Excel File (.xlsx)</Label>
              <button
                type="button"
                onClick={downloadProformaTemplate}
                className="text-xs text-primary underline-offset-2 hover:underline flex items-center gap-1"
                data-testid="button-download-template"
              >
                <Download className="h-3 w-3" />
                Download template
              </button>
            </div>
            <div
              className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover-elevate transition-colors"
              onClick={() => excelFileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handleExcelFile(file);
              }}
              data-testid="dropzone-excel-import"
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {excelImportLoading ? "Reading file…" : "Click or drag & drop an Excel file here"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Supports .xlsx format</p>
            </div>
            <input
              ref={excelFileInputRef as React.RefObject<HTMLInputElement>}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleExcelFile(f);
                e.currentTarget.value = "";
              }}
              data-testid="input-file-excel"
            />
          </div>

          {/* Parse errors */}
          {excelImportErrors.length > 0 && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-1">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                <p className="text-sm font-medium text-destructive">
                  {excelImportLines.length > 0 ? "Some rows were skipped:" : "Could not parse file:"}
                </p>
              </div>
              {excelImportErrors.map((err: React.ReactNode, i: React.Key | null | undefined) => (
                <p key={i} className="text-xs text-muted-foreground pl-6">
                  {err}
                </p>
              ))}
            </div>
          )}

          {/* Preview table */}
          {excelImportLines.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-2">
                Preview — {excelImportLines.length} row{excelImportLines.length !== 1 ? "s" : ""} ready to import
              </p>
              <div className="border rounded-md overflow-hidden">
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead className="text-xs">Article Code</TableHead>
                        <TableHead className="text-xs">Product Name</TableHead>
                        <TableHead className="text-xs text-right">Qty</TableHead>
                        <TableHead className="text-xs text-right">Price/Bale</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {excelImportLines.map((row, i: React.Key | null | undefined) => (
                        <TableRow key={i} data-testid={`row-excel-preview-${i}`}>
                          <TableCell className="font-mono text-xs py-1.5">{row.articleCode}</TableCell>
                          <TableCell className="text-xs py-1.5">{row.productName}</TableCell>
                          <TableCell className="text-right font-mono text-xs py-1.5">{row.quantity}</TableCell>
                          <TableCell className="text-right font-mono text-xs py-1.5">
                            {parseFloat(row.pricePerBale) > 0 ? parseFloat(row.pricePerBale).toFixed(2) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => {
              setIsExcelImportOpen(false);
              setExcelImportLines([]);
              setExcelImportErrors([]);
              if (excelFileInputRef.current) excelFileInputRef.current.value = "";
            }}
            data-testid="button-cancel-excel-import"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (
                !customerId ||
                !excelImportName.trim() ||
                !excelImportDestination.trim() ||
                excelImportLines.length === 0
              )
                return;
              bulkImportMutation.mutate({
                customerId,
                name: excelImportName.trim(),
                destination: excelImportDestination.trim(),
                isActive: false,
                lines: excelImportLines,
              });
            }}
            disabled={
              !excelImportName.trim() ||
              !excelImportDestination.trim() ||
              excelImportLines.length === 0 ||
              bulkImportMutation.isPending
            }
            data-testid="button-confirm-excel-import"
          >
            {bulkImportMutation.isPending ? "Creating…" : `Create Proforma (${excelImportLines.length} lines)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
