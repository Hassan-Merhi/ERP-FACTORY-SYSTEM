// Extracted from ./AccountTransactionRows.tsx
import { useMemo } from "react";
import { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import {
  HISTORICAL_REFERENCE_TYPE,
  HISTORICAL_FACTORY_INVOICE_TYPE,
  ACCOUNT_ROW_HEIGHT,
  type AccountStatementRow,
  type AccountTransactionRowsProps,
} from "./AccountTransactionRowsModel";

export function useAccountTransactionRowsState({
  vouchersWithBalance,
  selectedVoucherIds,
  toggleSelectAll,
  toggleVoucherSelection,
  hideBalances,
  appMode,
  selectedAccount,
  showCustomerDestination = false,
  destinationFilter = "all",
}: Pick<
  AccountTransactionRowsProps,
  | "vouchersWithBalance"
  | "selectedVoucherIds"
  | "toggleSelectAll"
  | "toggleVoucherSelection"
  | "hideBalances"
  | "appMode"
  | "selectedAccount"
  | "showCustomerDestination"
  | "destinationFilter"
>) {
  const showDestination = appMode === "factory" && showCustomerDestination;
  const colSpanMid = (appMode === "factory" ? 3 : 2) + (showDestination ? 1 : 0);
  const totalColumns = 3 + (appMode === "factory" ? 1 : 0) + (showDestination ? 1 : 0) + (hideBalances ? 0 : 3);
  const displayedVouchers = useMemo(() => {
    if (!showDestination || destinationFilter === "all") return vouchersWithBalance;
    if (destinationFilter === "__none__") return vouchersWithBalance.filter((v) => !v.destination?.trim());
    return vouchersWithBalance.filter((v) => v.destination?.trim() === destinationFilter);
  }, [vouchersWithBalance, showDestination, destinationFilter]);
  const { totalDebit, totalCredit, selectableRows } = useMemo(() => {
    let debit = 0;
    let credit = 0;
    const selectable: AccountStatementRow[] = [];

    for (const voucher of vouchersWithBalance) {
      debit += voucher.totalDebit || 0;
      credit += voucher.totalCredit || 0;
    }
    for (const voucher of displayedVouchers) {
      if (voucher.voucherType !== HISTORICAL_REFERENCE_TYPE && voucher.voucherType !== HISTORICAL_FACTORY_INVOICE_TYPE)
        selectable.push(voucher);
    }

    return { totalDebit: debit, totalCredit: credit, selectableRows: selectable };
  }, [vouchersWithBalance, displayedVouchers]);
  const isSupplier = selectedAccount.type === "supplier";
  const isReferenceRow = (v: AccountStatementRow) =>
    v.voucherType === HISTORICAL_REFERENCE_TYPE || v.voucherType === HISTORICAL_FACTORY_INVOICE_TYPE;
  const allSelectableSelected = useMemo(
    () => selectableRows.length > 0 && selectableRows.every((v) => selectedVoucherIds.has(v.voucherId)),
    [selectableRows, selectedVoucherIds]
  );
  const virtualRows = useBoundedTableRows({
    rowCount: displayedVouchers.length,
    rowHeight: ACCOUNT_ROW_HEIGHT,
    minimumRows: 120,
    overscan: 16,
  });
  const renderedVouchers = useMemo(
    () => displayedVouchers.slice(virtualRows.startIndex, virtualRows.endIndex),
    [displayedVouchers, virtualRows.endIndex, virtualRows.startIndex]
  );

  const handleSelectAllRows = () => {
    if (selectableRows.length === vouchersWithBalance.length && destinationFilter === "all") {
      toggleSelectAll();
      return;
    }
    if (allSelectableSelected) {
      selectableRows.forEach((v) => {
        if (selectedVoucherIds.has(v.voucherId)) toggleVoucherSelection(v.voucherId);
      });
    } else {
      selectableRows.forEach((v) => {
        if (!selectedVoucherIds.has(v.voucherId)) toggleVoucherSelection(v.voucherId);
      });
    }
  };

  const balSide = (val: number) => (val >= 0 ? "Dr" : "Cr");
  return {
    showDestination,
    colSpanMid,
    totalColumns,
    totalDebit,
    totalCredit,
    isSupplier,
    isReferenceRow,
    allSelectableSelected,
    virtualRows,
    renderedVouchers,
    handleSelectAllRows,
    balSide,
  };
}
