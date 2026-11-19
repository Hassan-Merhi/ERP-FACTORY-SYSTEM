// Extracted from ./useFactoryLocationInventoryPart3.ts
import { useCallback } from "react";
import type { FactoryBaleProduct } from "./factorylocationinventory/types";
import { toProformaSelection } from "./factorylocationinventory/inventoryModelHelpers";
import { useFactoryLocationInventoryPart1 } from "./useFactoryLocationInventoryPart1";
import { useFactoryLocationInventoryPart2 } from "./useFactoryLocationInventoryPart2";

export function useFactoryLocationInventoryPart5({
  activeInventoryData,
  bulkCreateMutation,
  canCreateProforma,
  editingProformaId,
  filteredProducts,
  proformaDestination,
  proformaName,
  recordChanges,
  replaceLinesMutation,
  selectedCustomerId,
  selections,
  setFinalizeOpen,
  setOverloadWarning,
  setSavedProformaId,
  setSelections,
  setShowSelectedOnly,
  toast,
}: Pick<
  Pick<
    Awaited<ReturnType<typeof useFactoryLocationInventoryPart1>> &
      Awaited<ReturnType<typeof useFactoryLocationInventoryPart2>>,
    | "activeInventoryData"
    | "autoSaveTimerRef"
    | "bulkCreateMutation"
    | "canCreateProforma"
    | "editModeInitialized"
    | "editingProformaId"
    | "filteredProducts"
    | "isSilentAutoSaveRef"
    | "proformaAutoSave"
    | "proformaDestination"
    | "proformaMode"
    | "proformaName"
    | "recordChanges"
    | "replaceLinesMutation"
    | "savedProformaId"
    | "selectedCustomerId"
    | "selections"
    | "setFinalizeOpen"
    | "setOverloadWarning"
    | "setProformaAutoSave"
    | "setSavedProformaId"
    | "setSelections"
    | "setShowSelectedOnly"
    | "toast"
  >,
  | "activeInventoryData"
  | "bulkCreateMutation"
  | "canCreateProforma"
  | "editingProformaId"
  | "filteredProducts"
  | "proformaDestination"
  | "proformaName"
  | "recordChanges"
  | "replaceLinesMutation"
  | "selectedCustomerId"
  | "selections"
  | "setFinalizeOpen"
  | "setOverloadWarning"
  | "setSavedProformaId"
  | "setSelections"
  | "setShowSelectedOnly"
  | "toast"
>) {
  const deselectAllVisible = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      filteredProducts.forEach((prod) => next.delete(prod.productId));
      return next;
    });
    setShowSelectedOnly(false);
  }, [filteredProducts, setSelections, setShowSelectedOnly]);

  const toggleSelection = useCallback(
    (prod: FactoryBaleProduct) => {
      setSelections((prev) => {
        const next = new Map(prev);
        if (next.has(prod.productId)) {
          next.delete(prod.productId);
        } else {
          next.set(prod.productId, toProformaSelection(prod));
        }
        return next;
      });
    },
    [setSelections]
  );

  const updateSelectionQty = useCallback(
    (productId: number, qty: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const existing = next.get(productId);
        if (existing) {
          const parsed = parseInt(qty);
          next.set(productId, { ...existing, selectedQty: isNaN(parsed) ? 0 : Math.max(0, parsed) });
        }
        return next;
      });
    },
    [setSelections]
  );

  const updateSelectionPrice = useCallback(
    (productId: number, price: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const existing = next.get(productId);
        if (existing) {
          next.set(productId, { ...existing, pricePerBale: price });
        }
        return next;
      });
    },
    [setSelections]
  );

  const applySellingPrices = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      for (const [productId, sel] of next) {
        const prod = activeInventoryData.find((p) => p.productId === productId);
        if (prod) next.set(productId, { ...sel, pricePerBale: prod.sellingPrice || "0" });
      }
      return next;
    });
  }, [activeInventoryData, setSelections]);

  const applyProductionPrices = useCallback(() => {
    setSelections((prev) => {
      const next = new Map(prev);
      for (const [productId, sel] of next) {
        const prod = activeInventoryData.find((p) => p.productId === productId);
        if (prod) next.set(productId, { ...sel, pricePerBale: String(prod.productionPrice || "0") });
      }
      return next;
    });
  }, [activeInventoryData, setSelections]);

  const updateFinalizePrice = useCallback(
    (productId: number, price: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const existing = next.get(productId);
        if (existing) next.set(productId, { ...existing, pricePerBale: price });
        return next;
      });
    },
    [setSelections]
  );

  const updateFinalizeQty = useCallback(
    (productId: number, qty: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const existing = next.get(productId);
        if (existing) {
          const parsed = parseInt(qty);
          next.set(productId, { ...existing, selectedQty: isNaN(parsed) ? 0 : Math.max(0, parsed) });
        }
        return next;
      });
    },
    [setSelections]
  );

  const removeFromFinalize = useCallback(
    (productId: number) => {
      setSelections((prev) => {
        const next = new Map(prev);
        next.delete(productId);
        return next;
      });
    },
    [setSelections]
  );

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
    if (editingProformaId ? !recordChanges.allowed : !canCreateProforma) return;
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
        destination: proformaDestination.trim(),
        isActive: false,
        lines,
      });
    }
  };
  return {
    deselectAllVisible,
    toggleSelection,
    updateSelectionQty,
    updateSelectionPrice,
    applySellingPrices,
    applyProductionPrices,
    updateFinalizePrice,
    updateFinalizeQty,
    removeFromFinalize,
    selectedItems,
    grandTotal,
    totalSelectedBales,
    totalSelectedKg,
    getOverloadedItems,
    handleFinalize,
    doSaveProforma,
  };
}
