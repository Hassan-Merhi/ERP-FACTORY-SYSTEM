import { useState, type MouseEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

import type { Location, PagedStockItemsResponse, StockCategory, StockGrade, StockGroup, StockItem } from "./types";
import { PAGE_SIZE } from "./utils";
import { useStockItemsFilters } from "./useStockItemsFilters";

export function useStockItems() {
  const { selectedCompany } = useCompany();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hideStockRates = (myErpPages?.hiddenErpCostFields ?? []).includes("stock_rates");

  // Filters persist per company for the session and reset pagination on every
  // change; the debounce lives inside the hook.
  const {
    filters: { searchTerm, selectedGroupFilter, selectedGradeFilter, selectedCategoryFilter },
    page: currentPage,
    setPage: setCurrentPage,
    resetFilters,
    hasActiveFilters,
    setSearchTerm,
    setSelectedGroupFilter,
    setSelectedGradeFilter,
    setSelectedCategoryFilter,
    debouncedSearch,
  } = useStockItemsFilters(selectedCompany?.id);

  const [selectedStockItemId, setSelectedStockItemId] = useState<number | null>(null);
  const [selectedStockItemName, setSelectedStockItemName] = useState("");
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editStockItemId, setEditStockItemId] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [assignCategoryDialogOpen, setAssignCategoryDialogOpen] = useState(false);
  const [pendingCategoryId, setPendingCategoryId] = useState("");

  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  const [adjustStockItemId, setAdjustStockItemId] = useState("");
  const [adjustLocationId, setAdjustLocationId] = useState("");
  const [adjustQuantity, setAdjustQuantity] = useState("");
  const [adjustType, setAdjustType] = useState<"add" | "subtract">("add");

  const [manageGradesOpen, setManageGradesOpen] = useState(false);
  const [newGradeName, setNewGradeName] = useState("");
  const [editingGradeId, setEditingGradeId] = useState<number | null>(null);
  const [editingGradeName, setEditingGradeName] = useState("");

  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");

  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();

  const pagedQueryKey = [
    "/api/stock-items",
    {
      page: currentPage,
      pageSize: PAGE_SIZE,
      search: debouncedSearch,
      stockGroupId: selectedGroupFilter,
      gradeId: selectedGradeFilter,
      categoryId: selectedCategoryFilter,
    },
  ];

  const {
    data: pagedData,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<PagedStockItemsResponse>({
    queryKey: pagedQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(currentPage), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (selectedGroupFilter !== null) params.set("stockGroupId", String(selectedGroupFilter));
      if (selectedGradeFilter !== null) params.set("gradeId", String(selectedGradeFilter));
      if (selectedCategoryFilter !== null) params.set("categoryId", String(selectedCategoryFilter));
      const res = await fetch(`/api/stock-items?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stock items");
      return res.json();
    },
  });

  const displayItems: StockItem[] = pagedData?.data ?? [];
  const totalItems = pagedData?.total ?? 0;
  const totalPages = pagedData?.totalPages ?? 1;

  const { data: allStockItems = [], refetch: refetchAllItems } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items"],
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });

  const { data: stockGroups = [] } = useQuery<StockGroup[]>({ queryKey: ["/api/stock-groups"] });
  const { data: stockGrades = [] } = useQuery<StockGrade[]>({ queryKey: ["/api/stock-grades"] });
  const { data: stockCategories = [] } = useQuery<StockCategory[]>({ queryKey: ["/api/stock-categories"] });
  const { data: locations = [] } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data: allAliasesRaw = [] } = useQuery<{ stockItemId: number; aliasCode: string }[]>({
    queryKey: ["/api/stock-items/all-code-aliases"],
    queryFn: async () => {
      const res = await fetch("/api/stock-items/all-code-aliases", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const aliasMap = new Map<number, string[]>();
  for (const alias of allAliasesRaw) {
    if (!aliasMap.has(alias.stockItemId)) aliasMap.set(alias.stockItemId, []);
    aliasMap.get(alias.stockItemId)!.push(alias.aliasCode);
  }

  const activeCount = displayItems.filter((item) => item.active).length;
  const inactiveCount = displayItems.filter((item) => !item.active).length;

  const deleteMutation = useMutation({
    mutationFn: async (ids: number[]) => apiRequest("POST", "/api/stock-items/bulk-delete", { ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setSelectedIds([]);
      toast({ title: "Success", description: "Stock items deleted successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to delete stock items", variant: "destructive" });
    },
  });

  const adjustStockMutation = useMutation({
    mutationFn: async (data: { stockItemId: number; locationId: number; quantity: number; type: "add" | "subtract" }) =>
      apiRequest("POST", "/api/inventory/quick-adjust", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setAdjustDialogOpen(false);
      setAdjustStockItemId("");
      setAdjustLocationId("");
      setAdjustQuantity("");
      setAdjustType("add");
      toast({ title: "Success", description: "Stock adjusted successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to adjust stock", variant: "destructive" });
    },
  });

  const assignCategoryMutation = useMutation({
    mutationFn: async ({ ids, categoryId }: { ids: number[]; categoryId: number | null }) =>
      apiRequest("POST", "/api/stock-items/bulk-assign-category", { ids, categoryId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setSelectedIds([]);
      setAssignCategoryDialogOpen(false);
      setPendingCategoryId("");
      toast({ title: "Success", description: "Category assigned successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to assign category", variant: "destructive" });
    },
  });

  const createGradeMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/stock-grades", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-grades"] });
      setNewGradeName("");
      toast({ title: "Grade created" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateGradeMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) =>
      apiRequest("PATCH", `/api/stock-grades/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-grades"] });
      setEditingGradeId(null);
      setEditingGradeName("");
      toast({ title: "Grade updated" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteGradeMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/stock-grades/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-grades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({ title: "Grade deleted" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createCategoryMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/stock-categories", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-categories"] });
      setNewCategoryName("");
      toast({ title: "Category created" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      await writeFile(workbook, "stock-items-sales-history.xlsx");
    } catch {
      toast({ title: "Export failed", description: "Could not export sales history", variant: "destructive" });
    }
  };

  const exportToExcel = async () => {
    try {
      const [allRes, pricesRes, costDubaiRes, aliasesRes] = await Promise.all([
        fetch("/api/stock-items", { credentials: "include" }),
        fetch("/api/stock-item-location-prices/all", { credentials: "include" }),
        fetch("/api/stock-items/cost-dubai", { credentials: "include" }),
        fetch("/api/stock-items/all-code-aliases", { credentials: "include" }),
      ]);
      const allItems: StockItem[] = allRes.ok ? await allRes.json() : [];
      const locationPrices: { stockItemId: number; locationId: number; locationName: string; sellingPrice: string }[] =
        pricesRes.ok ? await pricesRes.json() : [];
      const costDubaiData: { stockItemId: number; costDubai: string }[] = costDubaiRes.ok
        ? await costDubaiRes.json()
        : [];
      const aliasData: { stockItemId: number; aliasCode: string }[] = aliasesRes.ok ? await aliasesRes.json() : [];

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
      await writeFile(workbook, "stock-items.xlsx");
    } catch {
      toast({ title: "Export failed", description: "Could not export stock items", variant: "destructive" });
    }
  };

  return {
    hideStockRates,
    searchTerm,
    setSearchTerm,
    debouncedSearch,
    selectedGroupFilter,
    setSelectedGroupFilter,
    selectedGradeFilter,
    setSelectedGradeFilter,
    selectedCategoryFilter,
    setSelectedCategoryFilter,
    resetFilters,
    hasActiveFilters,
    currentPage,
    setCurrentPage,
    selectedStockItemId,
    selectedStockItemName,
    detailsDialogOpen,
    setDetailsDialogOpen,
    editDialogOpen,
    setEditDialogOpen,
    editStockItemId,
    createDialogOpen,
    setCreateDialogOpen,
    selectedIds,
    setSelectedIds,
    deleteDialogOpen,
    setDeleteDialogOpen,
    importDialogOpen,
    setImportDialogOpen,
    assignCategoryDialogOpen,
    setAssignCategoryDialogOpen,
    pendingCategoryId,
    setPendingCategoryId,
    adjustDialogOpen,
    setAdjustDialogOpen,
    adjustStockItemId,
    setAdjustStockItemId,
    adjustLocationId,
    setAdjustLocationId,
    adjustQuantity,
    setAdjustQuantity,
    adjustType,
    setAdjustType,
    manageGradesOpen,
    setManageGradesOpen,
    newGradeName,
    setNewGradeName,
    editingGradeId,
    setEditingGradeId,
    editingGradeName,
    setEditingGradeName,
    manageCategoriesOpen,
    setManageCategoriesOpen,
    newCategoryName,
    setNewCategoryName,
    editingCategoryId,
    setEditingCategoryId,
    editingCategoryName,
    setEditingCategoryName,
    toast,
    formatAmount,
    displayItems,
    totalItems,
    totalPages,
    allStockItems,
    refetchAllItems,
    stockGroups,
    stockGrades,
    stockCategories,
    locations,
    aliasMap,
    activeCount,
    inactiveCount,
    isLoading,
    isError,
    error,
    refetch,
    deleteMutation,
    adjustStockMutation,
    assignCategoryMutation,
    createGradeMutation,
    updateGradeMutation,
    deleteGradeMutation,
    createCategoryMutation,
    updateCategoryMutation,
    deleteCategoryMutation,
    handleAdjustStock,
    handleSelectAll,
    handleSelectItem,
    allPageSelected,
    getStockGroupName,
    getGradeName,
    getCategoryName,
    handleStockItemClick,
    handleEditClick,
    exportSalesHistory,
    exportToExcel,
  };
}
