import type { Dispatch, RefObject, SetStateAction } from "react";
import { AlertCircle, Check, FileDown, FileSpreadsheet, TrendingDown, TrendingUp, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";
import type { ImportPreviewRow } from "../../stocktransferorder/types";

type ImportDialogProps = {
  applyImport: () => void;
  downloadImportTemplate: () => void | Promise<void>;
  exportPreviewExcel: () => void | Promise<void>;
  exportPreviewPDF: () => void | Promise<void>;
  handleImportFile: (file: File) => void | Promise<void>;
  importDialogOpen: boolean;
  importFileRef: RefObject<HTMLInputElement | null>;
  importLoading: boolean;
  importPreview: ImportPreviewRow[];
  setImportDialogOpen: Dispatch<SetStateAction<boolean>>;
  setImportPreview: Dispatch<SetStateAction<ImportPreviewRow[]>>;
};

export function ImportDialog({
  applyImport,
  downloadImportTemplate,
  exportPreviewExcel,
  exportPreviewPDF,
  handleImportFile,
  importDialogOpen,
  importFileRef,
  importLoading,
  importPreview,
  setImportDialogOpen,
  setImportPreview,
}: ImportDialogProps) {
  const updateCount = importPreview.filter((row) => row.status === "ok" || row.status === "new_item").length;
  const removeCount = importPreview.filter((row) => row.status === "remove").length;
  const unmatchedCount = importPreview.filter((row) => row.status === "not_found").length;

  return (
    <Dialog
      open={importDialogOpen}
      onOpenChange={(open) => {
        setImportDialogOpen(open);
        if (!open) setImportPreview([]);
      }}
    >
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Import from Excel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {importPreview.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Upload an Excel file with columns: <strong>Code</strong>, <strong>Name</strong>,{" "}
                <strong>Qty Change</strong>. Use positive values to add and negative to reduce.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadImportTemplate}
                  data-testid="button-download-template"
                >
                  <FileDown className="h-4 w-4 mr-1" />
                  Download Template
                </Button>
              </div>
              <label
                className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md p-8 cursor-pointer hover-elevate text-muted-foreground"
                data-testid="label-import-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file) handleImportFile(file);
                }}
              >
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  data-testid="input-import-file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleImportFile(file);
                    event.target.value = "";
                  }}
                />
                <Upload className="h-8 w-8 opacity-40" />
                <span className="text-sm font-medium">
                  {importLoading ? "Parsing..." : "Click or drag & drop Excel file"}
                </span>
                <span className="text-xs">.xlsx / .xls supported</span>
              </label>
              {importLoading && <p className="text-sm text-center text-muted-foreground">Reading file…</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex gap-2 text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">{updateCount} to update</span>
                  {removeCount > 0 && <span className="text-destructive font-medium">{removeCount} to remove</span>}
                  {unmatchedCount > 0 && <span className="text-muted-foreground">{unmatchedCount} unmatched</span>}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportPreviewExcel}
                    data-testid="button-export-preview-excel"
                  >
                    <FileDown className="h-3 w-3 mr-1" />
                    Excel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportPreviewPDF}
                    data-testid="button-export-preview-pdf"
                  >
                    <FileDown className="h-3 w-3 mr-1" />
                    PDF
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setImportPreview([]);
                      if (importFileRef.current) importFileRef.current.value = "";
                    }}
                    data-testid="button-clear-import"
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <div className="border rounded-md overflow-hidden text-sm">
                <div className="max-h-[340px] overflow-y-auto">
                  <table className="w-full">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium">Item</th>
                        <th className="text-right p-2 font-medium">Current</th>
                        <th className="text-right p-2 font-medium">Change</th>
                        <th className="text-right p-2 font-medium">New Qty</th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.map((row, index) => (
                        <tr key={index} className={cn("border-t", row.status === "not_found" && "opacity-50")}>
                          <td className="p-2">
                            <p className="font-medium truncate max-w-[220px]">{row.stockItemName}</p>
                            {row.status === "new_item" && (
                              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                New — from {row.sourceLocationName || "?"}
                              </p>
                            )}
                            {row.status === "not_found" && (
                              <p className="text-xs text-destructive">Not found — skipped</p>
                            )}
                            {row.status === "remove" && (
                              <p className="text-xs text-destructive">Will be removed from order</p>
                            )}
                          </td>
                          <td className="p-2 text-right font-mono text-muted-foreground">
                            {formatNumber(row.currentQty, 0)}
                          </td>
                          <td
                            className={cn(
                              "p-2 text-right font-mono font-semibold",
                              row.change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                            )}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              {row.change > 0 ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {row.change > 0 ? "+" : ""}
                              {formatNumber(row.change, 0)}
                            </span>
                          </td>
                          <td className="p-2 text-right font-mono font-semibold">
                            {row.status !== "not_found" ? formatNumber(row.newQty, 0) : "—"}
                          </td>
                          <td className="p-2 text-center">
                            {row.status === "ok" && <Check className="h-4 w-4 text-emerald-500 mx-auto" />}
                            {row.status === "new_item" && (
                              <span className="text-xs bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded-full">
                                +New
                              </span>
                            )}
                            {row.status === "remove" && <AlertCircle className="h-4 w-4 text-destructive mx-auto" />}
                            {row.status === "not_found" && (
                              <AlertCircle className="h-4 w-4 text-muted-foreground mx-auto" />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setImportDialogOpen(false);
              setImportPreview([]);
            }}
            data-testid="button-cancel-import"
          >
            Cancel
          </Button>
          {importPreview.length > 0 && (
            <Button
              onClick={applyImport}
              disabled={importPreview.every((row) => row.status === "not_found")}
              data-testid="button-apply-import"
            >
              Apply to Order
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
