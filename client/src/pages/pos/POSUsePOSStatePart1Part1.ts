// Extracted from ./POS.tsx to keep that module under the source-size cap.
import { useEffect, useRef } from "react";
import { useLocation as useLocationContext } from "@/contexts/LocationContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useLocation } from "wouter";
import { type Currency, useCurrencyContext } from "@/contexts/CurrencyContext";
import { isSupportedAccountingCurrency } from "@shared/currencyCatalog";
import { useToast } from "@/hooks/use-toast";
import { usePosZmwSaleRate } from "./hooks/usePosZmwSaleRate";
import type { AuthMe } from "@shared/apiTypes";
import { usePosState } from "./hooks/usePosState";
import { usePosQueries } from "./hooks/usePosQueries";

export const POS_PICKER_LIST_ID = "pos-desktop-item-options";

export function usePOSStatePart1Part1(props: { posUser?: AuthMe; editVoucherId?: string }) {
  const { posUser, editVoucherId } = props;
  const { selectedLocation, setSelectedLocation } = useLocationContext();
  const { selectedCompany } = useCompany();
  const { t } = useApplicationLanguage();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCurrency, exchangeRate: dailyExchangeRate, displayCurrency } = useCurrencyContext();

  // ── All state & refs ───────────────────────────────────────────────────────
  const {
    posSelectedLocation,
    setPosSelectedLocation,
    rows,
    setRows,
    selectedCell,
    setSelectedCell,
    paymentAccountType,
    setPaymentAccountType,
    paymentAccountId,
    setPaymentAccountId,
    isCreditSale,
    setIsCreditSale,
    selectedCustomerId,
    setSelectedCustomerId,
    notes,
    setNotes,
    saleDate,
    setSaleDate,
    searchTerm,
    setSearchTerm,
    activeRow,
    setActiveRow,
    highlightedIndex,
    setHighlightedIndex,
    zeroStockAlert,
    setZeroStockAlert,
    zeroStockItem,
    setZeroStockItem,
    savedSale,
    setSavedSale,
    showPrintDialog,
    setShowPrintDialog,
    showDraftDialog,
    setShowDraftDialog,
    currentDraftId,
    setCurrentDraftId,
    customerComboOpen,
    setCustomerComboOpen,
    mobileCustomerComboOpen,
    setMobileCustomerComboOpen,
    setSaleJustCompleted,
    showStockPrompt,
    setShowStockPrompt,
    invoiceWaStatus,
    setInvoiceWaStatus,
    stockWaStatus,
    setStockWaStatus,
    setSendingInvoiceWhatsApp,
    sendingInvoiceWhatsApp,
    setSendingWhatsApp,
    sendingWhatsApp,
    lastAutosaved,
    setLastAutosaved,
    pendingAutoSend,
    setPendingAutoSend,
    pendingStockSend,
    setPendingStockSend,
    setMobileTab,
    inputRefs,
    itemListRef,
    printRef,
    stockPrintRef,
    clearActiveRowTimerRef,
    clientSaleIdRef,
    lastSavedFingerprintRef,
    autoSaveInProgressRef,
    mobileSearchInputRef,
    autoSaveStateRef,
  } = usePosState();
  const inventoryPickerSearchRef = useRef<HTMLInputElement>(null);

  const activeLocation = posUser ? posSelectedLocation : selectedLocation;
  // Zambia posting uses the approved rate of the sale date, never the
  // browser's current rate for an earlier sale date (cash and credit alike).
  const { datedZmwRate, isFetchingDatedZmwRate } = usePosZmwSaleRate({
    companyId: selectedCompany?.id,
    displayCurrency,
    saleDate,
    editVoucherId,
  });
  // Supplier Partner companies share this exact POS UI but sell from SP stock
  // (sp_stock_movements) and post through the SP-specific accounting endpoint.
  const isSpCompany = selectedCompany?.companyType === "supplier_partner";

  // ── Queries ────────────────────────────────────────────────────────────────
  const {
    posAssignedLocations,
    posLocationsLoading,
    allLocations,
    companySettings,
    apiInventory,
    inventory,
    bankAccounts,
    allLedgerAccounts,
    cashLedgerAccounts,
    customerAccounts,
    drafts,
    refetchDrafts,
    currentShift,
    authUser,
    goldenCoastPhase6,
    goldenCoastReadinessLoading,
    goldenCoastReadiness,
    lastSoldPrices,
    editVoucher,
    editVoucherViewEntries,
    stockInventory,
    stockInventoryLoading,
    inventoryLoading,
    inventoryError,
    refetchInventory,
  } = usePosQueries({
    posUser,
    activeLocation,
    companyId: selectedCompany?.id,
    isCreditSale,
    editVoucherId,
    showPrintDialog,
    showStockPrompt,
    isSpCompany,
  });

  const editedCurrency = editVoucherId && editVoucher?.currency;
  const activeCurrency: Currency = displayCurrency
    ? (editedCurrency === displayCurrency || editedCurrency === "USD") &&
      typeof editedCurrency === "string" &&
      isSupportedAccountingCurrency(editedCurrency)
      ? editedCurrency
      : selectedCurrency
    : "USD";
  const editLockedRate = editVoucherId && editVoucher?.exchangeRate ? Number(editVoucher.exchangeRate) : null;
  const approvedZmwRate = displayCurrency === "ZMW" && !editVoucherId ? Number(datedZmwRate?.rate) : null;
  const exchangeRate =
    displayCurrency === "ZMW"
      ? editVoucherId
        ? editLockedRate && editLockedRate > 0
          ? editLockedRate
          : null
        : !isFetchingDatedZmwRate && approvedZmwRate && Number.isFinite(approvedZmwRate) && approvedZmwRate > 0
          ? approvedZmwRate
          : null
      : dailyExchangeRate;

  // Keep a line's display price and canonical USD rate synchronized when
  // switching USD/ZMW or selecting a different sale date. A date change while
  // entering K preserves the typed K price and recalculates its USD equivalent.
  // Do not reinterpret the rows until a valid dated FX rate has resolved.
  const lastDisplayedFx = useRef<{ companyId: number; currency: Currency; rate: number | null } | null>(null);
  useEffect(() => {
    if (editVoucherId || !selectedCompany?.id) return;
    if (activeCurrency !== "USD" && (!exchangeRate || !Number.isFinite(exchangeRate))) return;
    const next = { companyId: selectedCompany.id, currency: activeCurrency, rate: exchangeRate };
    const old = lastDisplayedFx.current;
    if (!old || old.companyId !== next.companyId) {
      lastDisplayedFx.current = next;
      return;
    }
    if (old.currency === next.currency && old.rate === next.rate) return;
    setRows((oldRows) =>
      oldRows.map((row) => {
        if (!row.stockItemId || !Number.isFinite(row.rateUSD)) return row;
        const newUsd = old.currency === next.currency && next.currency !== "USD" ? row.rate / next.rate! : row.rateUSD;
        const displayRate =
          next.currency === "USD"
            ? newUsd
            : next.currency === "CFA"
              ? Math.round(newUsd * next.rate!)
              : Number((newUsd * next.rate!).toFixed(2));
        return { ...row, rateUSD: newUsd, rate: displayRate, amount: Number((row.quantity * displayRate).toFixed(2)) };
      })
    );
    lastDisplayedFx.current = next;
  }, [activeCurrency, exchangeRate, editVoucherId, selectedCompany?.id, setRows]);

  // POS view-only is a real write boundary, not just a server-side fallback.
  // Keep every client mutation path quiet so expected denials do not become
  // repeated production ERROR logs.
  const posWritesDisabled = posUser?.posViewOnly === true || authUser?.posViewOnly === true;

  // Supplier Partner sales support cash or bank settlement, same as normal
  // ERP POS — but never credit: /api/sp/sales has no credit-sale support.
  // Enforce only the credit restriction in state (not just hidden UI) so a
  // lingering credit toggle from a prior company can never leak through.
  useEffect(() => {
    if (!isSpCompany) return;
    setIsCreditSale(false);
  }, [isSpCompany, setIsCreditSale]);

  // Keep autoSaveStateRef in sync
  autoSaveStateRef.current.activeLocation = activeLocation;
  autoSaveStateRef.current.rows = rows;
  autoSaveStateRef.current.notes = notes;
  autoSaveStateRef.current.isCreditSale = isCreditSale;
  autoSaveStateRef.current.paymentAccountType = paymentAccountType;
  autoSaveStateRef.current.paymentAccountId = paymentAccountId;
  autoSaveStateRef.current.selectedCustomerId = selectedCustomerId;
  autoSaveStateRef.current.currentDraftId = currentDraftId;
  return {
    activeCurrency,
    activeLocation,
    activeRow,
    allLedgerAccounts,
    allLocations,
    apiInventory,
    authUser,
    autoSaveInProgressRef,
    autoSaveStateRef,
    bankAccounts,
    cashLedgerAccounts,
    clearActiveRowTimerRef,
    clientSaleIdRef,
    companySettings,
    currentDraftId,
    currentShift,
    customerAccounts,
    customerComboOpen,
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
    inventoryError,
    inventoryLoading,
    inventoryPickerSearchRef,
    invoiceWaStatus,
    isCreditSale,
    isSpCompany,
    itemListRef,
    lastAutosaved,
    lastSavedFingerprintRef,
    lastSoldPrices,
    mobileCustomerComboOpen,
    mobileSearchInputRef,
    navigate,
    notes,
    paymentAccountId,
    paymentAccountType,
    pendingAutoSend,
    pendingStockSend,
    posAssignedLocations,
    posLocationsLoading,
    posSelectedLocation,
    posUser,
    posWritesDisabled,
    printRef,
    refetchDrafts,
    refetchInventory,
    rows,
    saleDate,
    savedSale,
    searchTerm,
    selectedCell,
    selectedCompany,
    selectedCustomerId,
    selectedLocation,
    sendingInvoiceWhatsApp,
    sendingWhatsApp,
    setActiveRow,
    setCurrentDraftId,
    setCustomerComboOpen,
    setHighlightedIndex,
    setInvoiceWaStatus,
    setIsCreditSale,
    setLastAutosaved,
    setMobileCustomerComboOpen,
    setMobileTab,
    setNotes,
    setPaymentAccountId,
    setPaymentAccountType,
    setPendingAutoSend,
    setPendingStockSend,
    setPosSelectedLocation,
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
    setShowStockPrompt,
    setStockWaStatus,
    setZeroStockAlert,
    setZeroStockItem,
    showDraftDialog,
    showPrintDialog,
    showStockPrompt,
    stockInventory,
    stockInventoryLoading,
    stockPrintRef,
    stockWaStatus,
    t,
    toast,
    zeroStockAlert,
    zeroStockItem,
  };
}

