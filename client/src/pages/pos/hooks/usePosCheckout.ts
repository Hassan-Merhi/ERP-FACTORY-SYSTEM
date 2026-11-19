import { getErrorDetails } from "@shared/errorUtils";
import type { PosDraftItem, PosDraftSummary, PosSalePayload, SaleRow } from "../pos-components/posTypes";
import type { PosCheckoutParams } from "./usePosCheckoutTypes";

/**
 * Sale lifecycle actions: validating + saving a sale, starting a new sale,
 * and loading a saved draft back into the grid.
 * Extracted from usePosHandlers.ts (Phase 18 structural split) — logic unchanged.
 */
export function usePosCheckout({
  rows,
  isCreditSale,
  paymentAccountType,
  paymentAccountId,
  selectedCustomerId,
  notes,
  saleDate,
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
  lastSavedFingerprintRef,
  clientSaleIdRef,
  activeCurrency,
  exchangeRate,
  dailyExchangeRate,
  activeLocation,
  editVoucherId,
  editVoucher,
  isSpCompany,
  isGoldenCoastPhase6,
  goldenCoastReadinessLoading,
  goldenCoastReadinessBlocked,
  goldenCoastReadinessBlockers,
  inventory,
  currentShift,
  posUser,
  saveMutation,
  toast,
  focusCell,
}: PosCheckoutParams) {
  // ISSUE 3: Full payload with shiftId, clientSaleId, currency, exchangeRate, correct rate conversion
  const handleSaveSale = () => {
    const editingAsPos = Boolean(posUser && editVoucherId);
    if (editingAsPos && (!editVoucher || !activeLocation || activeLocation.id !== editVoucher.locationId)) {
      toast({
        title: "Sale not ready",
        description: "The original receipt and its assigned location must finish loading before editing.",
        variant: "destructive",
      });
      return;
    }
    if (!activeLocation && !editVoucherId) {
      toast({ title: "Missing information", description: "Please select a location", variant: "destructive" });
      return;
    }
    if (isSpCompany && goldenCoastReadinessLoading) {
      toast({
        title: "POS is still loading",
        description: "Please wait while the active Supplier Partner POS configuration is verified.",
        variant: "destructive",
      });
      return;
    }
    if (isSpCompany && isGoldenCoastPhase6 && goldenCoastReadinessBlocked) {
      toast({
        title: "Golden Coast POS unavailable",
        description:
          goldenCoastReadinessBlockers?.[0] ||
          "Resolve the Golden Coast accounting setup issue before sales can be posted.",
        variant: "destructive",
      });
      return;
    }
    if (!editingAsPos && !isCreditSale && !paymentAccountId) {
      toast({ title: "Missing information", description: "Please select a payment account", variant: "destructive" });
      return;
    }
    if (!editingAsPos && isCreditSale && !selectedCustomerId) {
      toast({
        title: "Missing information",
        description: "Please select a customer for credit sale",
        variant: "destructive",
      });
      return;
    }
    // An edited Kwacha or CFA sale stays in its own currency at its locked rate,
    // even while the grid shows it in USD; its local prices then follow from the USD ones.
    const editedLocal = editVoucherId && (editVoucher?.currency === "ZMW" || editVoucher?.currency === "CFA");
    const saleCurrency = editedLocal ? (editVoucher!.currency as "ZMW" | "CFA") : activeCurrency;
    const salePrice = (row: SaleRow) =>
      saleCurrency === activeCurrency ? row.rate : Number((row.rateUSD * (exchangeRate ?? NaN)).toFixed(2));
    if (saleCurrency !== "USD" && (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
      toast({
        title: "Missing information",
        description: "Please enter an exchange rate for this transaction.",
        variant: "destructive",
      });
      return;
    }
    const invalidRow = rows.find((r) => r.itemName?.trim() && !r.stockItemId);
    if (invalidRow) {
      const invalidIdx = rows.indexOf(invalidRow);
      toast({
        title: "Invalid item",
        description: `"${invalidRow.itemName}" is not valid. Please select an item from the list.`,
        variant: "destructive",
      });
      setSelectedCell({ row: invalidIdx, col: 0 });
      focusCell(invalidIdx, 0);
      return;
    }
    const validItems = rows.filter((r) => r.stockItemId && r.quantity > 0 && r.rate > 0);
    if (validItems.length === 0) {
      toast({
        title: "Missing information",
        description: "Please add at least one item to the sale",
        variant: "destructive",
      });
      return;
    }

    if (
      saleCurrency === "ZMW" &&
      validItems.some(
        (row) =>
          !Number.isFinite(salePrice(row)) ||
          salePrice(row) <= 0 ||
          Math.abs(salePrice(row) * 100 - Math.round(salePrice(row) * 100)) > 0.000001
      )
    ) {
      toast({
        title: "Invalid Kwacha price",
        description: "Enter a positive unit price to two decimal places (ngwee).",
        variant: "destructive",
      });
      return;
    }

    const saleData = {
      locationId: activeLocation?.id || editVoucher?.locationId,
      shiftId: posUser && currentShift ? currentShift.id : undefined,
      clientSaleId: !editVoucherId ? clientSaleIdRef.current : undefined,
      paymentAccountType: editingAsPos ? undefined : isCreditSale ? "credit" : paymentAccountType,
      paymentAccountId: editingAsPos
        ? undefined
        : isCreditSale
          ? parseInt(selectedCustomerId)
          : parseInt(paymentAccountId!),
      isCreditSale,
      notes,
      voucherDate: saleDate,
      currency: saleCurrency,
      exchangeRate: saleCurrency !== "USD" && exchangeRate ? exchangeRate.toString() : undefined,
      items: validItems.map((row) => {
        const rateInUSD =
          saleCurrency !== "USD" && dailyExchangeRate ? salePrice(row) / dailyExchangeRate : row.rateUSD;
        return {
          stockItemId: row.stockItemId,
          salesItemId: row.salesItemId,
          quantity: row.quantity.toString(),
          rate: rateInUSD.toFixed(6),
          // USD is the inventory/ledger basis. Preserve the *typed* Kwacha
          // unit price separately so the server can verify the round-trip
          // against the rate locked for this exact sale date.
          originalCurrencyRate: saleCurrency === "USD" ? undefined : salePrice(row).toFixed(2),
          stockItemName: row.itemName,
          stockItemCode: row.stockItemCode,
          configuredPrice: row.configuredPrice,
        };
      }),
    };

    if (saleData.items.some((item) => !Number.isFinite(Number(item.rate)) || Number(item.rate) <= 0)) {
      toast({
        title: "Invalid foreign-currency price",
        description: "Check the exchange rate and item prices before saving.",
        variant: "destructive",
      });
      return;
    }
    saveMutation.mutate(saleData as PosSalePayload);
  };

  const handleNewSale = () => {
    // A retry of the current sale must keep its request identity, but a new
    // transaction must never reuse an identity from a failed attempt.
    clientSaleIdRef.current = crypto.randomUUID();
    setRows([{ id: "1", itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 }]);
    setNotes("");
    setSavedSale(null);
    setShowPrintDialog(false);
    setSaleJustCompleted(false);
    setCurrentDraftId(null);
    setStockWaStatus("idle");
    setInvoiceWaStatus("idle");
    setPendingStockSend(false);
    lastSavedFingerprintRef.current = "";
    setLastAutosaved(null);
    setMobileTab("items");
  };

  // ISSUE 7: Real draft loading
  const handleLoadDraft = async (draftId: number) => {
    try {
      const res = await fetch(`/api/pos/drafts/${draftId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load draft");
      const draft = (await res.json()) as PosDraftSummary;

      if (draft.paymentAccountType) setPaymentAccountType(draft.paymentAccountType);
      if (draft.paymentAccountId) setPaymentAccountId(String(draft.paymentAccountId));
      setIsCreditSale(draft.isCreditSale || false);
      if (draft.isCreditSale && draft.paymentAccountId) {
        setSelectedCustomerId(String(draft.paymentAccountId));
      }
      setNotes(draft.notes || "");

      const draftRows = (Array.isArray(draft.items) ? draft.items : []).map((item: PosDraftItem, index: number) => {
        const rate = parseFloat(String(item.rate ?? 0));
        const inventoryItem = inventory.find((i) => i.stockItemId === item.stockItemId);
        return {
          id: String(index + 1),
          itemName: item.stockItemName ?? "",
          stockItemCode: item.stockItemCode || "",
          stockItemId: item.stockItemId,
          quantity: parseFloat(String(item.quantity ?? 0)),
          rate,
          rateUSD: rate,
          amount: parseFloat(String(item.amount ?? 0)),
          configuredPrice: inventoryItem?.configuredPrice,
        };
      });
      draftRows.push({
        id: String(draftRows.length + 1),
        itemName: "",
        stockItemCode: "",
        stockItemId: undefined,
        quantity: 0,
        rate: 0,
        rateUSD: 0,
        amount: 0,
        configuredPrice: undefined,
      });
      setRows(draftRows);
      setCurrentDraftId(draftId);
      setShowDraftDialog(false);
      toast({ title: "Draft Loaded", description: "Transaction has been loaded from draft" });
    } catch (error) {
      toast({
        title: "Load failed",
        description: getErrorDetails(error).message || "Failed to load draft",
        variant: "destructive",
      });
    }
  };

  return { handleSaveSale, handleNewSale, handleLoadDraft };
}
