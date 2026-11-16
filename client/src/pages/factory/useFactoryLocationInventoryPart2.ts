// Extracted from ./FactoryLocationInventoryModel.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, keyStartsWith, queryClient } from "@/lib/queryClient";
import { useEscapeBack } from "@/hooks/use-escape-back";
import type {
  CategoryGroup,
  CustomerProformaRecord,
  FactoryProformaLine,
  Location,
  ProformaMutationResult,
  RemoveBalesResult,
} from "./factorylocationinventory/types";
import { applySortProducts, isSpecialFactoryCategory } from "./factorylocationinventory/utils";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import {
  buildEditProformaSelections,
  groupInventoryByCategory,
  toProformaSelection,
} from "./factorylocationinventory/inventoryModelHelpers";
import { useFactoryLocationInventoryPart1 } from "./useFactoryLocationInventoryPart1";

export function useFactoryLocationInventoryPart2({
  activeInventoryData,
  categoryFilter,
  editModeInitialized,
  editProformaLines,
  editingProformaId,
  hideZeroAvailable,
  inventoryData,
  inventoryLoading,
  isSilentAutoSaveRef,
  locationSearch,
  locations,
  modeApiRequest,
  navigate,
  prodSortDir,
  prodSortField,
  productSearch,
  proformaMode,
  recordChanges,
  selectedLocation,
  selections,
  setCategoryFilter,
  setDeleteDialogOpen,
  setDeleteProduct,
  setDeleteQty,
  setDeleteReason,
  setDeleteSupervisorPass,
  setDeleteSupervisorUser,
  setEditModeInitialized,
  setEditProformaLines,
  setEditingProformaId,
  setLocationSearch,
  setProductSearch,
  setProformaDestination,
  setProformaMode,
  setProformaName,
  setRenameDialogOpen,
  setRenameInput,
  setRenamingLocation,
  setSavedProformaId,
  setSelectedCustomerId,
  setSelectedLocation,
  setSelections,
  setShowSelectedOnly,
  showSelectedOnly,
  showZeroStock,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryLocationInventoryPart1>>,
  | "activeInventoryData"
  | "categoryFilter"
  | "editModeInitialized"
  | "editProformaLines"
  | "editingProformaId"
  | "hideZeroAvailable"
  | "inventoryData"
  | "inventoryLoading"
  | "isSilentAutoSaveRef"
  | "locationSearch"
  | "locations"
  | "modeApiRequest"
  | "navigate"
  | "prodSortDir"
  | "prodSortField"
  | "productSearch"
  | "proformaMode"
  | "recordChanges"
  | "selectedLocation"
  | "selections"
  | "setCategoryFilter"
  | "setDeleteDialogOpen"
  | "setDeleteProduct"
  | "setDeleteQty"
  | "setDeleteReason"
  | "setDeleteSupervisorPass"
  | "setDeleteSupervisorUser"
  | "setEditModeInitialized"
  | "setEditProformaLines"
  | "setEditingProformaId"
  | "setLocationSearch"
  | "setProductSearch"
  | "setProformaDestination"
  | "setProformaMode"
  | "setProformaName"
  | "setRenameDialogOpen"
  | "setRenameInput"
  | "setRenamingLocation"
  | "setSavedProformaId"
  | "setSelectedCustomerId"
  | "setSelectedLocation"
  | "setSelections"
  | "setShowSelectedOnly"
  | "showSelectedOnly"
  | "showZeroStock"
  | "toast"
>) {
  const bulkCreateMutation = useMutation({
    mutationFn: async (data: {
      customerId: number;
      name: string;
      destination: string;
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
          setProformaDestination(found?.destination || "");
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
  }, [
    setEditProformaLines,
    setEditingProformaId,
    setProformaDestination,
    setProformaMode,
    setProformaName,
    setSelectedCustomerId,
  ]);

  useEffect(() => {
    if (
      !editingProformaId ||
      editProformaLines.length === 0 ||
      !selectedLocation ||
      inventoryLoading ||
      editModeInitialized
    )
      return;
    const newSelections = buildEditProformaSelections(inventoryData, editProformaLines);
    if (newSelections.size > 0) setSelections(newSelections);
    setEditModeInitialized(true);
  }, [
    editingProformaId,
    editProformaLines,
    selectedLocation,
    inventoryData,
    inventoryLoading,
    editModeInitialized,
    setEditModeInitialized,
    setSelections,
  ]);

  const categoryGroups: CategoryGroup[] = groupInventoryByCategory(activeInventoryData);

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
  }, [proformaMode, setProformaMode, setSelections, setShowSelectedOnly]);

  const selectAllVisible = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      filteredProducts.forEach((prod) => {
        if (!next.has(prod.productId)) next.set(prod.productId, toProformaSelection(prod));
      });
      return next;
    });
  }, [filteredProducts, setSelections]);
  return {
    bulkCreateMutation,
    categoryGroups,
    filteredLocations,
    filteredProducts,
    handleBackToLocations,
    handleLocationClick,
    openRenameDialog,
    regularProducts,
    removeBalesMutation,
    renameLocationMutation,
    replaceLinesMutation,
    selectAllVisible,
    specialProducts,
    toggleProformaMode,
  };
}
