// Extracted from ./FactoryLocationInventoryModel.tsx to keep that module under the source-size cap.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { getApiRequest } from "@/lib/factoryApi";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useReactToPrint } from "react-to-print";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type {
  Customer,
  FactoryBaleProduct,
  FactoryProformaLine,
  Location,
  ProformaSelection,
  SortDir,
  SortField,
} from "./factorylocationinventory/types";
import { useFactoryLocationReprint } from "./factorylocationinventory/useFactoryLocationReprint";
import { buildActiveInventoryData } from "./factorylocationinventory/activeInventory";

export function useFactoryLocationInventoryPart1() {
  const { colors } = useLabelDesignColors();
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [locationSearch, setLocationSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [prodSortField, setProdSortField] = useState<SortField>("name");
  const [prodSortDir, setProdSortDir] = useState<SortDir>("asc");
  const [, navigate] = useLocation();
  const printRef = useRef<HTMLDivElement>(null);
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const appMode = useAppMode();
  const { selectedCompany } = useCompany();
  const modeApiRequest = getApiRequest(appMode);
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateCustomer = recordChanges.canCreate("POST", "/api/factory/customers");
  const canCreateProforma = recordChanges.canCreate("POST", "/api/factory/customer-proformas/bulk");

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
  const [proformaDestination, setProformaDestination] = useState("");
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
    canReprint,
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
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: factorySettingsData } = useQuery<{ hideSellingPrice?: boolean; hideAvgCost?: boolean }>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/settings", { credentials: "include" });
      return res.ok ? res.json() : {};
    },
  });
  // Do not apply permission data from a different selected company.
  const scopedAccess = myAccess?.companyId === selectedCompany?.id ? myAccess : undefined;
  const perUserHidden = scopedAccess?.hiddenCostFields ?? [];
  const noCostAccess = !scopedAccess || !scopedAccess.hasFactoryAccess || scopedAccess.hideAllCosts;
  const hideSellingPrice =
    noCostAccess ||
    !!factorySettingsData?.hideSellingPrice ||
    perUserHidden.includes("inventory_sell_price") ||
    perUserHidden.includes("inventory_sell_value") ||
    perUserHidden.includes("hide_export_selling_price");
  const hideAvgCost =
    noCostAccess ||
    !!factorySettingsData?.hideAvgCost ||
    perUserHidden.includes("inventory_avg_rate") ||
    perUserHidden.includes("inventory_total_value") ||
    perUserHidden.includes("hide_export_cost_price");

  const { data: inventoryData = [], isLoading: inventoryLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey(`/api/factory/location-inventory/${selectedLocation?.id ?? "none"}`, selectedCompany?.id),
    queryFn: async () => {
      const response = await fetch(`/api/factory/location-inventory/${selectedLocation!.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch factory inventory");
      return response.json();
    },
    enabled: !!selectedLocation && Boolean(selectedCompany?.id),
  });

  const { data: availableInventoryData = [], isLoading: availableLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey(
      `/api/factory/location-inventory/${selectedLocation?.id ?? "none"}/available`,
      selectedCompany?.id
    ),
    queryFn: async () => {
      const response = await fetch(`/api/factory/location-inventory/${selectedLocation!.id}/available`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch available inventory");
      return response.json();
    },
    enabled: !!selectedLocation && proformaMode && Boolean(selectedCompany?.id),
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
    queryKey: companyQueryKey("/api/factory/bale-products", selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/bale-products", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch bale products catalog");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && (proformaMode || showZeroStock),
  });

  const { data: catalogCategories = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: companyQueryKey("/api/factory/categories", selectedCompany?.id),
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
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: finalizeOpen && Boolean(selectedCompany?.id),
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
  return {
    activeInventoryData,
    autoSaveTimerRef,
    availableLoading,
    canCreateCustomer,
    canCreateProforma,
    canReprint,
    categoryFilter,
    colors,
    createCustomerMutation,
    customerSearch,
    customers,
    deleteDialogOpen,
    deleteProduct,
    deleteQty,
    deleteReason,
    deleteSupervisorPass,
    deleteSupervisorUser,
    editModeInitialized,
    editProformaLines,
    editingProformaId,
    finalizeOpen,
    formatAmount,
    handleDoPrint,
    handlePrint,
    handleReprintProduct,
    hiddenColumns,
    hideAvgCost,
    hideSellingPrice,
    hideZeroAvailable,
    inventoryData,
    inventoryLoading,
    isSilentAutoSaveRef,
    locationSearch,
    locations,
    locationsLoading,
    modeApiRequest,
    myAccess,
    navigate,
    newCustomerName,
    openBrowserReprintLabels,
    overloadWarning,
    printRef,
    prodSortDir,
    prodSortField,
    productSearch,
    proformaAutoSave,
    proformaDestination,
    proformaMode,
    proformaName,
    recordChanges,
    renameDialogOpen,
    renameInput,
    renamingLocation,
    reprintBales,
    reprintDesignPickerOpen,
    reprintDialogOpen,
    reprintLoading,
    reprintPendingLabels,
    reprintProduct,
    savedProformaId,
    selectedCustomerId,
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
    setEditModeInitialized,
    setEditProformaLines,
    setEditingProformaId,
    setFinalizeOpen,
    setHiddenColumns,
    setHideZeroAvailable,
    setLocationSearch,
    setNewCustomerName,
    setOverloadWarning,
    setProdSortDir,
    setProdSortField,
    setProductSearch,
    setProformaAutoSave,
    setProformaDestination,
    setProformaMode,
    setProformaName,
    setRenameDialogOpen,
    setRenameInput,
    setRenamingLocation,
    setReprintBales,
    setReprintDesignPickerOpen,
    setReprintDialogOpen,
    setReprintProduct,
    setSavedProformaId,
    setSelectedCustomerId,
    setSelectedLocation,
    setSelections,
    setShowCreateCustomer,
    setShowSelectedOnly,
    setShowZeroStock,
    showCreateCustomer,
    showSelectedOnly,
    showZeroStock,
    toast,
  };
}
