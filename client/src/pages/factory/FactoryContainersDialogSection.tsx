// Extracted from ./FactoryContainers.tsx to keep that module under the source-size cap.
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ContainerStatusBadge } from "./factory-containers/ContainerBadges";
import { downloadContainerTemplate } from "./factory-containers/ContainerDialogs";
import { useFactoryContainersState } from "./useFactoryContainersState";

export function FactoryContainersDialogSection({
  fileInputRef,
  handleFileSelect,
  importMutation,
  importOpen,
  importPreview,
  importResult,
  setImportOpen,
  setImportPreview,
  setImportResult,
}: Pick<
  ReturnType<typeof useFactoryContainersState>,
  | "fileInputRef"
  | "handleFileSelect"
  | "importMutation"
  | "importOpen"
  | "importPreview"
  | "importResult"
  | "setImportOpen"
  | "setImportPreview"
  | "setImportResult"
>) {
  return (
    <Dialog
      open={importOpen}
      onOpenChange={(v) => {
        if (!v) {
          setImportOpen(false);
          setImportPreview([]);
          setImportResult(null);
        }
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import Containers from Excel
          </DialogTitle>
          <DialogDescription>
            Upload an Excel file (.xlsx) to bulk-import containers. New suppliers will be created automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={downloadContainerTemplate}
              data-testid="button-download-template"
            >
              <Download className="h-4 w-4 mr-2" /> Download Template
            </Button>
            <div className="text-sm text-muted-foreground">
              Expected columns: Container Number, Supplier, Origin, Total Kg, Rate/Kg, Currency, FX Rate (optional), FX
              Source, Arrival Date, Status, Notes
            </div>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileSelect}
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground cursor-pointer"
              data-testid="input-import-file"
            />
          </div>
          {importPreview.length > 0 && !importResult && (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-medium">{importPreview.length} rows ready to import</p>
                <Button
                  onClick={() => importMutation.mutate(importPreview)}
                  disabled={importMutation.isPending}
                  data-testid="button-confirm-import"
                >
                  {importMutation.isPending ? "Importing..." : `Import ${importPreview.length} Containers`}
                </Button>
              </div>
              <div className="border rounded-md overflow-auto max-h-64">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Container #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Origin</TableHead>
                      <TableHead className="text-right">Kg</TableHead>
                      <TableHead className="text-right">Rate/Kg</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importPreview.map((row, i) => (
                      <TableRow key={i} data-testid={`row-import-preview-${i}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-mono font-medium">{row.containerNumber}</TableCell>
                        <TableCell>{row.supplierName || "-"}</TableCell>
                        <TableCell>{row.origin || "-"}</TableCell>
                        <TableCell className="text-right font-mono">{row.totalKg || "-"}</TableCell>
                        <TableCell className="text-right font-mono">{row.ratePerKg || "-"}</TableCell>
                        <TableCell>{row.currencyCode}</TableCell>
                        <TableCell>
                          <ContainerStatusBadge status={row.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          {importResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <p className="font-medium">
                  {importResult.imported} of {importResult.total} containers imported successfully
                </p>
              </div>
              {importResult.errors.length > 0 && (
                <div className="border border-destructive/30 rounded-md p-3 space-y-1">
                  <p className="text-sm font-medium flex items-center gap-1">
                    <AlertCircle className="h-4 w-4 text-destructive" />
                    {importResult.errors.length} error(s):
                  </p>
                  {importResult.errors.map((err, i) => (
                    <p key={i} className="text-sm text-muted-foreground">
                      {err}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setImportOpen(false);
              setImportPreview([]);
              setImportResult(null);
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
