// Edit-voucher hydration for the ERP POS page.
//
// Holds the effects that, when POS is opened to edit an existing sale voucher,
// (1) select the voucher's location, (2) populate rows / notes / date once per
// edit session and (3) infer the payment account type from the debit entry.
// Extracted verbatim from POS.tsx to keep that page under the repository's
// god-file line cap; effect order and dependencies are unchanged.
import { useEffect, useRef } from "react";
import type { useLocation as useLocationContext } from "@/contexts/LocationContext";
import type { Location, PosEditSalesItem } from "./pos-components/posTypes";
import type { AuthMe } from "@shared/apiTypes";
import type { usePosQueries } from "./hooks/usePosQueries";
import type { usePosState } from "./hooks/usePosState";
import { resolvePostedZmwUnitPrices } from "@shared/posZmwMoney";

type PosState = ReturnType<typeof usePosState>;
type PosQueries = ReturnType<typeof usePosQueries>;
type LocationContextValue = ReturnType<typeof useLocationContext>;

export interface UsePosEditVoucherHydrationArgs
  extends
    Pick<
      PosState,
      | "setRows"
      | "setNotes"
      | "setSaleDate"
      | "setPaymentAccountType"
      | "setPaymentAccountId"
      | "setIsCreditSale"
      | "setSelectedCustomerId"
    >,
    Pick<
      PosQueries,
      "editVoucher" | "editVoucherViewEntries" | "allLocations" | "posAssignedLocations" | "allLedgerAccounts"
    >,
    Pick<LocationContextValue, "selectedLocation" | "setSelectedLocation"> {
  editVoucherId?: string;
  /** Currency the grid shows; a Kwacha sale can be viewed in USD. Defaults to the sale's own. */
  activeCurrency?: string;
  posUser?: AuthMe | null;
  posSelectedLocation: Location | null;
  setPosSelectedLocation: (location: Location) => void;
}

