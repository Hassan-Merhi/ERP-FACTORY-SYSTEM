// Extracted from ./useStockItems.ts to keep that module under the source-size cap.
import type { MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useStockItemsPart1 } from "./useStockItemsPart1";

export function useStockItemsPart2({
  adjustLocationId,
  adjustQuantity,
  adjustStockItemId,
  adjustStockMutation,
  adjustType,
  displayItems,
  selectedCompany,
  selectedIds,
  setDetailsDialogOpen,
  setEditDialogOpen,
  setEditStockItemId,
  setEditingCategoryId,
  setEditingCategoryName,
  setSelectedIds,
  setSelectedStockItemId,
  setSelectedStockItemName,
  stockCategories,
  stockGrades,
  stockGroups,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useStockItemsPart1>>,
  | "adjustLocationId"
  | "adjustQuantity"
  | "adjustStockItemId"
  | "adjustStockMutation"
  | "adjustType"
  | "displayItems"
  | "selectedCompany"
  | "selectedIds"
  | "setDetailsDialogOpen"
  | "setEditDialogOpen"
  | "setEditStockItemId"
  | "setEditingCategoryId"
  | "setEditingCategoryName"
  | "setSelectedIds"
  | "setSelectedStockItemId"
  | "setSelectedStockItemName"
  | "stockCategories"
  | "stockGrades"
  | "stockGroups"
  | "toast"
>) {
  const updateCategoryMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) =>
      apiRequest("PATCH", `/api/stock-categories/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-categories"] });
      setEditingCategoryId(null);
      setEditingCategoryName("");
      toast({ title: "Category updated" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/stock-categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({ title: "Category deleted" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const handleAdjustStock = () => {
    if (!adjustStockItemId || !adjustLocationId || !adjustQuantity) {
      toast({ title: "Missing information", description: "Please fill in all fields", variant: "destructive" });
      return;
    }
    const quantity = parseFloat(adjustQuantity);
    if (isNaN(quantity) || quantity <= 0) {
      toast({
        title: "Validation failed",
        description: "Please enter a valid quantity greater than 0",
        variant: "destructive",
      });
      return;
    }
    adjustStockMutation.mutate({
      stockItemId: parseInt(adjustStockItemId),
      locationId: parseInt(adjustLocationId),
      quantity,
      type: adjustType,
    });
  };

  const handleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? displayItems.map((item) => item.id) : []);
  };

  const handleSelectItem = (id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((itemId) => itemId !== id)));
  };

  const allPageSelected = displayItems.length > 0 && displayItems.every((item) => selectedIds.includes(item.id));

  const getStockGroupName = (stockGroupId: number | null) => {
    if (!stockGroupId) return null;
    return stockGroups.find((group) => group.id === stockGroupId)?.name ?? null;
  };

  const getGradeName = (gradeId: number | null) => {
    if (!gradeId) return null;
    return stockGrades.find((grade) => grade.id === gradeId)?.name ?? null;
  };

  const getCategoryName = (categoryId: number | null) => {
    if (!categoryId) return null;
    return stockCategories.find((category) => category.id === categoryId)?.name ?? null;
  };

  const handleStockItemClick = (id: number, name: string) => {
    setSelectedStockItemId(id);
    setSelectedStockItemName(name);
    setDetailsDialogOpen(true);
  };

  const handleEditClick = (id: number, event: MouseEvent) => {
    event.stopPropagation();
    setEditStockItemId(id);
    setEditDialogOpen(true);
  };

  const exportSalesHistory = async () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch("/api/stock-items/last-sales-export", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales history");
      const rows: {
        stockItemId: number;
        itemCode: string;
        itemName: string;
        voucherNumber: string;
        voucherDate: string;
        locationName: string;
        quantity: string;
        rate: string;
        amount: string;
        rn: number;
      }[] = await res.json();
      if (rows.length === 0) {
        toast({ title: "No sales data", description: "No sales history found for any item." });
        return;
      }
      const data: Record<string, string>[] = [];
      let lastItemId: number | null = null;
      for (const row of rows) {
        if (lastItemId !== null && row.stockItemId !== lastItemId) data.push({});
        lastItemId = row.stockItemId;
        data.push({
          "Item Code": row.itemCode,
          "Item Name": row.itemName,
          "Sale #": String(row.rn),
          "Voucher No.": row.voucherNumber || "",
          Date: row.voucherDate ? new Date(row.voucherDate).toLocaleDateString() : "",
          Location: row.locationName || "",
          Qty: row.quantity ? parseFloat(row.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "",
          Rate: row.rate
            ? parseFloat(row.rate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "",
          Amount: row.amount
            ? parseFloat(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "",
        });
      }
      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      await exportOperationalWorkbook({
        title: "Stock Items — Sales History",
        fileName: "stock-items-sales-history.xlsx",
        companyName: selectedCompany?.name,
        sheets: [
          {
            name: "Sales History",
            columns: columnsFromOperationalRows(data, {
              orderedHeaders: [
                "Item Code",
                "Item Name",
                "Sale #",
                "Voucher No.",
                "Date",
                "Location",
                "Qty",
                "Rate",
                "Amount",
              ],
            }),
            rows: data,
          },
        ],
      });
    } catch {
      toast({ title: "Export failed", description: "Could not export sales history", variant: "destructive" });
    }
  };
  return {
    allPageSelected,
    deleteCategoryMutation,
    exportSalesHistory,
    getCategoryName,
    getGradeName,
    getStockGroupName,
    handleAdjustStock,
    handleEditClick,
    handleSelectAll,
    handleSelectItem,
    handleStockItemClick,
    updateCategoryMutation,
  };
}
