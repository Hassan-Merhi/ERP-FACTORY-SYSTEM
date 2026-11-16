import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import { Check, FileDown, FileSpreadsheet, Loader2, TrendingDown, TrendingUp, Upload } from "lucide-react";
import { useSilentProductionDialogState, type Props } from "./useSilentProductionDialogState";
import { SilentProductionDialogSection } from "./SilentProductionDialogSection";

export function SilentProductionDialog(props: Props) {
  const {
    allStockItems,
    appMode,
    applySilentImport,
    downloadSilentTemplate,
    dtCurrentUser,
    exportSilentExcel,
    exportSilentPDF,
    handleSilentImportFile,
    locations,
    setSilentImportMode,
    setSilentImportPreview,
    setSilentProdApplying,
    setSilentProdDone,
    setSilentProdItems,
    setSilentProdLocId,
    setSilentProdOpen,
    setSilentProdSearchTerm,
    setSilentProdType,
    silentImportFileRef,
    silentImportLoading,
    silentImportMode,
    silentImportPreview,
    silentLocInventory,
    silentLocInventoryLoading,
    silentProdApplying,
    silentProdDone,
    silentProdItems,
    silentProdLocId,
    silentProdOpen,
    silentProdSearchTerm,
    silentProdType,
    toast,
  } = useSilentProductionDialogState(props);

  if (dtCurrentUser?.role !== "Developer" || appMode === "factory") return null;

  return (
    <Dialog
      open={silentProdOpen}
      onOpenChange={(open) => {
        if (!silentProdApplying) {
          if (!open) setSilentProdSearchTerm("");
          setSilentProdOpen(open);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Silent Production / Consumption</DialogTitle>
          <DialogDescription>
            Adjusts inventory directly without creating any accounting or daybook entries. Developer use only.
          </DialogDescription>
        </DialogHeader>

        {silentProdDone > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <Check className="h-5 w-5" />
              <p className="font-semibold">Applied {silentProdDone} item(s) silently</p>
            </div>
            <Button variant="outline" onClick={() => setSilentProdOpen(false)} data-testid="button-silent-prod-close">
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2 border-b pb-3">
              <Button
                variant={!silentImportMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSilentImportMode(false);
                  setSilentImportPreview([]);
                }}
                data-testid="button-mode-manual"
              >
                Manual Entry
              </Button>
              <Button
                variant={silentImportMode ? "default" : "outline"}
                size="sm"
                onClick={() => setSilentImportMode(true)}
                data-testid="button-mode-import"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
                Import from Excel
              </Button>
            </div>

            <div className="space-y-1">
              <Label>Location</Label>
              <Select value={silentProdLocId} onValueChange={setSilentProdLocId}>
                <SelectTrigger data-testid="select-silent-prod-location">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!silentImportMode ? (
              <SilentProductionDialogSection
                allStockItems={allStockItems}
                setSilentProdApplying={setSilentProdApplying}
                setSilentProdDone={setSilentProdDone}
                setSilentProdItems={setSilentProdItems}
                setSilentProdOpen={setSilentProdOpen}
                setSilentProdSearchTerm={setSilentProdSearchTerm}
                setSilentProdType={setSilentProdType}
                silentLocInventory={silentLocInventory}
                silentLocInventoryLoading={silentLocInventoryLoading}
                silentProdApplying={silentProdApplying}
                silentProdItems={silentProdItems}
                silentProdLocId={silentProdLocId}
                silentProdSearchTerm={silentProdSearchTerm}
                silentProdType={silentProdType}
              />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Upload an Excel file with <strong>Code</strong>, <strong>Name</strong>, <strong>Qty Change</strong>,{" "}
                  <strong>Rate</strong> columns. Positive qty = Production (+), Negative qty = Consumption (−). Both can
                  be in the same file.
                </p>

                {silentImportPreview.length === 0 ? (
                  <div className="space-y-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadSilentTemplate}
                      data-testid="button-download-silent-template"
                    >
                      <FileDown className="h-4 w-4 mr-1" />
                      Download Template
                    </Button>
                    <label
                      className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md p-8 cursor-pointer hover-elevate text-muted-foreground"
                      data-testid="label-silent-import-dropzone"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!silentProdLocId) {
                          toast({ title: "Select a location first", variant: "destructive" });
                          return;
                        }
                        const file = event.dataTransfer.files[0];
                        if (file) handleSilentImportFile(file);
                      }}
                    >
                      <input
                        ref={silentImportFileRef}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        data-testid="input-silent-import-file"
                        onChange={(event) => {
                          if (!silentProdLocId) {
                            toast({ title: "Select a location first", variant: "destructive" });
                            return;
                          }
                          const file = event.target.files?.[0];
                          if (file) handleSilentImportFile(file);
                          event.target.value = "";
                        }}
                      />
                      <Upload className="h-8 w-8 opacity-40" />
                      <span className="text-sm font-medium">
                        {silentImportLoading ? "Parsing…" : "Click or drag & drop Excel file"}
                      </span>
                      <span className="text-xs">.xlsx / .xls — select a location first</span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex gap-3 text-xs font-medium">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {silentImportPreview.filter((row) => row.change > 0 && row.status !== "not_found").length}{" "}
                          production
                        </span>
                        <span className="text-destructive">
                          {silentImportPreview.filter((row) => row.change < 0 && row.status !== "not_found").length}{" "}
                          consumption
                        </span>
                        {silentImportPreview.filter((row) => row.status === "not_found").length > 0 && (
                          <span className="text-muted-foreground">
                            {silentImportPreview.filter((row) => row.status === "not_found").length} unmatched
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={exportSilentExcel}
                          data-testid="button-export-silent-excel"
                        >
                          <FileDown className="h-3 w-3 mr-1" />
                          Excel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={exportSilentPDF}
                          data-testid="button-export-silent-pdf"
                        >
                          <FileDown className="h-3 w-3 mr-1" />
                          PDF
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSilentImportPreview([]);
                            if (silentImportFileRef.current) silentImportFileRef.current.value = "";
                          }}
                          data-testid="button-clear-silent-import"
                        >
                          Clear
                        </Button>
                      </div>
                    </div>

                    <div className="border rounded-md overflow-hidden text-sm">
                      <div className="max-h-[280px] overflow-y-auto">
                        <table className="w-full">
                          <thead className="bg-muted sticky top-0">
                            <tr>
                              <th className="text-left p-2 font-medium">Item</th>
                              <th className="text-right p-2 font-medium">Current</th>
                              <th className="text-right p-2 font-medium">Change</th>
                              <th className="text-right p-2 font-medium">New Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {silentImportPreview.map((row, index) => (
                              <tr key={index} className={`border-t ${row.status === "not_found" ? "opacity-50" : ""}`}>
                                <td className="p-2">
                                  <p className="font-medium truncate max-w-[220px]">{row.stockItemName}</p>
                                  {row.status === "not_found" && (
                                    <p className="text-xs text-destructive">Not found — skipped</p>
                                  )}
                                  {row.status === "to_zero" && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400">Will reach 0</p>
                                  )}
                                </td>
                                <td className="p-2 text-right font-mono text-muted-foreground">
                                  {formatNumber(row.currentQty, 0)}
                                </td>
                                <td
                                  className={`p-2 text-right font-mono font-semibold ${
                                    row.change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                  }`}
                                >
                                  <span className="inline-flex items-center gap-0.5 justify-end">
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
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setSilentProdOpen(false)}
                        data-testid="button-silent-import-cancel"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={applySilentImport}
                        disabled={
                          silentProdApplying ||
                          silentImportPreview.every((row) => row.status === "not_found") ||
                          !silentProdLocId
                        }
                        data-testid="button-silent-import-apply"
                      >
                        {silentProdApplying ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Applying…
                          </>
                        ) : (
                          "Apply Adjustments"
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
