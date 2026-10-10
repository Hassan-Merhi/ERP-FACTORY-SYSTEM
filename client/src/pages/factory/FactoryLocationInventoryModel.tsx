import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { apiRequest } from "@/lib/queryClient";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useReactToPrint } from "react-to-print";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type {
  CategoryGroup,
  Customer,
  CustomerProformaRecord,
  FactoryBaleProduct,
  FactoryProformaLine,
  Location,
  ProformaMutationResult,
  ProformaSelection,
  RemoveBalesResult,
  SortDir,
  SortField,
} from "./factorylocationinventory/types";
import { applySortProducts, isSpecialFactoryCategory } from "./factorylocationinventory/utils";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import { useFactoryLocationReprint } from "./factorylocationinventory/useFactoryLocationReprint";
import { buildActiveInventoryData } from "./factorylocationinventory/activeInventory";

export function useFactoryLocationInventory() {
  const { colors } = useLabelDesignColors();
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [locationSearch, setLocationSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [prodSortField, setProdSortField] = useState<SortField>("name");
  const [prodSortDir, setProdSortDir] = useState<SortDir>("asc");
  const [_loc, navigate] = useLocation();
  const printRef = useRef<HTMLDivElement>(null);
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [proformaMode, setProformaMode] = useState(false);
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [hideZeroAvailable, setHideZeroAvailable] = useState(true);
  const [selections, setSelections] = useState<Map<number, ProformaSelection>>(new Map());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [proformaAutoSave, setProformaAutoSave] = useState<boolean>(() => {
    try {
      return localStorage.getItem("proforma-inventory-autosave") === "true";
    } catch {
      return false;
    }
  });
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSilentAutoSaveRef = useRef(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [proformaName, setProformaName] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [savedProformaId, setSavedProformaId] = useState<number | null>(null);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renamingLocation, setRenamingLocation] = useState<Location | null>(null);
  const [renameInput, setRenameInput] = useState("");

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteProduct, setDeleteProduct] = useState<FactoryBaleProduct | null>(null);
  const [deleteQty, setDeleteQty] = useState(1);
  const [deleteSupervisorUser, setDeleteSupervisorUser] = useState("");
  const [deleteSupervisorPass, setDeleteSupervisorPass] = useState("");
  const [deleteReason, setDeleteReason] = useState("");

  const {
    reprintDialogOpen,
    setReprintDialogOpen,
    reprintProduct,
    setReprintProduct,
    reprintBales,
    setReprintBales,
    reprintLoading,
    reprintDesignPickerOpen,
    setReprintDesignPickerOpen,
    reprintPendingLabels,
    openBrowserReprintLabels,
    handleReprintProduct,
    handleDoPrint,
  } = useFactoryLocationReprint(selectedLocation);

  const [editingProformaId, setEditingProformaId] = useState<number | null>(null);
  const [editProformaLines, setEditProformaLines] = useState<FactoryProformaLine[]>([]);
  const [editModeInitialized, setEditModeInitialized] = useState(false);

  const [overloadWarning, setOverloadWarning] = useState<{
    open: boolean;
    items: Array<{ articleCode: string; productName: string; requested: number; available: number }>;
    pendingFn: (() => void) | null;
  }>({ open: false, items: [], pendingFn: null });

  const handlePrint = useReactToPrint({ contentRef: printRef });

  const { data: locations = [], isLoading: locationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: myAccess } = useQuery<{
    fullAccess: boolean;
    pageKeys: string[];
    hasErpAccess: boolean;
    hasFactoryAccess: boolean;
    hiddenCostFields: string[];
  }>({
    queryKey: ["/api/factory/my-access"],
  });

  const { data: factorySettingsData } = useQuery<{ hideSellingPrice?: boolean; hideAvgCost?: boolean }>({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const res = await fetch("/api/factory/settings", { credentials: "include" });
      return res.ok ? res.json() : {};
    },
  });
  const perUserHidden = myAccess?.hiddenCostFields ?? [];
  const hideSellingPrice =
    !!factorySettingsData?.hideSellingPrice ||
    perUserHidden.includes("inventory_sell_price") ||
    perUserHidden.includes("inventory_sell_value") ||
    perUserHidden.includes("hide_export_selling_price");
  const hideAvgCost =
    !!factorySettingsData?.hideAvgCost ||
    perUserHidden.includes("inventory_avg_rate") ||
    perUserHidden.includes("inventory_total_value") ||
    perUserHidden.includes("hide_export_cost_price");

  const { data: inventoryData = [], isLoading: inventoryLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: selectedLocation ? [`/api/factory/location-inventory/${selectedLocation.id}`] : [],
    queryFn: async () => {
      const response = await fetch(`/api/factory/location-inventory/${selectedLocation!.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch factory inventory");
      return response.json();
    },
    enabled: !!selectedLocation,
  });

  const { data: availableInventoryData = [], isLoading: availableLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: selectedLocation ? [`/api/factory/location-inventory/${selectedLocation.id}/available`] : [],
    queryFn: async () => {
      const response = await fetch(`/api/factory/location-inventory/${selectedLocation!.id}/available`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch available inventory");
      return response.json();
    },
    enabled: !!selectedLocation && proformaMode,
  });

  const { data: catalogBaleProducts = [] } = useQuery<
    Array<{
      id: number;
      articleCode: string | null;
      name: string;
      nameAr: string | null;
      sellingPrice: string | null;
      productionPrice: string | null;
      categoryId: number | null;
      active: boolean;
    }>
  >({
    queryKey: ["/api/factory/bale-products"],
    queryFn: async () => {
      const res = await fetch("/api/factory/bale-products", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch bale products catalog");
      return res.json();
    },
    enabled: proformaMode || showZeroStock,
  });

  const { data: catalogCategories = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ["/api/factory/categories"],
    queryFn: async () => {
      const res = await fetch("/api/factory/categories", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch categories");
      return res.json();
    },
    enabled: proformaMode || showZeroStock,
  });

  const activeInventoryData = useMemo(
    () =>
      buildActiveInventoryData({
        proformaMode,
        showZeroStock,
        hideZeroAvailable,
        availableInventoryData,
        inventoryData,
        catalogBaleProducts,
        catalogCategories,
      }),
    [
      proformaMode,
      showZeroStock,
      hideZeroAvailable,
      availableInventoryData,
      inventoryData,
      catalogBaleProducts,
      catalogCategories,
    ]
  );

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
    enabled: finalizeOpen,
  });

  const createCustomerMutation = useMutation({
    mutationFn: async (data: { legalName: string }) => {
      return await modeApiRequest("POST", "/api/factory/customers", data);
    },
    onSuccess: (newCustomer: Response) => {
      toast({ title: "Customer created" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      const newCustomerId = "id" in newCustomer ? newCustomer.id : undefined;
      setSelectedCustomerId(String(newCustomerId));
      setShowCreateCustomer(false);
      setNewCustomerName("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkCreateMutation = useMutation({
    mutationFn: async (data: {
      customerId: number;
      name: string;
      isActive: boolean;
      lines: FactoryProformaLine[];
    }): Promise<ProformaMutationResult> => {
      const res = await modeApiRequest("POST", "/api/factory/customer-proformas/bulk", data);
      return await res.json();
    },
    onSuccess: (result: ProformaMutationResult) => {
      setSavedProformaId(result.id);
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-proformas") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const replaceLinesMutation = useMutation({
    mutationFn: async (data: { id: number; lines: FactoryProformaLine[] }): Promise<ProformaMutationResult> => {
      const res = await modeApiRequest("PUT", `/api/factory/customer-proformas/${data.id}/replace-lines`, {
        lines: data.lines,
      });
      return await res.json();
    },
    onSuccess: (result: ProformaMutationResult) => {
      const silent = isSilentAutoSaveRef.current;
      isSilentAutoSaveRef.current = false;
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-proformas") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"] });
      setSavedProformaId(result.id);
      if (silent) {
        toast({ title: "Auto-saved", description: "Proforma saved automatically" });
      } else {
        toast({ title: "Proforma updated", description: "Lines saved successfully" });
        setTimeout(() => navigate("/factory/invoicing?tab=proformas"), 800);
      }
    },
    onError: (error: Error) => {
      isSilentAutoSaveRef.current = false;
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeBalesMutation = useMutation({
    mutationFn: async (data: {
      productId: number;
      locationId: number;
      qty: number;
      supervisorUsername: string;
      supervisorPassword: string;
      reason: string;
    }) => {
      const res = await modeApiRequest("POST", "/api/factory/stock-entry/remove-by-product", data);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed to remove bales");
      return json;
    },
    onSuccess: (result: RemoveBalesResult) => {
      toast({ title: "Removed", description: `${result.removed} bale(s) removed from stock.` });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/location-inventory/${selectedLocation?.id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
      setDeleteDialogOpen(false);
      setDeleteProduct(null);
      setDeleteQty(1);
      setDeleteSupervisorUser("");
      setDeleteSupervisorPass("");
      setDeleteReason("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const renameLocationMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await apiRequest("PATCH", `/api/locations/${id}`, { name });
      return res.json();
    },
    onSuccess: (updated) => {
      toast({ title: "Location renamed", description: `Renamed to "${updated.name}".` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      if (selectedLocation?.id === updated.id) {
        setSelectedLocation(updated);
      }
      setRenameDialogOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const openRenameDialog = (loc: Location, e?: { stopPropagation: () => void }) => {
    e?.stopPropagation();
    setRenamingLocation(loc);
    setRenameInput(loc.name);
    setRenameDialogOpen(true);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const editId = params.get("editProformaId");
    const editName = params.get("editProformaName");
    const editCustId = params.get("editCustomerId");
    if (editId && editName && editCustId) {
      const proformaId = parseInt(editId);
      setEditingProformaId(proformaId);
      setProformaName(decodeURIComponent(editName));
      setSelectedCustomerId(editCustId);
      setProformaMode(true);
      fetch(`/api/factory/customer-proformas?customerId=${editCustId}`, { credentials: "include" })
        .then((r) => r.json())
        .then((proformas: CustomerProformaRecord[]) => {
          const found = proformas.find((proforma) => proforma.id === proformaId);
          if (found?.lines?.length) {
            setEditProformaLines(
              found.lines.map((line) => ({
                articleCode: line.articleCode,
                quantity: line.quantity,
                pricePerBale: line.pricePerBale,
                productName: line.productName,
              }))
            );
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (
      !editingProformaId ||
      editProformaLines.length === 0 ||
      !selectedLocation ||
      inventoryLoading ||
      editModeInitialized
    )
      return;
    const productByArticleCode = new Map<string, FactoryBaleProduct>();
    inventoryData.forEach((product) => {
      productByArticleCode.set((product.articleCode || "").toLowerCase(), product);
    });
    const newSelections = new Map<number, ProformaSelection>();
    editProformaLines.forEach((line, index) => {
      const prod = productByArticleCode.get((line.articleCode || "").toLowerCase());
      if (prod) {
        newSelections.set(prod.productId, {
          productId: prod.productId,
          articleCode: prod.articleCode,
          productName: prod.productName,
          availableBales: prod.baleCount,
          totalWeight: prod.totalWeight,
          selectedQty: line.quantity,
          pricePerBale: line.pricePerBale,
        });
      } else {
        const syntheticId = -(index + 1);
        newSelections.set(syntheticId, {
          productId: syntheticId,
          articleCode: line.articleCode,
          productName: line.productName || line.articleCode,
          availableBales: 0,
          totalWeight: 0,
          selectedQty: line.quantity,
          pricePerBale: line.pricePerBale,
        });
      }
    });
    if (newSelections.size > 0) setSelections(newSelections);
    setEditModeInitialized(true);
  }, [editingProformaId, editProformaLines, selectedLocation, inventoryData, inventoryLoading, editModeInitialized]);

  const categoryGroups: CategoryGroup[] = activeInventoryData.reduce((groups, item) => {
    const catId = item.categoryId || 0;
    let group = groups.find((g) => (g.categoryId || 0) === catId);
    if (!group) {
      group = {
        categoryId: item.categoryId,
        categoryName: item.category || "Uncategorized",
        baleCount: 0,
        totalWeight: 0,
        totalCost: 0,
        totalSellValue: 0,
        productCount: 0,
        products: [],
      };
      groups.push(group);
    }
    group.baleCount += item.baleCount;
    group.totalWeight += item.totalWeight;
    group.totalCost += item.totalCost;
    group.totalSellValue += (item.baleCount - (item.loadingCount ?? 0)) * parseFloat(item.sellingPrice || "0");
    group.productCount += 1;
    group.products.push(item);
    return groups;
  }, [] as CategoryGroup[]);

  const sortedLocations = [...locations].sort((a, b) => a.name.localeCompare(b.name));
  const filteredLocations = sortedLocations.filter((l) => l.name.toLowerCase().includes(locationSearch.toLowerCase()));

  const filteredProducts = useMemo(() => {
    return applySortProducts(
      activeInventoryData.filter((p) => {
        const matchesSearch = productMatchesSearch(
          { name: p.productName, nameAr: p.productNameAr, articleCode: p.articleCode },
          productSearch
        );
        const matchesCat = categoryFilter.length === 0 || categoryFilter.includes(p.category ?? "Uncategorized");
        const hideZero = proformaMode ? hideZeroAvailable : !showZeroStock;
        if (hideZero && p.baleCount - (p.loadingCount ?? 0) <= 0) return false;
        if (proformaMode && showSelectedOnly) return matchesSearch && matchesCat && selections.has(p.productId);
        return matchesSearch && matchesCat;
      }),
      prodSortField,
      prodSortDir
    );
  }, [
    activeInventoryData,
    productSearch,
    categoryFilter,
    prodSortField,
    prodSortDir,
    proformaMode,
    hideZeroAvailable,
    showZeroStock,
    showSelectedOnly,
    selections,
  ]);

  const regularProducts = filteredProducts.filter((p) => !isSpecialFactoryCategory(p.category || ""));
  const specialProducts = filteredProducts.filter((p) => isSpecialFactoryCategory(p.category || ""));

  const handleLocationClick = (location: Location) => {
    setSelectedLocation(location);
    setProductSearch("");
    setCategoryFilter([]);
  };

  const handleBackToLocations = () => {
    setSelectedLocation(null);
    setLocationSearch("");
    setProductSearch("");
    setCategoryFilter([]);
    setProformaMode(false);
    setSelections(new Map());
  };

  useEscapeBack(selectedLocation ? handleBackToLocations : null);

  const toggleProformaMode = useCallback(() => {
    if (proformaMode) {
      setProformaMode(false);
      setSelections(new Map());
      setShowSelectedOnly(false);
    } else {
      setProformaMode(true);
    }
  }, [proformaMode]);

  const selectAllVisible = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      filteredProducts.forEach((prod) => {
        if (!next.has(prod.productId)) {
          next.set(prod.productId, {
            productId: prod.productId,
            articleCode: prod.articleCode,
            productName: prod.productName,
            availableBales: prod.baleCount,
            totalWeight: prod.totalWeight,
            selectedQty: prod.baleCount,
            pricePerBale: prod.sellingPrice || "0",
          });
        }
      });
      return next;
    });
  }, [filteredProducts]);

  const deselectAllVisible = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      filteredProducts.forEach((prod) => next.delete(prod.productId));
      return next;
    });
    setShowSelectedOnly(false);
  }, [filteredProducts]);

  const toggleSelection = useCallback((prod: FactoryBaleProduct) => {
    setSelections((prev) => {
      const next = new Map(prev);
      if (next.has(prod.productId)) {
        next.delete(prod.productId);
      } else {
        next.set(prod.productId, {
          productId: prod.productId,
          articleCode: prod.articleCode,
          productName: prod.productName,
          availableBales: prod.baleCount,
          totalWeight: prod.totalWeight,
          selectedQty: prod.baleCount,
          pricePerBale: prod.sellingPrice || "0",
        });
      }
      return next;
    });
  }, []);

  const updateSelectionQty = useCallback((productId: number, qty: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const existing = next.get(productId);
      if (existing) {
        const parsed = parseInt(qty);
        next.set(productId, { ...existing, selectedQty: isNaN(parsed) ? 0 : Math.max(0, parsed) });
      }
      return next;
    });
  }, []);

  const updateSelectionPrice = useCallback((productId: number, price: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const existing = next.get(productId);
      if (existing) {
        next.set(productId, { ...existing, pricePerBale: price });
      }
      return next;
    });
  }, []);

  const applySellingPrices = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      for (const [productId, sel] of next) {
        const prod = activeInventoryData.find((p) => p.productId === productId);
        if (prod) next.set(productId, { ...sel, pricePerBale: prod.sellingPrice || "0" });
      }
      return next;
    });
  }, [activeInventoryData]);

  const applyProductionPrices = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      for (const [productId, sel] of next) {
        const prod = activeInventoryData.find((p) => p.productId === productId);
        if (prod) next.set(productId, { ...sel, pricePerBale: String(prod.productionPrice || "0") });
      }
      return next;
    });
  }, [activeInventoryData]);

  const updateFinalizePrice = useCallback((productId: number, price: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const existing = next.get(productId);
      if (existing) next.set(productId, { ...existing, pricePerBale: price });
      return next;
    });
  }, []);

  const updateFinalizeQty = useCallback((productId: number, qty: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const existing = next.get(productId);
      if (existing) {
        const parsed = parseInt(qty);
        next.set(productId, { ...existing, selectedQty: isNaN(parsed) ? 0 : Math.max(0, parsed) });
      }
      return next;
    });
  }, []);

  const removeFromFinalize = useCallback((productId: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.delete(productId);
      return next;
    });
  }, []);

  const selectedItems = Array.from(selections.values()).filter((s) => s.selectedQty > 0);
  const grandTotal = selectedItems.reduce(
    (sum, item) => sum + item.selectedQty * parseFloat(item.pricePerBale || "0"),
    0
  );
  const totalSelectedBales = selectedItems.reduce((sum, item) => sum + item.selectedQty, 0);
  const totalSelectedKg = selectedItems.reduce((sum, item) => {
    const weightPerBale = item.availableBales > 0 ? item.totalWeight / item.availableBales : 0;
    return sum + item.selectedQty * weightPerBale;
  }, 0);

  const getOverloadedItems = () =>
    selectedItems
      .filter((i) => i.selectedQty > i.availableBales)
      .map((i) => ({
        articleCode: i.articleCode,
        productName: i.productName,
        requested: i.selectedQty,
        available: i.availableBales,
      }));

  const handleFinalize = () => {
    if (selectedItems.length === 0) {
      toast({
        title: "No items selected",
        description: "Select at least one item with quantity > 0",
        variant: "destructive",
      });
      return;
    }
    const overloaded = getOverloadedItems();
    if (overloaded.length > 0) {
      setOverloadWarning({
        open: true,
        items: overloaded,
        pendingFn: () => {
          setSavedProformaId(null);
          setFinalizeOpen(true);
        },
      });
      return;
    }
    setSavedProformaId(null);
    setFinalizeOpen(true);
  };

  const doSaveProforma = () => {
    const lines = selectedItems.map((item) => ({
      articleCode: item.articleCode,
      productName: item.productName,
      quantity: item.selectedQty,
      pricePerBale: item.pricePerBale,
    }));
    if (editingProformaId) {
      replaceLinesMutation.mutate({ id: editingProformaId, lines });
    } else {
      bulkCreateMutation.mutate({
        customerId: parseInt(selectedCustomerId),
        name: proformaName.trim(),
        isActive: false,
        lines,
      });
    }
  };

  const handleSaveProforma = () => {
    if (!selectedCustomerId) {
      toast({ title: "Select a customer", variant: "destructive" });
      return;
    }
    if (!proformaName.trim()) {
      toast({ title: "Enter a proforma name", variant: "destructive" });
      return;
    }
    const overloaded = getOverloadedItems();
    if (overloaded.length > 0) {
      setOverloadWarning({ open: true, items: overloaded, pendingFn: doSaveProforma });
      return;
    }
    doSaveProforma();
  };

  const toggleProformaAutoSave = () => {
    const next = !proformaAutoSave;
    setProformaAutoSave(next);
    try {
      localStorage.setItem("proforma-inventory-autosave", String(next));
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
    if (!next && autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!proformaAutoSave || !proformaMode || !editingProformaId || selections.size === 0 || !editModeInitialized)
      return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      isSilentAutoSaveRef.current = true;
      doSaveProforma();
      autoSaveTimerRef.current = null;
    }, 2000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proformaAutoSave, proformaMode, editingProformaId, selections, editModeInitialized]);

  const handleExportExcel = () => {
    if (!savedProformaId) return;
    window.open(`/api/factory/customer-proformas/${savedProformaId}/export/excel`, "_blank");
  };

  const handleExportPdf = () => {
    if (!savedProformaId) return;
    if (!navigator.onLine) {
      window.print();
      return;
    }
    window.open(`/api/factory/customer-proformas/${savedProformaId}/export/pdf`, "_blank");
  };

  const handleCloseFinalizeDialog = () => {
    setFinalizeOpen(false);
    if (savedProformaId) {
      setProformaMode(false);
      setSelections(new Map());
      setSavedProformaId(null);
      setProformaName("");
      setSelectedCustomerId("");
    }
  };

  const filteredCustomers = customers.filter((c) => c.legalName.toLowerCase().includes(customerSearch.toLowerCase()));

  const fmt = (n: number | null | undefined) => {
    if (n == null || isNaN(n)) return "0";
    return n.toLocaleString(undefined, { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  };

  return {
    activeInventoryData,
    applyProductionPrices,
    applySellingPrices,
    availableLoading,
    bulkCreateMutation,
    categoryFilter,
    categoryGroups,
    colors,
    createCustomerMutation,
    customerSearch,
    deleteDialogOpen,
    deleteProduct,
    deleteQty,
    deleteReason,
    deleteSupervisorPass,
    deleteSupervisorUser,
    deselectAllVisible,
    editingProformaId,
    filteredCustomers,
    filteredLocations,
    filteredProducts,
    finalizeOpen,
    fmt,
    formatAmount,
    grandTotal,
    handleBackToLocations,
    handleCloseFinalizeDialog,
    handleDoPrint,
    handleExportExcel,
    handleExportPdf,
    handleFinalize,
    handleLocationClick,
    handlePrint,
    handleReprintProduct,
    handleSaveProforma,
    hiddenColumns,
    hideAvgCost,
    hideSellingPrice,
    hideZeroAvailable,
    inventoryLoading,
    locationSearch,
    locations,
    locationsLoading,
    myAccess,
    navigate,
    newCustomerName,
    openBrowserReprintLabels,
    openRenameDialog,
    overloadWarning,
    printRef,
    prodSortDir,
    prodSortField,
    productSearch,
    proformaAutoSave,
    proformaMode,
    proformaName,
    regularProducts,
    removeBalesMutation,
    removeFromFinalize,
    renameDialogOpen,
    renameInput,
    renameLocationMutation,
    renamingLocation,
    replaceLinesMutation,
    reprintBales,
    reprintDesignPickerOpen,
    reprintDialogOpen,
    reprintLoading,
    reprintPendingLabels,
    reprintProduct,
    savedProformaId,
    selectAllVisible,
    selectedCustomerId,
    selectedItems,
    selectedLocation,
    selections,
    setCategoryFilter,
    setCustomerSearch,
    setDeleteDialogOpen,
    setDeleteProduct,
    setDeleteQty,
    setDeleteReason,
    setDeleteSupervisorPass,
    setDeleteSupervisorUser,
    setHiddenColumns,
    setHideZeroAvailable,
    setLocationSearch,
    setNewCustomerName,
    setOverloadWarning,
    setProdSortDir,
    setProdSortField,
    setProductSearch,
    setProformaName,
    setRenameDialogOpen,
    setRenameInput,
    setReprintBales,
    setReprintDesignPickerOpen,
    setReprintDialogOpen,
    setReprintProduct,
    setSelectedCustomerId,
    setShowCreateCustomer,
    setShowSelectedOnly,
    setShowZeroStock,
    showCreateCustomer,
    showSelectedOnly,
    showZeroStock,
    specialProducts,
    toggleProformaAutoSave,
    toggleProformaMode,
    toggleSelection,
    totalSelectedBales,
    totalSelectedKg,
    updateFinalizePrice,
    updateFinalizeQty,
    updateSelectionPrice,
    updateSelectionQty,
  };
}
