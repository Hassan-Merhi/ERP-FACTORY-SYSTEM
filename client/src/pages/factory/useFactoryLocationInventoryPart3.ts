// Extracted from ./FactoryLocationInventoryModel.tsx to keep that module under the source-size cap.
import { useEffect } from "react";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { useFactoryLocationInventoryPart1 } from "./useFactoryLocationInventoryPart1";
import { useFactoryLocationInventoryPart2 } from "./useFactoryLocationInventoryPart2";
import { useFactoryLocationInventoryPart5 } from "./useFactoryLocationInventoryPart5";

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
  const {
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
  } = useFactoryLocationInventoryPart5({
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
  });

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
