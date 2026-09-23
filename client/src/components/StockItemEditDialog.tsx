import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface StockItemEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stockItemId: number | null;
}

interface StockItem {
  id: number;
  code: string;
  name: string;
  barcode: string | null;
  uom: string;
  stockGroupId: number | null;
  sellingPrice: string;
  active: boolean;
}

interface StockGroup {
  id: number;
  code: string;
  name: string;
}

export function StockItemEditDialog({ open, onOpenChange, stockItemId }: StockItemEditDialogProps) {
  const { toast } = useToast();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [uom, setUom] = useState("");
  const [stockGroupId, setStockGroupId] = useState<number | null>(null);
  const [sellingPrice, setSellingPrice] = useState("");
  const [active, setActive] = useState(true);

  // Fetch stock item details
  const { data: stockItem, isLoading } = useQuery<StockItem>({
    queryKey: ["/api/stock-items", stockItemId],
    enabled: open && !!stockItemId,
  });

  // Fetch stock groups
  const { data: stockGroups = [] } = useQuery<StockGroup[]>({
    queryKey: ["/api/stock-groups"],
    enabled: open,
  });

  // Initialize form when stock item data loads
  useEffect(() => {
    if (stockItem) {
      setCode(stockItem.code);
      setName(stockItem.name);
      setBarcode(stockItem.barcode || "");
      setUom(stockItem.uom);
      setStockGroupId(stockItem.stockGroupId);
      setSellingPrice(stockItem.sellingPrice);
      setActive(stockItem.active);
    }
  }, [stockItem]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: Partial<StockItem>) => {
      return await apiRequest("PATCH", `/api/stock-items/${stockItemId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items", stockItemId] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/stock-items"] });
      toast({
        title: "Stock Item Updated",
        description: "The stock item has been updated successfully.",
      });
      onOpenChange(false);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update stock item",
        variant: "destructive",
      });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("DELETE", `/api/stock-items/${stockItemId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({
        title: "Stock Item Deleted",
        description: "The stock item has been deleted successfully.",
      });
      setShowDeleteDialog(false);
      onOpenChange(false);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Delete Failed",
        description: error.message || "Failed to delete stock item",
        variant: "destructive",
      });
      setShowDeleteDialog(false);
    },
  });

  const handleSave = () => {
    if (!code.trim()) {
      toast({
        title: "Validation Error",
        description: "Code is required",
        variant: "destructive",
      });
      return;
    }

    if (!name.trim()) {
      toast({
        title: "Validation Error",
        description: "Name is required",
        variant: "destructive",
      });
      return;
    }

    if (!uom.trim()) {
      toast({
        title: "Validation Error",
        description: "Unit of measure is required",
        variant: "destructive",
      });
      return;
    }

    if (!stockGroupId) {
      toast({
        title: "Validation Error",
        description: "Stock Group is required. Please select a stock group before saving.",
        variant: "destructive",
      });
      return;
    }

    updateMutation.mutate({
      code: code.trim(),
      name: name.trim(),
      barcode: barcode.trim() || null,
      uom: uom.trim(),
      stockGroupId,
      sellingPrice,
      active,
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate();
  };

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <div className="flex items-center justify-center py-8">Loading...</div>
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
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
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
                <div className="mt-2 p-2 bg-muted rounded text-sm">
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
