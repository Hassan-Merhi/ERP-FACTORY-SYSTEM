import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { Location as LocationType } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

import type {
  CodeAlias,
  StockCategory,
  StockGrade,
  StockGroup,
  StockItem,
  StockItemDetailsDialogProps,
  Transaction,
} from "./types";

interface LocationPrice {
  id: number;
  locationId: number;
  locationName: string;
  sellingPrice: string;
}

type TransactionUpdates = Partial<Pick<Transaction, "stockItemId" | "quantity" | "rate">>;

export function useStockItemDetailsDialog({
  open,
  onOpenChange,
  stockItemId,
  stockItemName,
}: StockItemDetailsDialogProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [editedCode, setEditedCode] = useState("");
  const [editedName, setEditedName] = useState("");
  const [editedBarcode, setEditedBarcode] = useState("");
  const [editedUom, setEditedUom] = useState("");
  const [editedStockGroupId, setEditedStockGroupId] = useState<number | null>(null);
  const [editedGradeId, setEditedGradeId] = useState<number | null>(null);
  const [editedCategoryId, setEditedCategoryId] = useState<number | null>(null);
  const [editedSellingPrice, setEditedSellingPrice] = useState("");

  const [editingTransaction, setEditingTransaction] = useState<number | null>(null);
  const [editedStockItemId, setEditedStockItemId] = useState<number | null>(null);
  const [editedQuantity, setEditedQuantity] = useState("");
  const [editedRate, setEditedRate] = useState("");

  const [newAliasCode, setNewAliasCode] = useState("");
  const [newAliasDescription, setNewAliasDescription] = useState("");

  const [newLocationId, setNewLocationId] = useState("");
  const [newLocationPrice, setNewLocationPrice] = useState("");
  const [editingLocationPriceId, setEditingLocationPriceId] = useState<number | null>(null);

  const { data: stockItem, isLoading: loadingItem } = useQuery<StockItem>({
    queryKey: [`/api/stock-items/${stockItemId}`],
    enabled: open,
  });

  const { data: stockGroups = [] } = useQuery<StockGroup[]>({
    queryKey: ["/api/stock-groups"],
    enabled: open,
  });

  const { data: stockGrades = [] } = useQuery<StockGrade[]>({
    queryKey: ["/api/stock-grades", { includeInactive: true }],
    queryFn: async () => {
      const res = await fetch("/api/stock-grades?includeInactive=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load grades");
      return res.json();
    },
    enabled: open,
  });

  const { data: stockCategories = [] } = useQuery<StockCategory[]>({
    queryKey: ["/api/stock-categories", { includeInactive: true }],
    queryFn: async () => {
      const res = await fetch("/api/stock-categories?includeInactive=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load categories");
      return res.json();
    },
    enabled: open,
  });

  const { data: allStockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    enabled: open && editingTransaction !== null,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: transactions = [], isLoading: loadingTransactions } = useQuery<Transaction[]>({
    queryKey: [`/api/stock-items/${stockItemId}/voucher-history`],
    enabled: open,
  });

  const { data: codeAliases = [], isLoading: loadingAliases } = useQuery<CodeAlias[]>({
    queryKey: [`/api/stock-items/${stockItemId}/code-aliases`],
    enabled: open,
  });

  const { data: locations = [] } = useQuery<LocationType[]>({
    queryKey: ["/api/locations"],
    enabled: open,
  });

  const { data: locationPrices = [], isLoading: loadingLocationPrices } = useQuery<LocationPrice[]>({
    queryKey: [`/api/stock-items/${stockItemId}/location-prices`],
    enabled: open,
  });

  const updateItemMutation = useMutation({
    mutationFn: async (updates: Partial<StockItem>) => {
      const response = await apiRequest("PATCH", `/api/stock-items/${stockItemId}`, updates);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setIsEditingDetails(false);
      toast({
        title: "Stock Item Updated",
        description: "Stock item details updated successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update stock item",
        variant: "destructive",
      });
    },
  });

  const updateTransactionMutation = useMutation({
    mutationFn: async ({ id, type, updates }: { id: number; type: string; updates: TransactionUpdates }) => {
      const endpoint = type === "transfer" ? `/api/stock-transfer-items/${id}` : `/api/stock-adjustment-items/${id}`;
      const response = await apiRequest("PATCH", endpoint, updates);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}/voucher-history`] });
      setEditingTransaction(null);
      toast({
        title: "Transaction Updated",
        description: "Transaction updated successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update transaction",
        variant: "destructive",
      });
    },
  });

  const createAliasMutation = useMutation({
    mutationFn: async (aliasData: { aliasCode: string; description?: string }) => {
      const response = await apiRequest("POST", `/api/stock-items/${stockItemId}/code-aliases`, aliasData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}/code-aliases`] });
      setNewAliasCode("");
      setNewAliasDescription("");
      toast({
        title: "Alias Created",
        description: "Code alias created successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Creation Failed",
        description: error.message || "Failed to create code alias",
        variant: "destructive",
      });
    },
  });

  const deleteAliasMutation = useMutation({
    mutationFn: async (aliasId: number) => {
      await apiRequest("DELETE", `/api/stock-item-code-aliases/${aliasId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}/code-aliases`] });
      toast({
        title: "Alias Deleted",
        description: "Code alias deleted successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete code alias",
        variant: "destructive",
      });
    },
  });

  const upsertLocationPriceMutation = useMutation({
    mutationFn: async (data: { locationId: number; sellingPrice: string }) => {
      return apiRequest("POST", `/api/stock-items/${stockItemId}/location-prices`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}/location-prices`] });
      setNewLocationId("");
      setNewLocationPrice("");
      setEditingLocationPriceId(null);
      toast({
        title: "Success",
        description: "Location price saved successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Failed",
        description: error.message || "Failed to save location price",
        variant: "destructive",
      });
    },
  });

  const deleteLocationPriceMutation = useMutation({
    mutationFn: async (priceId: number) => {
      await apiRequest("DELETE", `/api/stock-item-location-prices/${priceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stock-items/${stockItemId}/location-prices`] });
      toast({
        title: "Deleted",
        description: "Location price deleted successfully",
      });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete location price",
        variant: "destructive",
      });
    },
  });

  const handleEditDetails = () => {
    if (!stockItem) return;
    setEditedCode(stockItem.code);
    setEditedName(stockItem.name);
    setEditedBarcode(stockItem.barcode || "");
    setEditedUom(stockItem.uom);
    setEditedStockGroupId(stockItem.stockGroupId);
    setEditedGradeId(stockItem.gradeId ?? null);
    setEditedCategoryId(stockItem.categoryId ?? null);
    setEditedSellingPrice(stockItem.sellingPrice || "0");
    setIsEditingDetails(true);
  };

  const handleSaveDetails = () => {
    if (!editedCode || editedCode.trim() === "") {
      toast({ title: "Validation Error", description: "Code is required", variant: "destructive" });
      return;
    }
    if (!editedName || editedName.trim() === "") {
      toast({ title: "Validation Error", description: "Name is required", variant: "destructive" });
      return;
    }
    if (!editedUom || editedUom.trim() === "") {
      toast({ title: "Validation Error", description: "Unit of measure is required", variant: "destructive" });
      return;
    }

    updateItemMutation.mutate({
      code: editedCode.trim(),
      name: editedName.trim(),
      barcode: editedBarcode?.trim() || null,
      uom: editedUom.trim(),
      stockGroupId: editedStockGroupId,
      gradeId: editedGradeId,
      categoryId: editedCategoryId,
      sellingPrice: editedSellingPrice || "0",
    });
  };

  const handleEditTransaction = (transaction: Transaction) => {
    setEditingTransaction(transaction.id);
    setEditedStockItemId(transaction.stockItemId);
    setEditedQuantity(transaction.quantity);
    setEditedRate(transaction.rate);
  };

  const handleSaveTransaction = (transaction: Transaction) => {
    if (!editedStockItemId) {
      toast({ title: "Validation Error", description: "Stock item is required", variant: "destructive" });
      return;
    }
    if (!editedQuantity || editedQuantity.trim() === "" || isNaN(parseFloat(editedQuantity))) {
      toast({ title: "Validation Error", description: "Valid quantity is required", variant: "destructive" });
      return;
    }
    if (!editedRate || editedRate.trim() === "" || isNaN(parseFloat(editedRate))) {
      toast({ title: "Validation Error", description: "Valid rate is required", variant: "destructive" });
      return;
    }

    const updates: TransactionUpdates = {};
    if (editedStockItemId !== transaction.stockItemId) updates.stockItemId = editedStockItemId;
    if (editedQuantity !== transaction.quantity) updates.quantity = editedQuantity;
    if (editedRate !== transaction.rate) updates.rate = editedRate;

    updateTransactionMutation.mutate({ id: transaction.id, type: transaction.type, updates });
  };

  const handleCancelTransactionEdit = () => {
    setEditingTransaction(null);
    setEditedStockItemId(null);
    setEditedQuantity("");
    setEditedRate("");
  };

  const handleAddAlias = () => {
    if (!newAliasCode || newAliasCode.trim() === "") {
      toast({ title: "Validation Error", description: "Alias code is required", variant: "destructive" });
      return;
    }

    createAliasMutation.mutate({
      aliasCode: newAliasCode.trim(),
      description: newAliasDescription.trim() || undefined,
    });
  };

  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);

  const handleDeleteAlias = (aliasId: number) => {
    setPendingDelete(() => () => deleteAliasMutation.mutate(aliasId));
  };

  return {
    open,
    onOpenChange,
    stockItemName,
    toast,
    navigate,
    isEditingDetails,
    setIsEditingDetails,
    editedCode,
    setEditedCode,
    editedName,
    setEditedName,
    editedUom,
    setEditedUom,
    editedStockGroupId,
    setEditedStockGroupId,
    editedCategoryId,
    setEditedCategoryId,
    editingTransaction,
    editedStockItemId,
    setEditedStockItemId,
    editedQuantity,
    setEditedQuantity,
    editedRate,
    setEditedRate,
    newAliasCode,
    setNewAliasCode,
    newAliasDescription,
    setNewAliasDescription,
    newLocationId,
    setNewLocationId,
    newLocationPrice,
    setNewLocationPrice,
    editingLocationPriceId,
    setEditingLocationPriceId,
    stockItem,
    loadingItem,
    stockGroups,
    stockGrades,
    stockCategories,
    allStockItems,
    transactions,
    loadingTransactions,
    codeAliases,
    loadingAliases,
    locations,
    locationPrices,
    loadingLocationPrices,
    updateItemMutation,
    updateTransactionMutation,
    createAliasMutation,
    deleteAliasMutation,
    upsertLocationPriceMutation,
    deleteLocationPriceMutation,
    handleEditDetails,
    handleSaveDetails,
    handleEditTransaction,
    handleSaveTransaction,
    handleCancelTransactionEdit,
    handleAddAlias,
    pendingDelete,
    setPendingDelete,
    handleDeleteAlias,
  };
}
