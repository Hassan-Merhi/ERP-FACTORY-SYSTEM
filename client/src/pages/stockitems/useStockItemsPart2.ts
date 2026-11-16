// Extracted from ./useStockItems.ts to keep that module under the source-size cap.
import type { MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { exportFileName } from "@/lib/exportFile";
import { loadStockItemsForExport } from "./stockItemsExport";
import { useStockItemsPart1 } from "./useStockItemsPart1";

export function useStockItemsPart2({
  adjustLocationId,
  adjustQuantity,
  adjustStockItemId,
  adjustStockMutation,
  adjustType,
  displayItems,
  exportingStockItems,
  formatAmount,
  locations,
  searchTerm,
  selectedCategoryFilter,
  selectedGradeFilter,
  selectedGroupFilter,
  selectedIds,
  setDetailsDialogOpen,
  setEditDialogOpen,
  setEditStockItemId,
  setExportingStockItems,
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
  | "exportingStockItems"
  | "formatAmount"
  | "locations"
  | "searchTerm"
  | "selectedCategoryFilter"
  | "selectedGradeFilter"
  | "selectedGroupFilter"
  | "selectedIds"
  | "setDetailsDialogOpen"
  | "setEditDialogOpen"
  | "setEditStockItemId"
  | "setExportingStockItems"
  | "setSelectedIds"
  | "setSelectedStockItemId"
  | "setSelectedStockItemName"
  | "stockCategories"
  | "stockGrades"
  | "stockGroups"
  | "toast"
>) {
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleAdjustStock = () => {
    if (!adjustStockItemId || !adjustLocationId || !adjustQuantity) {
      toast({ title: "Error", description: "Please fill in all fields", variant: "destructive" });
      return;
    }
    const quantity = parseFloat(adjustQuantity);
    if (isNaN(quantity) || quantity <= 0) {
      toast({ title: "Error", description: "Please enter a valid quantity greater than 0", variant: "destructive" });
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
      const { utils, writeFile } = await import("@/lib/excelHelper");
      const worksheet = utils.json_to_sheet(data);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Sales History");
      await writeFile(workbook, exportFileName("stock items sales history", "xlsx"));
    } catch {
      toast({ title: "Export failed", description: "Could not export sales history", variant: "destructive" });
    }
  };

  const exportToExcel = async () => {
    if (exportingStockItems) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    setExportingStockItems(true);
    try {
      const [allItems, pricesRes, costDubaiRes, aliasesRes] = await Promise.all([
        loadStockItemsForExport({
          search: searchTerm,
          stockGroupId: selectedGroupFilter,
          gradeId: selectedGradeFilter,
          categoryId: selectedCategoryFilter,
        }),
        fetch("/api/stock-item-location-prices/all", { credentials: "include" }),
        fetch("/api/stock-items/cost-dubai", { credentials: "include" }),
        fetch("/api/stock-items/all-code-aliases", { credentials: "include" }),
      ]);
      if (!pricesRes.ok || !costDubaiRes.ok || !aliasesRes.ok) {
        throw new Error("Failed to fetch stock item pricing or aliases");
      }
      if (allItems.length === 0) {
        toast({ title: "No stock items", description: "No items match the current filters." });
        return;
      }
      const locationPrices: { stockItemId: number; locationId: number; locationName: string; sellingPrice: string }[] =
        await pricesRes.json();
      const costDubaiData: { stockItemId: number; costDubai: string }[] = await costDubaiRes.json();
      const aliasData: { stockItemId: number; aliasCode: string }[] = await aliasesRes.json();

      const costDubaiMap = new Map<number, string>();
      for (const costDubai of costDubaiData) costDubaiMap.set(costDubai.stockItemId, costDubai.costDubai);

      const priceMap = new Map<number, Map<string, string>>();
      for (const locationPrice of locationPrices) {
        if (!priceMap.has(locationPrice.stockItemId)) priceMap.set(locationPrice.stockItemId, new Map());
        priceMap.get(locationPrice.stockItemId)!.set(locationPrice.locationName, locationPrice.sellingPrice);
      }

      const exportAliasMap = new Map<number, string[]>();
      for (const alias of aliasData) {
        if (!exportAliasMap.has(alias.stockItemId)) exportAliasMap.set(alias.stockItemId, []);
        exportAliasMap.get(alias.stockItemId)!.push(alias.aliasCode);
      }

      const sortedLocations = locations.map((location) => location.name).sort();
      const data = allItems.map((item) => {
        const costDubai = costDubaiMap.get(item.id);
        const defaultPrice = item.sellingPrice || "0";
        const itemAliases = exportAliasMap.get(item.id) ?? [];
        const row: Record<string, string> = {
          Code: item.code,
          Name: item.name,
          Barcode: item.barcode || "",
          "Alias Codes": itemAliases.join(", "),
          UOM: item.uom,
          "Stock Group": getStockGroupName(item.stockGroupId) ?? "— No Group —",
          Grade: getGradeName(item.gradeId) || "",
          Category: getCategoryName(item.categoryId) || "",
          "Default Selling Price": formatAmount(defaultPrice),
          "Cost Dubai": costDubai ? formatAmount(costDubai) : "",
        };
        for (const location of sortedLocations) {
          const locationPrice = priceMap.get(item.id)?.get(location);
          row[`Price - ${location}`] = formatAmount(locationPrice ?? defaultPrice);
        }
        row.Active = item.active ? "Yes" : "No";
        return row;
      });
      const { utils, writeFile } = await import("@/lib/excelHelper");
      const worksheet = utils.json_to_sheet(data);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Stock Items");
      await writeFile(workbook, exportFileName("stock items", "xlsx"));
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Could not export stock items",
        variant: "destructive",
      });
    } finally {
      setExportingStockItems(false);
    }
  };
  return {
    allPageSelected,
    deleteCategoryMutation,
    exportSalesHistory,
    exportToExcel,
    getCategoryName,
    getGradeName,
    getStockGroupName,
    handleAdjustStock,
    handleEditClick,
    handleSelectAll,
    handleSelectItem,
    handleStockItemClick,
  };
}
