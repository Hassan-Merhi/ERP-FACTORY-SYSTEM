import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useBaleProductsModel } from "../useBaleProductsModel";

type Model = ReturnType<typeof useBaleProductsModel>;
export function BaleProductsDialog2({ model }: { model: Model }) {
  const {
    importDialogOpen,
    setImportDialogOpen,
    importPreview,
    setImportPreview,
    importError,
    setImportFile,
    products: _products,
    importMutation,
    handleConfirmImport,
  } = model;
  return (
    <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Preview</DialogTitle>
          <DialogDescription>
            Review the {importPreview.length} product(s) to import. Existing products (by Article Code) will be updated.
          </DialogDescription>
        </DialogHeader>

        {importError && <div className="text-destructive text-sm p-2 rounded-md bg-destructive/10">{importError}</div>}

        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead>Article Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Weight/Bale</TableHead>
              <TableHead>Cost Price</TableHead>
              <TableHead>Sell Price</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {importPreview.map((row, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-mono font-medium">{row.articleCode}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.category || "Uncategorized"}</TableCell>
                <TableCell>{row.weightPerBaleKg || "-"}</TableCell>
                <TableCell>
                  {row.productionPrice != null ? Number(row.productionPrice).toLocaleString() : "-"}
                </TableCell>
                <TableCell>{row.sellingPrice != null ? Number(row.sellingPrice).toLocaleString() : "-"}</TableCell>
                <TableCell className="text-muted-foreground">{row.description || "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setImportDialogOpen(false);
              setImportFile(null);
              setImportPreview([]);
            }}
            data-testid="button-cancel-import"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmImport}
            disabled={importMutation.isPending || importPreview.length === 0}
            data-testid="button-confirm-import"
          >
            {importMutation.isPending ? "Importing..." : `Import ${importPreview.length} Products`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
