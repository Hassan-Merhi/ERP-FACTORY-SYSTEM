import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, FileDown, FileSpreadsheet, Upload } from "lucide-react";
import { useSilentProductionDialogState, type Props } from "./useSilentProductionDialogState";
import { SilentProductionDialogSection } from "./SilentProductionDialogSection";
import { SilentProductionDialogContent } from "./SilentProductionDialogContent";

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
                  <SilentProductionDialogContent
                    applySilentImport={applySilentImport}
                    exportSilentExcel={exportSilentExcel}
                    exportSilentPDF={exportSilentPDF}
                    setSilentImportPreview={setSilentImportPreview}
                    setSilentProdOpen={setSilentProdOpen}
                    silentImportFileRef={silentImportFileRef}
                    silentImportPreview={silentImportPreview}
                    silentProdApplying={silentProdApplying}
                    silentProdLocId={silentProdLocId}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
