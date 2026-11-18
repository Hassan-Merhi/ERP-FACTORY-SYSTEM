// Extracted from ./POS.tsx to keep that module under the source-size cap.
import { useEffect, useMemo } from "react";
import { usePosWhatsApp } from "./hooks/usePosWhatsApp";
import { usePosMutations } from "./hooks/usePosMutations";
import { usePosAutosave } from "./hooks/usePosAutosave";
import { usePosHandlers } from "./hooks/usePosHandlers";
import { usePosEditVoucherHydration } from "./usePosEditVoucherHydration";
import { formatDisplayAmount, getPosKeyboardHighlightedIndex, getPosPickerInventory } from "./utils/posCalculations";
import { usePOSStatePart1 } from "./POSUsePOSStatePart1";

export function usePOSStatePart2({
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
  Awaited<ReturnType<typeof usePOSStatePart1>>,
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
  // Auto-attach to today's draft
  useEffect(() => {
    if (currentDraftId !== null) return;
    if (!Array.isArray(drafts) || drafts.length === 0) return;
    const todayUTC = new Date().toISOString().slice(0, 10);
    const todayDraft = drafts.find((d) => {
      const rawDate = d.updatedAt || d.createdAt;
      if (!rawDate) return false;
      const dateObj = new Date(rawDate);
      if (isNaN(dateObj.getTime())) return false;
      return dateObj.toISOString().slice(0, 10) === todayUTC;
    });
    if (todayDraft) setCurrentDraftId(todayDraft.id);
  }, [currentDraftId, drafts, setCurrentDraftId]);

  // Edit mode: select the voucher's location, populate rows once, infer payment type.
  usePosEditVoucherHydration({
    editVoucherId,
    editVoucher,
    editVoucherViewEntries,
    allLocations,
    allLedgerAccounts,
    selectedLocation,
    setSelectedLocation,
    setRows,
    setNotes,
    setSaleDate,
    setPaymentAccountType,
    setPaymentAccountId,
    setIsCreditSale,
    setSelectedCustomerId,
  });

  // ── WhatsApp / mutations / autosave ───────────────────────────────────────
  const { handleSendInvoiceWhatsApp, handleSendWhatsAppReport, canSendWhatsApp } = usePosWhatsApp({
    pendingAutoSend,
    setPendingAutoSend,
    pendingStockSend,
    setPendingStockSend,
    activeLocation,
    savedSale,
    setInvoiceWaStatus,
    setStockWaStatus,
    setSendingInvoiceWhatsApp,
    setSendingWhatsApp,
    toast,
  });

  const hasValidItems = useMemo(() => rows.some((row) => row.stockItemId && row.quantity > 0), [rows]);

  const { saveMutation, deleteDraftMutation, saveDraftMutation } = usePosMutations({
    activeLocation,
    editVoucherId,
    editVoucher,
    isSpCompany,
    isGoldenCoastPhase6: goldenCoastPhase6,
    goldenCoastParentCompanyId: goldenCoastReadiness?.parentCompanyId,
    clientSaleIdRef,
    rows,
    isCreditSale,
    paymentAccountType,
    paymentAccountId,
    selectedCustomerId,
    currentDraftId,
    notes,
    writesDisabled: posWritesDisabled,
    lastSavedFingerprintRef,
    setSavedSale,
    setSaleJustCompleted,
    setShowPrintDialog,
    setCurrentDraftId,
    setLastAutosaved,
    setPendingAutoSend,
    setPendingStockSend,
    setStockWaStatus,
    toast,
    refetchDrafts,
  });

  // Keep saveDraftIsPending in sync
  autoSaveStateRef.current.saveDraftIsPending = saveDraftMutation.isPending;

  usePosAutosave({
    autoSaveStateRef,
    autoSaveInProgressRef,
    lastSavedFingerprintRef,
    setCurrentDraftId,
    setLastAutosaved,
    refetchDrafts,
    disabled: posWritesDisabled,
  });

  // ── Handlers ──────────────────────────────────────────────────────────────
  const {
    focusCell,
    handlePrint,
    handleStockPrint,
    handleSaveSale,
    handleNewSale,
    selectItem,
    updateRow,
    ensureItemSellable,
    resolveItemRate,
    handleLoadDraft,
    handleExportInventory,
    handleSummaryExport,
    handleDetailedExport,
    makeHandleKeyDown,
  } = usePosHandlers({
    savedSale,
    rows,
    isCreditSale,
    paymentAccountType,
    paymentAccountId,
    selectedCustomerId,
    currentDraftId,
    notes,
    saleDate,
    activeRow,
    highlightedIndex,
    setRows,
    setSelectedCell,
    setNotes,
    setPaymentAccountType,
    setPaymentAccountId,
    setIsCreditSale,
    setSelectedCustomerId,
    setCurrentDraftId,
    setShowDraftDialog,
    setShowPrintDialog,
    setSavedSale,
    setSaleJustCompleted,
    setLastAutosaved,
    setMobileTab,
    setPendingStockSend,
    setStockWaStatus,
    setInvoiceWaStatus,
    setZeroStockItem,
    setZeroStockAlert,
    setSearchTerm,
    setHighlightedIndex,
    lastSavedFingerprintRef,
    inputRefs,
    focusInventoryPicker: () => inventoryPickerSearchRef.current?.focus(),
    printRef,
    stockPrintRef,
    clientSaleIdRef,
    activeCurrency,
    exchangeRate,
    dailyExchangeRate: exchangeRate,
    activeLocation,
    editVoucherId,
    editVoucher,
    isSpCompany,
    isGoldenCoastPhase6: goldenCoastPhase6,
    goldenCoastReadinessLoading,
    goldenCoastReadinessBlocked: goldenCoastReadiness?.canPost === false,
    goldenCoastReadinessBlockers: goldenCoastReadiness?.blockers,
    inventory,
    apiInventory,
    lastSoldPrices,
    currentShift,
    authUser,
    posUser,
    saveMutation,
    toast,
  });

  const handleKeyDown = makeHandleKeyDown(searchTerm);
  const matchingItems = useMemo(() => getPosPickerInventory(inventory, searchTerm), [inventory, searchTerm]);
  const matchingItemCount = matchingItems.length;
  const canSellNegativeStock = authUser?.canSellNegativeStock ?? posUser?.canSellNegativeStock ?? false;
  const selectedItemIndex = getPosKeyboardHighlightedIndex(matchingItems, highlightedIndex, canSellNegativeStock);
  const fmtAmount = (v: number) => formatDisplayAmount(activeCurrency, v);
  const goldenCoastPosBlocked = isSpCompany && goldenCoastPhase6 && goldenCoastReadiness?.canPost === false;
  const goldenCoastPosSaveDisabled = isSpCompany && (goldenCoastReadinessLoading || goldenCoastPosBlocked);
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
