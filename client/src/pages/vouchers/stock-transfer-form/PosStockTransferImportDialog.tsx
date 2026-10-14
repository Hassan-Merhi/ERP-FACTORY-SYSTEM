import { useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parsePosTransferImportFile } from "./posTransferExcelImport";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function PosStockTransferImportDialog({ model }: { model: StockTransferFormModel }) {
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const source = model.locations.find((location) => location.id === model.posSelectedSourceId);

  const setOpen = (open: boolean) => {
    if (loading) return;
    model.setPosImportDialogOpen(open);
    if (!open) {
      setFile(null);
      setErrors([]);
    }
  };

  const downloadTemplate = () => {
    // CSV opens normally in Excel, and needs no privileged server import endpoint.
    const csv = "Item Code,Quantity\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "POS_Stock_Transfer_Import_Template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const loadRows = async () => {
    if (!file || !source || loading) return;
    setLoading(true);
    setErrors([]);
    try {
      const result = await parsePosTransferImportFile(
        file,
        model.stockItems,
        model.transferInventory,
        source.id,
        source.name
      );
      if (result.errors.length) {
        setErrors(result.errors);
        return;
      }
      model.replaceTransfer(result.entries);
      model.stockTransferForm.clearErrors("entries");
      model.toast({
        title: "Items loaded",
        description: `${result.entries.length} stock item(s) loaded from Excel. Review quantities and press Save Transfer.`,
      });
      setOpenAfterLoad();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "Could not read this spreadsheet."]);
    } finally {
      setLoading(false);
    }
  };

  const setOpenAfterLoad = () => {
    model.setPosImportDialogOpen(false);
    setFile(null);
    setErrors([]);
  };

  return (
    <Dialog open={model.posImportDialogOpen} onOpenChange={setOpen}>
      <DialogContent className="w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" /> Import Stock Transfer
          </DialogTitle>
          <DialogDescription>
            Import Excel or CSV rows using Item Code (or Barcode) and Quantity.
            All rows use your selected From location. Nothing is transferred until you review the items and save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm">
            From: <strong>{source?.name || "Select a source location"}</strong>
          </p>
          <div className="space-y-2">
            <label htmlFor="pos-transfer-import-file" className="text-sm font-medium">
              Excel / CSV file
            </label>
            <Input
              id="pos-transfer-import-file"
              type="file"
              accept=".xlsx,.csv"
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setErrors([]);
              }}
              data-testid="input-pos-transfer-import-file"
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}
            data-testid="button-pos-transfer-import-template">
            <Download className="h-4 w-4 mr-2" /> Download Template
          </Button>
          {model.transferEntries.some((entry) => entry.stockItemId > 0) && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Loading the spreadsheet will replace the item rows currently on this form.
            </p>
          )}
          {errors.length > 0 && (
            <div role="alert" className="max-h-48 overflow-y-auto text-sm text-destructive space-y-1" data-testid="pos-transfer-import-errors">
              {errors.map((error, index) => <p key={index}>{error}</p>)}
              <p>Correct the spreadsheet and upload it again. No rows were changed.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancel</Button>
          <Button type="button" onClick={loadRows} disabled={!file || !source || loading}
            data-testid="button-pos-transfer-load-items">
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            {loading ? "Reading..." : "Load Items into Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