export function usePosEditVoucherHydration({
  editVoucherId,
  activeCurrency,
  editVoucher,
  editVoucherViewEntries,
  allLocations,
  posAssignedLocations,
  posUser,
  posSelectedLocation,
  setPosSelectedLocation,
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
}: UsePosEditVoucherHydrationArgs) {
  // Read at hydration time only; later USD/ZMW switches convert the rows.
  const activeCurrencyRef = useRef(activeCurrency);
  activeCurrencyRef.current = activeCurrency;
  // Select the ORIGINAL sale location. POS users only receive their assigned
  // locations, so allLocations is intentionally empty for those users.
  useEffect(() => {
    if (!editVoucherId || !editVoucher?.locationId) return;
    const locations = posUser ? posAssignedLocations : allLocations;
    const voucherLocation = locations.find((loc) => loc.id === editVoucher.locationId);
    if (!voucherLocation) return; // The server still enforces location access.
    if (posUser) {
      if (posSelectedLocation?.id !== voucherLocation.id) setPosSelectedLocation(voucherLocation);
    } else if (selectedLocation?.id !== voucherLocation.id) {
      setSelectedLocation(voucherLocation);
    }
  }, [
    editVoucherId,
    editVoucher?.locationId,
    posUser,
    posAssignedLocations,
    allLocations,
    posSelectedLocation?.id,
    selectedLocation?.id,
    setPosSelectedLocation,
    setSelectedLocation,
  ]);

  // Guard: rows + notes + date are only populated ONCE per edit session.
  // Without this, any dependency change (e.g. allLedgerAccounts re-fetching on
  // window focus) would call setRows() again and wipe the user's in-progress edits.
  const editRowsInitRef = useRef<string | null>(null);

  // Effect 1: Populate rows / notes / date from the voucher — runs once.
  useEffect(() => {
    if (!editVoucherId) {
      editRowsInitRef.current = null;
      return;
    }
    if (editRowsInitRef.current === editVoucherId) return; // never overwrite in-progress edits

    // Primary source: salesItems attached to the voucher object.
    // Fallback: view-entries endpoint (populated when salesItems is missing from the voucher).
    const resolvedItems =
      Array.isArray(editVoucher?.salesItems) && editVoucher.salesItems.length > 0
        ? editVoucher.salesItems
        : (editVoucherViewEntries ?? [])
            .filter((e) => e.isStockItem || e.stockItemId)
            .map((e) => ({
              id: e.id,
              stockItemId: e.stockItemId,
              stockItemName: e.stockItemName || e.accountName || "",
              stockItemCode: e.stockItemCode || e.accountCode || "",
              quantity: e.quantity,
              sellingPrice: e.rate ?? e.sellingPrice ?? "0",
              totalSales: e.totalAmount ?? e.totalSales ?? e.creditAmount ?? "0",
              costPrice: e.costPrice,
              configuredPrice: e.configuredPrice,
            }));

    if (!editVoucher || resolvedItems.length === 0) return;

    // The Kwacha price is the sale's real price; USD follows from it, so a
    // USD/ZMW switch never drifts off the price the cashier typed.
    const lockedRate = editVoucher.currency === "ZMW" ? Number(editVoucher.exchangeRate) : 0;
    let kwachaPrices: ReturnType<typeof resolvePostedZmwUnitPrices> | null = null;
    if (lockedRate > 0) {
      const postedKwacha =
        editVoucher.nativeZmwTotal ??
        editVoucher.entries?.find((e) => e.transactionCurrency === "ZMW" && Number(e.transactionDebitAmount) > 0)
          ?.transactionDebitAmount;
      try {
        kwachaPrices = resolvePostedZmwUnitPrices(
          resolvedItems.map((item: PosEditSalesItem) => ({ quantity: item.quantity, rate: item.sellingPrice })),
          lockedRate,
          postedKwacha
        );
      } catch {
        kwachaPrices = null; // a stored line that is not a valid sale line: load plain USD prices
      }
    }

    const newRows = resolvedItems.map((item: PosEditSalesItem, index: number) => {
      const quantity = Number(item.quantity ?? 0);
      const storedUsd = Number(item.sellingPrice ?? 0);
      const kwacha = kwachaPrices?.[index] ?? null;
      const usdRate = kwacha === null ? storedUsd : kwacha.div(lockedRate).toNumber();
      const rate =
        kwacha === null
          ? usdRate
          : activeCurrencyRef.current === "USD"
            ? Number(usdRate.toFixed(2))
            : kwacha.toNumber();
      return {
        id: String(index + 1),
        itemName: item.stockItemName || "",
        stockItemCode: item.stockItemCode || "",
        stockItemId: item.stockItemId ? Number(item.stockItemId) : undefined,
        salesItemId: item.id,
        quantity,
        rate,
        rateUSD: usdRate,
        // The POS-safe receipt response has no accounting line totals.
        // A grid row must still display its original native-currency amount.
        amount: Number((quantity * rate).toFixed(2)),
        configuredPrice: parseFloat(String(item.configuredPrice || "0")) || undefined,
      };
    });
    newRows.push({
      id: String(newRows.length + 1),
      itemName: "",
      stockItemCode: "",
      stockItemId: undefined,
      salesItemId: undefined,
      quantity: 0,
      rate: 0,
      rateUSD: 0,
      amount: 0,
      configuredPrice: undefined,
    });
    setRows(newRows);
    editRowsInitRef.current = editVoucherId;

    setNotes(editVoucher.description ?? "");
    if (editVoucher.voucherDate) setSaleDate(editVoucher.voucherDate);
    setIsCreditSale(Boolean(editVoucher.isCreditSale));
  }, [editVoucherId, editVoucher, editVoucherViewEntries, setRows, setNotes, setSaleDate, setIsCreditSale]);

  // Effect 2: Detect payment account type once ledger accounts are available.
  // This is separate from Effect 1 so that ledger-account re-fetches never
  // reset the rows the user is actively editing.
  useEffect(() => {
    if (!editVoucher || !editVoucher.entries || editVoucher.entries.length === 0) return;

    const debitEntry = editVoucher.entries.find((e) => parseFloat(String(e.debitAmount || "0")) > 0);
    if (!debitEntry) return;

    if (debitEntry.bankAccountId) {
      setPaymentAccountType("bank");
      setPaymentAccountId(String(debitEntry.bankAccountId));
      setIsCreditSale(false);
    } else if (debitEntry.ledgerAccountId) {
      const ledgerAccount = allLedgerAccounts.find((acc) => acc.id === debitEntry.ledgerAccountId);
      if (ledgerAccount) {
        if (ledgerAccount.accountType === "Cash") {
          setPaymentAccountType("cash");
          setPaymentAccountId(String(debitEntry.ledgerAccountId));
          setIsCreditSale(false);
        } else {
          setPaymentAccountType("credit");
          setPaymentAccountId(String(debitEntry.ledgerAccountId));
          setIsCreditSale(true);
          setSelectedCustomerId(String(debitEntry.ledgerAccountId));
        }
      } else {
        const isCreditSaleEntry = debitEntry.narration?.includes("Credit Sale");
        if (isCreditSaleEntry) {
          setPaymentAccountType("credit");
          setIsCreditSale(true);
          setSelectedCustomerId(String(debitEntry.ledgerAccountId));
        } else {
          setPaymentAccountType("cash");
          setIsCreditSale(false);
        }
        setPaymentAccountId(String(debitEntry.ledgerAccountId));
      }
    }
  }, [
    editVoucher,
    allLedgerAccounts,
    setPaymentAccountType,
    setPaymentAccountId,
    setIsCreditSale,
    setSelectedCustomerId,
  ]);
}
