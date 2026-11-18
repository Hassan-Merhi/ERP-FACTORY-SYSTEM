// Extracted from ./POS.tsx to keep that module under the source-size cap.
import { usePOSStatePart2 } from "./POSUsePOSStatePart2";
import { usePOSStatePart1X } from "./POSUsePOSStatePart1X";

export function usePOSStatePart2X({
  activeCurrency,
  activeLocation,
  activeRow,
  allLedgerAccounts,
  allLocations,
  apiInventory,
  authUser,
  autoSaveInProgressRef,
  autoSaveStateRef,
  clientSaleIdRef,
  currentDraftId,
  currentShift,
  drafts,
  editVoucher,
  editVoucherId,
  editVoucherViewEntries,
  exchangeRate,
  goldenCoastPhase6,
  goldenCoastReadiness,
  goldenCoastReadinessLoading,
  highlightedIndex,
  inputRefs,
  inventory,
  inventoryPickerSearchRef,
  isCreditSale,
  isSpCompany,
  lastSavedFingerprintRef,
  lastSoldPrices,
  notes,
  paymentAccountId,
  paymentAccountType,
  pendingAutoSend,
  pendingStockSend,
  posAssignedLocations,
  posSelectedLocation,
  posUser,
  posWritesDisabled,
  printRef,
  refetchDrafts,
  rows,
  saleDate,
  savedSale,
  searchTerm,
  selectedCustomerId,
  selectedLocation,
  setCurrentDraftId,
  setHighlightedIndex,
  setInvoiceWaStatus,
  setIsCreditSale,
  setLastAutosaved,
  setMobileTab,
  setNotes,
  setPaymentAccountId,
  setPaymentAccountType,
  setPosSelectedLocation,
  setPendingAutoSend,
  setPendingStockSend,
  setRows,
  setSaleDate,
  setSaleJustCompleted,
  setSavedSale,
  setSearchTerm,
  setSelectedCell,
  setSelectedCustomerId,
  setSelectedLocation,
  setSendingInvoiceWhatsApp,
  setSendingWhatsApp,
  setShowDraftDialog,
  setShowPrintDialog,
  setStockWaStatus,
  setZeroStockAlert,
  setZeroStockItem,
  stockPrintRef,
  toast,
}: Pick<
  Awaited<ReturnType<typeof usePOSStatePart1X>>,
  | "activeCurrency"
  | "activeLocation"
  | "activeRow"
  | "allLedgerAccounts"
  | "allLocations"
  | "apiInventory"
  | "authUser"
  | "autoSaveInProgressRef"
  | "autoSaveStateRef"
  | "clientSaleIdRef"
  | "currentDraftId"
  | "currentShift"
  | "drafts"
  | "editVoucher"
  | "editVoucherId"
  | "editVoucherViewEntries"
  | "exchangeRate"
  | "goldenCoastPhase6"
  | "goldenCoastReadiness"
  | "goldenCoastReadinessLoading"
  | "highlightedIndex"
  | "inputRefs"
  | "inventory"
  | "inventoryPickerSearchRef"
  | "isCreditSale"
  | "isSpCompany"
  | "lastSavedFingerprintRef"
  | "lastSoldPrices"
  | "notes"
  | "paymentAccountId"
  | "paymentAccountType"
  | "pendingAutoSend"
  | "pendingStockSend"
  | "posAssignedLocations"
  | "posSelectedLocation"
  | "posUser"
  | "posWritesDisabled"
  | "printRef"
  | "refetchDrafts"
  | "rows"
  | "saleDate"
  | "savedSale"
  | "searchTerm"
  | "selectedCustomerId"
  | "selectedLocation"
  | "setCurrentDraftId"
  | "setHighlightedIndex"
  | "setInvoiceWaStatus"
  | "setIsCreditSale"
  | "setLastAutosaved"
  | "setMobileTab"
  | "setNotes"
  | "setPaymentAccountId"
  | "setPaymentAccountType"
  | "setPosSelectedLocation"
  | "setPendingAutoSend"
  | "setPendingStockSend"
  | "setRows"
  | "setSaleDate"
  | "setSaleJustCompleted"
  | "setSavedSale"
  | "setSearchTerm"
  | "setSelectedCell"
  | "setSelectedCustomerId"
  | "setSelectedLocation"
  | "setSendingInvoiceWhatsApp"
  | "setSendingWhatsApp"
  | "setShowDraftDialog"
  | "setShowPrintDialog"
  | "setStockWaStatus"
  | "setZeroStockAlert"
  | "setZeroStockItem"
  | "stockPrintRef"
  | "toast"
>) {
  const {
    canSellNegativeStock,
    canSendWhatsApp,
    deleteDraftMutation,
    ensureItemSellable,
    fmtAmount,
    focusCell,
    goldenCoastPosBlocked,
    goldenCoastPosSaveDisabled,
    handleDetailedExport,
    handleExportInventory,
    handleKeyDown,
    handleLoadDraft,
    handleNewSale,
    handlePrint,
    handleSaveSale,
    handleSendInvoiceWhatsApp,
    handleSendWhatsAppReport,
    handleStockPrint,
    handleSummaryExport,
    hasValidItems,
    matchingItemCount,
    resolveItemRate,
    saveDraftMutation,
    saveMutation,
    selectItem,
    selectedItemIndex,
    updateRow,
  } = usePOSStatePart2({
    activeCurrency,
    activeLocation,
    activeRow,
    allLedgerAccounts,
    allLocations,
    apiInventory,
    authUser,
    autoSaveInProgressRef,
    autoSaveStateRef,
    clientSaleIdRef,
    currentDraftId,
    currentShift,
    drafts,
    editVoucher,
    editVoucherId,
    editVoucherViewEntries,
    exchangeRate,
    goldenCoastPhase6,
    goldenCoastReadiness,
    goldenCoastReadinessLoading,
    highlightedIndex,
    inputRefs,
    inventory,
    inventoryPickerSearchRef,
    isCreditSale,
    isSpCompany,
    lastSavedFingerprintRef,
    lastSoldPrices,
    notes,
    paymentAccountId,
    paymentAccountType,
    pendingAutoSend,
    pendingStockSend,
    posAssignedLocations,
    posSelectedLocation,
    posUser,
    posWritesDisabled,
    printRef,
    refetchDrafts,
    rows,
    saleDate,
    savedSale,
    searchTerm,
    selectedCustomerId,
    selectedLocation,
    setCurrentDraftId,
    setHighlightedIndex,
    setInvoiceWaStatus,
    setIsCreditSale,
    setLastAutosaved,
    setMobileTab,
    setNotes,
    setPaymentAccountId,
    setPaymentAccountType,
    setPosSelectedLocation,
    setPendingAutoSend,
    setPendingStockSend,
    setRows,
    setSaleDate,
    setSaleJustCompleted,
    setSavedSale,
    setSearchTerm,
    setSelectedCell,
    setSelectedCustomerId,
    setSelectedLocation,
    setSendingInvoiceWhatsApp,
    setSendingWhatsApp,
    setShowDraftDialog,
    setShowPrintDialog,
    setStockWaStatus,
    setZeroStockAlert,
    setZeroStockItem,
    stockPrintRef,
    toast,
  });
  return {
    canSellNegativeStock,
    canSendWhatsApp,
    deleteDraftMutation,
    ensureItemSellable,
    fmtAmount,
    focusCell,
    goldenCoastPosBlocked,
    goldenCoastPosSaveDisabled,
    handleDetailedExport,
    handleExportInventory,
    handleKeyDown,
    handleLoadDraft,
    handleNewSale,
    handlePrint,
    handleSaveSale,
    handleSendInvoiceWhatsApp,
    handleSendWhatsAppReport,
    handleStockPrint,
    handleSummaryExport,
    hasValidItems,
    matchingItemCount,
    resolveItemRate,
    saveDraftMutation,
    saveMutation,
    selectItem,
    selectedItemIndex,
    updateRow,
  };
}
