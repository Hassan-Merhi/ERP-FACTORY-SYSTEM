// Extracted from ./FactoryLocationInventoryModel.tsx to keep that module under the source-size cap.
import { useFactoryLocationInventoryPart3, useFactoryLocationInventoryPart4 } from "./useFactoryLocationInventoryPart3";
import { useFactoryLocationInventoryPart1X } from "./useFactoryLocationInventoryPart1X";

export function useFactoryLocationInventoryPart2X({
  activeInventoryData,
  autoSaveTimerRef,
  bulkCreateMutation,
  canCreateProforma,
  customerSearch,
  customers,
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
  setProformaDestination,
  setProformaMode,
  setProformaName,
  setSavedProformaId,
  setSelectedCustomerId,
  setSelections,
  setShowSelectedOnly,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryLocationInventoryPart1X>>,
  | "activeInventoryData"
  | "autoSaveTimerRef"
  | "bulkCreateMutation"
  | "canCreateProforma"
  | "customerSearch"
  | "customers"
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
  | "setProformaDestination"
  | "setProformaMode"
  | "setProformaName"
  | "setSavedProformaId"
  | "setSelectedCustomerId"
  | "setSelections"
  | "setShowSelectedOnly"
  | "toast"
>) {
  const {
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
  } = useFactoryLocationInventoryPart3({
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
  });
  const { filteredCustomers, fmt, handleCloseFinalizeDialog } = useFactoryLocationInventoryPart4({
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
  });
  return {
    applyProductionPrices,
    applySellingPrices,
    deselectAllVisible,
    filteredCustomers,
    fmt,
    grandTotal,
    handleCloseFinalizeDialog,
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
