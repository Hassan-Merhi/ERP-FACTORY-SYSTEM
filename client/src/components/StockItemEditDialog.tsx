import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { LoadingState } from "@/components/ui/page-state";
import { useStockItemEditDialogState, type StockItemEditDialogProps } from "./useStockItemEditDialogState";

export function StockItemEditDialog({ open, onOpenChange, stockItemId }: StockItemEditDialogProps) {
  const {
    setShowDeleteDialog,
    showDeleteDialog,
    code,
    setCode,
    name,
    setName,
    barcode,
    setBarcode,
    uom,
    setUom,
    stockGroupId,
    setStockGroupId,
    sellingPrice,
    setSellingPrice,
    active,
    setActive,
    isLoading,
    stockItem,
    stockGroups,
    updateMutation,
    deleteMutation,
    handleSave,
    handleDelete,
  } = useStockItemEditDialogState({ open, onOpenChange, stockItemId });

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <LoadingState className="py-8" />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle data-testid="text-dialog-title">Edit Stock Item</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="input-code" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-name" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="barcode">Barcode</Label>
                <Input
                  id="barcode"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  data-testid="input-barcode"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="uom">Unit of Measure *</Label>
                <Input id="uom" value={uom} onChange={(e) => setUom(e.target.value)} data-testid="input-uom" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="stockGroup">Stock Group *</Label>
                {!stockGroupId && (
                  <p className="text-xs text-destructive">This item must be assigned to a Stock Group before saving.</p>
                )}
                <Select
                  value={stockGroupId?.toString() || ""}
                  onValueChange={(value) => setStockGroupId(parseInt(value))}
                >
                  <SelectTrigger id="stockGroup" data-testid="select-stock-group">
                    <SelectValue placeholder="Select stock group (required)" />
                  </SelectTrigger>
                  <SelectContent>
                    {stockGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id.toString()}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sellingPrice">Selling Price</Label>
                <Input
                  id="sellingPrice"
                  type="number"
                  step="0.01"
                  value={sellingPrice}
                  onChange={(e) => setSellingPrice(e.target.value)}
                  data-testid="input-selling-price"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch id="active" checked={active} onCheckedChange={setActive} data-testid="switch-active" />
              <Label htmlFor="active">Active</Label>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              className="mr-auto gap-2"
              data-testid="button-delete"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid="button-save">
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Stock Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this stock item? This action cannot be undone.
              {stockItem && (
                <div className="mt-2 p-2 bg-muted rounded-sm text-sm">
                  <strong>{stockItem.code}</strong> - {stockItem.name}
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-confirm"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