export function usePOSStatePart1Part2({
  editVoucherId,
  posAssignedLocations,
  posSelectedLocation,
  posUser,
  setPaymentAccountId,
  setPaymentAccountType,
  setPosSelectedLocation,
}: Pick<
  Awaited<ReturnType<typeof usePOSStatePart1Part1>>,
  | "editVoucherId"
  | "posAssignedLocations"
  | "posSelectedLocation"
  | "posUser"
  | "setPaymentAccountId"
  | "setPaymentAccountType"
  | "setPosSelectedLocation"
>) {
  // ── Effects ────────────────────────────────────────────────────────────────

  // On edit, wait for the receipt's assigned location instead of defaulting
  // to the cashier's first shop (which could be a different shop).
  useEffect(() => {
    if (editVoucherId) return;
    if (posUser && posAssignedLocations.length > 0 && !posSelectedLocation) {
      setPosSelectedLocation(posAssignedLocations[0]);
    }
  }, [editVoucherId, posUser, posAssignedLocations, posSelectedLocation, setPosSelectedLocation]);

  // Set default cash account for POS users from location mapping — applies to
  // Supplier Partner companies too, same as normal ERP POS.
  useEffect(() => {
    if (editVoucherId) return;
    const locCashId = posSelectedLocation?.cashAccountId;
    if (posUser && locCashId) {
      setPaymentAccountType("cash");
      setPaymentAccountId(String(locCashId));
    }
  }, [posUser, posSelectedLocation, editVoucherId, setPaymentAccountType, setPaymentAccountId]);
  return {};
}
