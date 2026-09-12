import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Upload } from "lucide-react";
import type { ContainerPriceImportPreviewRow, useContainerDetailModel } from "../useContainerDetailModel";

type Model = ReturnType<typeof useContainerDetailModel>;
export function ContainerDetailPriceImportDialog({ model }: { model: Model }) {
  const {
    showPriceImportDialog,
    setShowPriceImportDialog,
    priceImportPreview,
    setPriceImportPreview,
    priceImportParsing,
    priceImportError,
    setPriceImportError,
    priceImportFileRef,
    pricePreviewMutation,
    priceApplyMutation,
    handlePriceImportFile,
    formatAmount,
  } = model;
  return (
    <Dialog
      open={showPriceImportDialog}
      onOpenChange={(open) => {
        if (!open) {
          setPriceImportPreview(null);
          setPriceImportError(null);
        }
        setShowPriceImportDialog(open);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import Pricing from Excel</DialogTitle>
          <DialogDescription>
            Upload an Excel file with columns <strong>barcode</strong> and <strong>price</strong>. Review the preview,
            then save to apply.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 overflow-hidden">
          {/* File upload area */}
          <div
            className="border-2 border-dashed rounded-md p-6 flex flex-col items-center gap-3 cursor-pointer hover-elevate"
            onClick={() => priceImportFileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) handlePriceImportFile(file);
            }}
            data-testid="dropzone-price-import"
          >
            <Upload className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground text-center">
              Click or drag an Excel file here
              <br />
              <span className="text-xs">
                Columns: <code>barcode</code> and <code>price</code> (or A/B if no headers)
              </span>
            </p>
            <input
              ref={priceImportFileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              data-testid="input-price-import-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handlePriceImportFile(file);
                e.target.value = "";
              }}
            />
          </div>

          {(priceImportParsing || pricePreviewMutation.isPending) && (
            <p className="text-sm text-muted-foreground text-center">Reading file and fetching preview…</p>
          )}

          {priceImportError && <p className="text-sm text-destructive">{priceImportError}</p>}

          {/* Preview table */}
          {priceImportPreview && priceImportPreview.length > 0 && (
            <div className="overflow-auto flex-1 border rounded-md">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Code / Barcode</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead>Current Rate</TableHead>
                    <TableHead>New Rate</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceImportPreview.map((row, i: number) => (
                    <TableRow key={i} data-testid={`row-price-preview-${i}`}>
                      <TableCell className="font-mono text-xs">{row.barcode}</TableCell>
                      <TableCell className="text-sm">{row.itemName || "—"}</TableCell>
                      <TableCell className="text-sm">
                        {row.currentRate != null ? formatAmount(row.currentRate) : "—"}
                      </TableCell>
                      <TableCell className="text-sm font-medium">
                        {row.newRate != null ? formatAmount(row.newRate) : "—"}
                      </TableCell>
                      <TableCell>
                        {row.status === "will_update" && (
                          <Badge variant="default" data-testid={`status-preview-${i}`}>
                            Will Update
                          </Badge>
                        )}
                        {row.status === "no_change" && (
                          <Badge variant="secondary" data-testid={`status-preview-${i}`}>
                            No Change
                          </Badge>
                        )}
                        {row.status === "not_found" && (
                          <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                            Not Found
                          </Badge>
                        )}
                        {row.status === "not_in_container" && (
                          <Badge variant="secondary" data-testid={`status-preview-${i}`}>
                            Not in Container
                          </Badge>
                        )}
                        {row.status === "invalid_price" && (
                          <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                            Invalid Price
                          </Badge>
                        )}
                        {row.status === "invalid" && (
                          <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                            Invalid Row
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {priceImportPreview && priceImportPreview.length === 0 && (
            <p className="text-sm text-muted-foreground text-center">No rows found in the file.</p>
          )}
        </div>

        {priceImportPreview && priceImportPreview.some((r) => r.status === "will_update") && (
          <div className="flex justify-between items-center pt-2 border-t gap-2 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {priceImportPreview.filter((r) => r.status === "will_update").length} item(s) will be updated
              {priceImportPreview.some((r) => r.status === "not_found") &&
                ` · ${priceImportPreview.filter((r) => r.status === "not_found").length} not found`}
              {priceImportPreview.some((r) => r.status === "not_in_container") &&
                ` · ${priceImportPreview.filter((r) => r.status === "not_in_container").length} not in this container`}
            </p>
            <Button
              onClick={() => {
                const rows = priceImportPreview
                  .filter(
                    (r): r is ContainerPriceImportPreviewRow & { lineItemIds: number[]; newRate: number } =>
                      r.status === "will_update" && !!r.lineItemIds?.length && r.newRate != null
                  )
                  .map((r) => ({ lineItemIds: r.lineItemIds, newRate: r.newRate }));
                priceApplyMutation.mutate(rows);
              }}
              disabled={priceApplyMutation.isPending}
              data-testid="button-save-price-import"
            >
              {priceApplyMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
