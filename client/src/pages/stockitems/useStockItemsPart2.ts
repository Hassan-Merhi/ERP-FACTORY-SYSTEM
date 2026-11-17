// Extracted from ./useStockItems.ts to keep that module under the source-size cap.
import type { MouseEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { apiRequest, queryClient } from "@/lib/queryClient";
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
  const { selectedCompany } = useCompany();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hideStockRates = (myErpPages?.hiddenErpCostFields ?? []).includes("stock_rates");

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

  const exportToExcel = async () => {
    if (exportingStockItems) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    setExportingStockItems(true);
    try {
      // Do not request or serialize hidden prices while the page-access
      // response is still loading or this user's stock rate field is hidden.
      const allowStockRates = myErpPages !== undefined && !hideStockRates;
      const [allItems, pricesRes, costDubaiRes, aliasesRes] = await Promise.all([
        loadStockItemsForExport({
          search: searchTerm,
          stockGroupId: selectedGroupFilter,
          gradeId: selectedGradeFilter,
          categoryId: selectedCategoryFilter,
        }),
        allowStockRates
          ? fetch("/api/stock-item-location-prices/all", { credentials: "include" })
          : Promise.resolve(null),
        allowStockRates ? fetch("/api/stock-items/cost-dubai", { credentials: "include" }) : Promise.resolve(null),
        fetch("/api/stock-items/all-code-aliases", { credentials: "include" }),
      ]);
      if (!aliasesRes.ok || (allowStockRates && (!pricesRes?.ok || !costDubaiRes?.ok))) {
        throw new Error("Failed to fetch stock item pricing or aliases");
      }
      if (allItems.length === 0) {
        toast({ title: "No stock items", description: "No items match the current filters." });
        return;
      }
      const locationPrices: {
        stockItemId: number;
        locationId: number;
        locationName: string;
        sellingPrice: string;
      }[] = pricesRes ? await pricesRes.json() : [];
      const costDubaiData: { stockItemId: number; costDubai: string }[] = costDubaiRes ? await costDubaiRes.json() : [];
      const aliasData: { stockItemId: number; aliasCode: string }[] = await aliasesRes.json();

      const costDubaiMap = new Map<number, string>();
      for (const cost of costDubaiData) costDubaiMap.set(cost.stockItemId, cost.costDubai);
      const priceMap = new Map<number, Record<string, string>>();
      for (const price of locationPrices) {
        let itemPrices = priceMap.get(price.stockItemId);
        if (!itemPrices) {
          itemPrices = {};
          priceMap.set(price.stockItemId, itemPrices);
        }
        itemPrices[String(price.locationId)] = price.sellingPrice;
      }
      const aliasMap = new Map<number, string[]>();
      for (const alias of aliasData) {
        if (!aliasMap.has(alias.stockItemId)) aliasMap.set(alias.stockItemId, []);
        aliasMap.get(alias.stockItemId)!.push(alias.aliasCode);
      }

      const { buildStockItemReportColumns } = await import("@shared/universal-excel/reportSchemas");
      const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const data = allItems.map((item) => ({
        code: item.code,
        name: item.name,
        barcode: item.barcode || "",
        aliasCodes: (aliasMap.get(item.id) ?? []).join(", "),
        uom: item.uom,
        stockGroup: getStockGroupName(item.stockGroupId) ?? "— No Group —",
        grade: getGradeName(item.gradeId) || "",
        category: getCategoryName(item.categoryId) || "",
        defaultSellingPrice: allowStockRates ? item.sellingPrice || "0" : null,
        costDubai: allowStockRates ? (costDubaiMap.get(item.id) ?? null) : null,
        pricesByLocation: allowStockRates ? (priceMap.get(item.id) ?? {}) : {},
        active: item.active ? "Yes" : "No",
      }));
      await exportOperationalWorkbook({
        title: "Stock Items",
        fileName: "stock-items.xlsx",
        companyName: selectedCompany?.name,
        filters: [
          { label: "Search", value: searchTerm || "All" },
          { label: "Group", value: String(selectedGroupFilter ?? "All") },
          { label: "Grade", value: String(selectedGradeFilter ?? "All") },
          { label: "Category", value: String(selectedCategoryFilter ?? "All") },
        ],
        allowedColumnTags: allowStockRates ? ["stock-rates", "stock-cost"] : [],
        sheets: [
          {
            name: "Stock Items",
            columns: buildStockItemReportColumns(locations),
            rows: data,
          },
        ],
      });
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
