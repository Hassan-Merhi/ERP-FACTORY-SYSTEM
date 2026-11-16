// Extracted from ./useBaleProductsModel.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import type { FactoryBaleProduct, FactoryCategory } from "@shared/schema";
import type { ImportPreviewRow } from "./types";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";

export function useBaleProductsModelPart1() {
  const { selectedCompany } = useCompany();
  const { colors: designColors } = useLabelDesignColors();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [adminAuthOpen, setAdminAuthOpen] = useState(false);
  const [pendingAdminAuth, setPendingAdminAuth] = useState<{ username: string; password: string } | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importError, setImportError] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [condensedView] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showCategories, setShowCategories] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategory, setEditingCategory] = useState<{ id: number; name: string } | null>(null);
  const [editingProduct, setEditingProduct] = useState<FactoryBaleProduct | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    articleCode: "",
    weightPerBaleKg: "",
    categoryId: "",
    description: "",
    grade: "",
    productionPrice: "",
    sellingPrice: "",
    labelDesignColor: "",
  });
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [showZeroPrice, setShowZeroPrice] = useState(false);
  const [showNoColor, setShowNoColor] = useState(false);
  const [filterCategoryId, setFilterCategoryId] = useState<number | null>(null);
  const [filterWeight, setFilterWeight] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  useEffect(() => {
    if (editingProduct) {
      setEditForm({
        name: editingProduct.name || "",
        articleCode: editingProduct.articleCode || "",
        weightPerBaleKg: editingProduct.weightPerBaleKg ? String(editingProduct.weightPerBaleKg) : "",
        categoryId: editingProduct.categoryId ? String(editingProduct.categoryId) : "",
        description: editingProduct.description || "",
        grade: "",
        productionPrice:
          editingProduct.productionPrice && parseFloat(editingProduct.productionPrice) > 0
            ? String(parseFloat(editingProduct.productionPrice))
            : "",
        sellingPrice:
          editingProduct.sellingPrice && parseFloat(editingProduct.sellingPrice) > 0
            ? String(parseFloat(editingProduct.sellingPrice))
            : "",
        labelDesignColor: editingProduct.labelDesignColor || "",
      });
    }
  }, [editingProduct]);

  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdmin = ["Admin", "Owner", "Developer"].includes(currentUser?.currentRole ?? currentUser?.role ?? "");

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: factorySettingsData } = useQuery<{ hideAvgCost?: boolean; hideSellingPrice?: boolean }>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/settings", { credentials: "include" });
      return res.ok ? res.json() : {};
    },
  });
  const accessReady = Boolean(
    selectedCompany?.id && myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
  );
  const perUserHiddenBP = accessReady ? (myAccess?.hiddenCostFields ?? []) : [];
  const hideAvgRate =
    !accessReady ||
    myAccess?.hideAllCosts === true ||
    perUserHiddenBP.includes("inventory_avg_rate") ||
    perUserHiddenBP.includes("inventory_total_value") ||
    !!factorySettingsData?.hideAvgCost ||
    perUserHiddenBP.includes("hide_export_cost_price");
  const hideSellingPriceBP =
    !accessReady ||
    myAccess?.hideAllCosts === true ||
    !!factorySettingsData?.hideSellingPrice ||
    perUserHiddenBP.includes("inventory_sell_price") ||
    perUserHiddenBP.includes("inventory_sell_value") ||
    perUserHiddenBP.includes("hide_export_selling_price");

  const { data: products, isLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey("/api/factory/bale-products", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: categories } = useQuery<FactoryCategory[]>({
    queryKey: companyQueryKey("/api/factory/categories", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const categoryMap = new Map<number, string>();
  categories?.forEach((c) => categoryMap.set(c.id, c.name));

  const allActiveProducts = products?.filter((p) => p.active !== false);
  const noColorCount = allActiveProducts?.filter((p) => !p.labelDesignColor).length ?? 0;
  const distinctWeights = Array.from(
    new Set((allActiveProducts ?? []).map((p) => p.weightPerBaleKg).filter(Boolean) as string[])
  ).sort((a, b) => parseFloat(a) - parseFloat(b));
  const activeProducts = allActiveProducts
    ?.filter((p) => !showZeroPrice || parseFloat(p.sellingPrice || "0") === 0)
    ?.filter((p) => !showNoColor || !p.labelDesignColor)
    ?.filter((p) => filterCategoryId === null || p.categoryId === filterCategoryId)
    ?.filter((p) => filterWeight === null || String(p.weightPerBaleKg) === filterWeight)
    ?.filter((p) => productMatchesSearch(p, searchQuery));
  const hiddenProducts = products?.filter((p) => p.active === false);

  const toggleSelectId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (list: FactoryBaleProduct[]) => {
    const ids = list.map((p) => p.id);
    const allSelected = ids.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const selectedActiveIds = Array.from(selectedIds).filter((id) => activeProducts?.some((p) => p.id === id));
  const selectedHiddenIds = Array.from(selectedIds).filter((id) => hiddenProducts?.some((p) => p.id === id));

  const createCategoryMutation = useMutation({
    mutationFn: async (name: string) => {
      const response = await modeApiRequest("POST", "/api/factory/categories", { name });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      setNewCategoryName("");
      toast({ title: "Category created" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("PATCH", `/api/factory/categories/${id}`, { name });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingCategory(null);
      toast({ title: "Category updated" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("DELETE", `/api/factory/categories/${id}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      toast({ title: "Category deleted" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
  return {
    activeProducts,
    adminAuthOpen,
    categories,
    categoryMap,
    condensedView,
    createCategoryMutation,
    createDialogOpen,
    deleteCategoryMutation,
    designColors,
    distinctWeights,
    editForm,
    editingCategory,
    editingProduct,
    expandedCategories,
    expandedGroups,
    fileInputRef,
    filterCategoryId,
    filterWeight,
    hiddenProducts,
    hideAvgRate,
    hideSellingPriceBP,
    importDialogOpen,
    importError,
    importFile,
    importPreview,
    isAdmin,
    isLoading,
    modeApiRequest,
    newCategoryName,
    noColorCount,
    pendingAdminAuth,
    pendingDelete,
    products,
    recordChanges,
    searchQuery,
    selectedActiveIds,
    selectedHiddenIds,
    selectedIds,
    setAdminAuthOpen,
    setCreateDialogOpen,
    setEditForm,
    setEditingCategory,
    setEditingProduct,
    setExpandedCategories,
    setExpandedGroups,
    setFilterCategoryId,
    setFilterWeight,
    setImportDialogOpen,
    setImportError,
    setImportFile,
    setImportPreview,
    setNewCategoryName,
    setPendingAdminAuth,
    setPendingDelete,
    setSearchQuery,
    setSelectedIds,
    setShowCategories,
    setShowHidden,
    setShowNoColor,
    setShowZeroPrice,
    showCategories,
    showHidden,
    showNoColor,
    showZeroPrice,
    toast,
    toggleSelectAll,
    toggleSelectId,
    updateCategoryMutation,
  };
}
