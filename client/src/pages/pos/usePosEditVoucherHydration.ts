// Edit-voucher hydration for the ERP POS page.
//
// Holds the effects that, when POS is opened to edit an existing sale voucher,
// (1) select the voucher's location, (2) populate rows / notes / date once per
// edit session and (3) infer the payment account type from the debit entry.
// Extracted verbatim from POS.tsx to keep that page under the repository's
// god-file line cap; effect order and dependencies are unchanged.
import { useEffect, useRef } from "react";
import type { useLocation as useLocationContext } from "@/contexts/LocationContext";
import type { PosEditSalesItem } from "./pos-components/posTypes";
import type { usePosQueries } from "./hooks/usePosQueries";
import type { usePosState } from "./hooks/usePosState";

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
    Pick<PosQueries, "editVoucher" | "editVoucherViewEntries" | "allLocations" | "allLedgerAccounts">,
    Pick<LocationContextValue, "selectedLocation" | "setSelectedLocation"> {
  editVoucherId?: string;
}

export function usePosEditVoucherHydration({
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
}: UsePosEditVoucherHydrationArgs) {
  // Set location from edit voucher
  useEffect(() => {
    if (editVoucher && editVoucher.locationId && !selectedLocation && allLocations.length > 0) {
      const voucherLocation = allLocations.find((loc) => loc.id === editVoucher.locationId);
      if (voucherLocation) setSelectedLocation(voucherLocation);
    }
  }, [editVoucher, allLocations, selectedLocation, setSelectedLocation]);

  // Guard: rows + notes + date are only populated ONCE per edit session.
  // Without this, any dependency change (e.g. allLedgerAccounts re-fetching on
  // window focus) would call setRows() again and wipe the user's in-progress edits.
  const editRowsInitRef = useRef(false);

  // Effect 1: Populate rows / notes / date from the voucher — runs once.
  useEffect(() => {
    if (!editVoucherId) {
      editRowsInitRef.current = false;
      return;
    }
    if (editRowsInitRef.current) return; // already populated; never reset user edits

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

    const newRows = resolvedItems.map((item: PosEditSalesItem, index: number) => ({
      id: String(index + 1),
      itemName: item.stockItemName || "",
      stockItemCode: item.stockItemCode || "",
      // Ensure stockItemId is always a number (guard against 0/null from old data)
      stockItemId: item.stockItemId ? Number(item.stockItemId) : undefined,
      salesItemId: item.id,
      quantity: parseFloat(String(item.quantity)),
      rate:
        editVoucher?.currency === "ZMW" && editVoucher.exchangeRate
          ? Number((Number(item.sellingPrice) * Number(editVoucher.exchangeRate)).toFixed(2))
          : parseFloat(String(item.sellingPrice)),
      rateUSD: parseFloat(String(item.sellingPrice)),
      amount: parseFloat(String(item.totalSales)),
      configuredPrice: parseFloat(String(item.configuredPrice || "0")) || undefined,
    }));
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
    editRowsInitRef.current = true;

    if (editVoucher.description) setNotes(editVoucher.description);
    if (editVoucher.voucherDate) setSaleDate(editVoucher.voucherDate);
  }, [editVoucherId, editVoucher, editVoucherViewEntries, setRows, setNotes, setSaleDate]);

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
