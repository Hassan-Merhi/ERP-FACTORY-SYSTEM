// Extracted from ./useStockItems.ts to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Location, PagedStockItemsResponse, StockCategory, StockGrade, StockGroup, StockItem } from "./types";
import { PAGE_SIZE } from "./utils";
import { useStockItemsFilters } from "./useStockItemsFilters";

export function useStockItemsPart1Part1() {
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
  const [exportingStockItems, setExportingStockItems] = useState(false);
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
      toast({ title: "Deleted", description: "Stock items deleted successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Delete failed",
        description: error.message || "Failed to delete stock items",
        variant: "destructive",
      });
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
      toast({ title: "Updated", description: "Stock adjusted successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Update failed", description: error.message || "Failed to adjust stock", variant: "destructive" });
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
      toast({ title: "Updated", description: "Category assigned successfully" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({
        title: "Update failed",
        description: error.message || "Failed to assign category",
        variant: "destructive",
      });
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
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
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
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
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
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });
  return {
    activeCount,
    adjustDialogOpen,
    adjustLocationId,
    adjustQuantity,
    adjustStockItemId,
    adjustStockMutation,
    adjustType,
    aliasMap,
    allStockItems,
    assignCategoryDialogOpen,
    assignCategoryMutation,
    createDialogOpen,
    createGradeMutation,
    currentPage,
    debouncedSearch,
    deleteDialogOpen,
    deleteGradeMutation,
    deleteMutation,
    detailsDialogOpen,
    displayItems,
    editDialogOpen,
    editStockItemId,
    editingCategoryId,
    editingCategoryName,
    editingGradeId,
    editingGradeName,
    error,
    exportingStockItems,
    formatAmount,
    hasActiveFilters,
    hideStockRates,
    importDialogOpen,
    inactiveCount,
    isError,
    isLoading,
    locations,
    manageCategoriesOpen,
    manageGradesOpen,
    myErpPages,
    newCategoryName,
    newGradeName,
    pendingCategoryId,
    refetch,
    refetchAllItems,
    resetFilters,
    searchTerm,
    selectedCategoryFilter,
    selectedCompany,
    selectedGradeFilter,
    selectedGroupFilter,
    selectedIds,
    selectedStockItemId,
    selectedStockItemName,
    setAdjustDialogOpen,
    setAdjustLocationId,
    setAdjustQuantity,
    setAdjustStockItemId,
    setAdjustType,
    setAssignCategoryDialogOpen,
    setCreateDialogOpen,
    setCurrentPage,
    setDeleteDialogOpen,
    setDetailsDialogOpen,
    setEditDialogOpen,
    setEditStockItemId,
    setEditingCategoryId,
    setEditingCategoryName,
    setEditingGradeId,
    setEditingGradeName,
    setExportingStockItems,
    setImportDialogOpen,
    setManageCategoriesOpen,
    setManageGradesOpen,
    setNewCategoryName,
    setNewGradeName,
    setPendingCategoryId,
    setSearchTerm,
    setSelectedCategoryFilter,
    setSelectedGradeFilter,
    setSelectedGroupFilter,
    setSelectedIds,
    setSelectedStockItemId,
    setSelectedStockItemName,
    stockCategories,
    stockGrades,
    stockGroups,
    toast,
    totalItems,
    totalPages,
    updateGradeMutation,
  };
}

export function useStockItemsPart1Part2({
  setNewCategoryName,
  toast,
}: Pick<Awaited<ReturnType<typeof useStockItemsPart1Part1>>, "setNewCategoryName" | "toast">) {
  const createCategoryMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/stock-categories", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-categories"] });
      setNewCategoryName("");
      toast({ title: "Category created" });
    },
    onError: (error: Error) => {
      if (error._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });
  return { createCategoryMutation };
}
