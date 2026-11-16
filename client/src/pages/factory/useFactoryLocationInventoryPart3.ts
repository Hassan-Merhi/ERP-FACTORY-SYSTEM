// Extracted from ./FactoryLocationInventoryModel.tsx to keep that module under the source-size cap.
import { useCallback, useEffect } from "react";
import type { FactoryBaleProduct } from "./factorylocationinventory/types";
import { toProformaSelection } from "./factorylocationinventory/inventoryModelHelpers";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { useFactoryLocationInventoryPart1 } from "./useFactoryLocationInventoryPart1";
import { useFactoryLocationInventoryPart2 } from "./useFactoryLocationInventoryPart2";

export function useFactoryLocationInventoryPart3({
  activeInventoryData,
  autoSaveTimerRef,
  bulkCreateMutation,
  canCreateProforma,
  editModeInitialized,
  editingProformaId,
  filteredProducts,
  isSilentAutoSaveRef,
  proformaAutoSave,
  proformaDestination,
  proformaMode,
  proformaName,
  recordChanges,
  replaceLinesMutation,
  savedProformaId,
  selectedCustomerId,
  selections,
  setFinalizeOpen,
  setOverloadWarning,
  setProformaAutoSave,
  setSavedProformaId,
  setSelections,
  setShowSelectedOnly,
  toast,
}: Pick<
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

  const handleSaveProforma = () => {
    if (!selectedCustomerId) {
      toast({ title: "Select a customer", variant: "destructive" });
      return;
    }
    if (!proformaName.trim()) {
      toast({ title: "Enter a proforma name", variant: "destructive" });
      return;
    }
    if (!editingProformaId && !proformaDestination.trim()) {
      toast({ title: "Enter a destination", variant: "destructive" });
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

  const handleExportExcel = async () => {
    if (!savedProformaId) return;
    try {
      await downloadFromUrl(`/api/factory/customer-proformas/${savedProformaId}/export/excel`, {
        fileName: exportFileName(`proforma ${proformaName || savedProformaId}`, "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleExportPdf = () => {
    if (!savedProformaId) return;
    if (!navigator.onLine) {
      window.print();
      return;
    }
    window.open(`/api/factory/customer-proformas/${savedProformaId}/export/pdf`, "_blank");
  };
  return {
    applyProductionPrices,
    applySellingPrices,
    deselectAllVisible,
    grandTotal,
    handleExportExcel,
    handleExportPdf,
    handleFinalize,
    handleSaveProforma,
    removeFromFinalize,
    selectedItems,
    toggleProformaAutoSave,
    toggleSelection,
    totalSelectedBales,
    totalSelectedKg,
    updateFinalizePrice,
    updateFinalizeQty,
    updateSelectionPrice,
    updateSelectionQty,
  };
}

export function useFactoryLocationInventoryPart4({
  customerSearch,
  customers,
  savedProformaId,
  setFinalizeOpen,
  setProformaDestination,
  setProformaMode,
  setProformaName,
  setSavedProformaId,
  setSelectedCustomerId,
  setSelections,
}: Pick<
  Awaited<ReturnType<typeof useFactoryLocationInventoryPart1>>,
  | "customerSearch"
  | "customers"
  | "savedProformaId"
  | "setFinalizeOpen"
  | "setProformaDestination"
  | "setProformaMode"
  | "setProformaName"
  | "setSavedProformaId"
  | "setSelectedCustomerId"
  | "setSelections"
>) {
  const handleCloseFinalizeDialog = () => {
    setFinalizeOpen(false);
    if (savedProformaId) {
      setProformaMode(false);
      setSelections(new Map());
      setSavedProformaId(null);
      setProformaName("");
      setProformaDestination("");
      setSelectedCustomerId("");
    }
  };

  const filteredCustomers = customers.filter((c) => c.legalName.toLowerCase().includes(customerSearch.toLowerCase()));

  const fmt = (n: number | null | undefined) => {
    if (n == null || isNaN(n)) return "0";
    return n.toLocaleString(undefined, { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  };
  return { filteredCustomers, fmt, handleCloseFinalizeDialog };
}
