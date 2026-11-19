// Extracted from ./StockItemEditDialog.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface StockItemEditDialogProps {
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

export function useStockItemEditDialogState({
  open,
  onOpenChange,
  stockItemId,
}: Pick<StockItemEditDialogProps, "open" | "onOpenChange" | "stockItemId">) {
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
  return {
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
  };
}
