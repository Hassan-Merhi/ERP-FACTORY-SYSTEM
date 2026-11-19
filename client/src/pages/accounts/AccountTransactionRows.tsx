import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type AccountTransactionRowsProps } from "./AccountTransactionRowsModel";
import { useAccountTransactionRowsState } from "./useAccountTransactionRowsState";
import { AccountTransactionRowsTableBody } from "./AccountTransactionRowsTableBody";
export type { AccountStatementRow, AccountTransactionRowsProps } from "./AccountTransactionRowsModel";

export function AccountTransactionRows({
  vouchersWithBalance,
  selectedVoucherIds,
  toggleSelectAll,
  toggleVoucherSelection,
  handleOpenVoucher,
  formatAmount: fmt,
  formatTransactionAmount,
  hideBalances,
  appMode,
  openingBalance,
  closingBalance,
  selectedAccount,
  formatDisplayDate,
  showCustomerDestination = false,
  destinationFilter = "all",
}: AccountTransactionRowsProps) {
  const {
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
  } = useAccountTransactionRowsState({
    vouchersWithBalance,
    selectedVoucherIds,
    toggleSelectAll,
    toggleVoucherSelection,
    hideBalances,
    appMode,
    selectedAccount,
    showCustomerDestination,
    destinationFilter,
  });

  return (
    <div
      ref={virtualRows.scrollRef}
      className="rounded-xl border overflow-auto max-h-[70vh] table-responsive print:border-0 print:max-h-none print:overflow-visible hidden md:block print:block!"
      data-testid="account-statement-scroll-region"
    >
      <Table wrapperClassName="overflow-visible border-0 rounded-none max-h-none">
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-[40px] py-3 print:hidden">
              <Checkbox
                checked={allSelectableSelected}
                onCheckedChange={handleSelectAllRows}
                data-testid="checkbox-select-all"
              />
            </TableHead>
            <TableHead className="col-date w-[100px] py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Date
            </TableHead>
            <TableHead className="col-particulars py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Particulars
            </TableHead>
            {appMode === "factory" && (
              <TableHead className="py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </TableHead>
            )}
            {showDestination && (
              <TableHead
                className="w-[150px] py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                data-testid="column-customer-destination"
              >
                Destination
              </TableHead>
            )}
            {!hideBalances && (
              <TableHead className="col-amount text-right w-[120px] py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Debit
              </TableHead>
            )}
            {!hideBalances && (
              <TableHead className="col-amount text-right w-[120px] py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Credit
              </TableHead>
            )}
            {!hideBalances && (
              <TableHead className="col-balance text-right w-[130px] py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Balance
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <AccountTransactionRowsTableBody
          appMode={appMode}
          balSide={balSide}
          closingBalance={closingBalance}
          colSpanMid={colSpanMid}
          destinationFilter={destinationFilter}
          formatAmount={fmt}
          formatDisplayDate={formatDisplayDate}
          formatTransactionAmount={formatTransactionAmount}
          handleOpenVoucher={handleOpenVoucher}
          hideBalances={hideBalances}
          isReferenceRow={isReferenceRow}
          isSupplier={isSupplier}
          openingBalance={openingBalance}
          renderedVouchers={renderedVouchers}
          selectedVoucherIds={selectedVoucherIds}
          showDestination={showDestination}
          toggleVoucherSelection={toggleVoucherSelection}
          totalColumns={totalColumns}
          totalCredit={totalCredit}
          totalDebit={totalDebit}
          virtualRows={virtualRows}
        />
      </Table>
    </div>
  );
}
