// Extracted from ./AccountTransactionRows.tsx
import { Checkbox } from "@/components/ui/checkbox";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { HISTORICAL_FACTORY_INVOICE_TYPE, type AccountTransactionRowsProps } from "./AccountTransactionRowsModel";
import { useAccountTransactionRowsState } from "./useAccountTransactionRowsState";

export function AccountTransactionRowsTableBody({
  appMode,
  balSide,
  closingBalance,
  colSpanMid,
  destinationFilter = "all",
  formatAmount: fmt,
  formatDisplayDate,
  formatTransactionAmount,
  handleOpenVoucher,
  hideBalances,
  isReferenceRow,
  isSupplier,
  openingBalance,
  renderedVouchers,
  selectedVoucherIds,
  showDestination,
  toggleVoucherSelection,
  totalColumns,
  totalCredit,
  totalDebit,
  virtualRows,
}: Pick<
  AccountTransactionRowsProps,
  | "appMode"
  | "closingBalance"
  | "destinationFilter"
  | "formatAmount"
  | "formatDisplayDate"
  | "formatTransactionAmount"
  | "handleOpenVoucher"
  | "hideBalances"
  | "openingBalance"
  | "selectedVoucherIds"
  | "toggleVoucherSelection"
> &
  Pick<
    ReturnType<typeof useAccountTransactionRowsState>,
    | "balSide"
    | "colSpanMid"
    | "isReferenceRow"
    | "isSupplier"
    | "renderedVouchers"
    | "showDestination"
    | "totalColumns"
    | "totalCredit"
    | "totalDebit"
    | "virtualRows"
  >) {
  return (
    <TableBody>
      {!hideBalances && (
        <TableRow className="bg-accent/20 border-b border-border/60" data-testid="row-opening-balance">
          <TableCell className="py-3 print:hidden" />
          <TableCell className="py-3 text-xs text-muted-foreground tabular-nums font-mono" />
          <TableCell className="py-3 text-xs text-muted-foreground tabular-nums font-mono" colSpan={colSpanMid - 1}>
            <span className="font-semibold text-foreground">Opening Balance</span>
          </TableCell>
          <TableCell className="text-right font-mono py-3 text-sm tabular-nums">
            {!hideBalances &&
              (isSupplier
                ? openingBalance < 0
                  ? fmt(Math.abs(openingBalance))
                  : "—"
                : openingBalance > 0
                  ? fmt(openingBalance)
                  : "—")}
          </TableCell>
          <TableCell className="text-right font-mono py-3 text-sm tabular-nums">
            {!hideBalances &&
              (isSupplier
                ? openingBalance > 0
                  ? fmt(openingBalance)
                  : "—"
                : openingBalance < 0
                  ? fmt(Math.abs(openingBalance))
                  : "—")}
          </TableCell>
          <TableCell className="text-right font-mono font-semibold py-3 text-sm tabular-nums">
            {!hideBalances && (
              <>
                {fmt(Math.abs(openingBalance))}
                <span className="ml-1 text-[11px] opacity-60">
                  {isSupplier ? (openingBalance > 0 ? "Cr" : "Dr") : openingBalance >= 0 ? "Dr" : "Cr"}
                </span>
              </>
            )}
          </TableCell>
        </TableRow>
      )}

      {virtualRows.topSpacerHeight > 0 && (
        <TableRow aria-hidden="true" data-testid="account-virtual-spacer-top">
          <TableCell colSpan={totalColumns} className="p-0 border-0" style={{ height: virtualRows.topSpacerHeight }} />
        </TableRow>
      )}

      {renderedVouchers.map((v) => {
        const isReference = isReferenceRow(v);
        return (
          <TableRow
            key={`${v.voucherId}-${v.entryId}`}
            className={
              isReference
                ? "bg-muted/15 border-b border-border/40 last:border-0"
                : "group hover:bg-muted/30 cursor-pointer border-b border-border/40 last:border-0"
            }
            onClick={isReference ? undefined : () => handleOpenVoucher(v)}
            data-testid={
              isReference ? `row-historical-reference-${Math.abs(v.voucherId)}` : `row-voucher-${v.voucherId}`
            }
          >
            <TableCell className="py-3 print:hidden" onClick={(e) => e.stopPropagation()}>
              {isReference ? null : (
                <Checkbox
                  checked={selectedVoucherIds.has(v.voucherId)}
                  onCheckedChange={() => toggleVoucherSelection(v.voucherId)}
                />
              )}
            </TableCell>
            <TableCell className="py-3 font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">
              {formatDisplayDate(v.voucherDate)}
            </TableCell>
            <TableCell className="py-3 max-w-[420px]">
              <div className="text-sm font-medium text-foreground leading-snug truncate">
                {v.voucherDescription || v.narration || (
                  <span className="text-muted-foreground italic">No description</span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {isReference
                  ? v.voucherType === HISTORICAL_FACTORY_INVOICE_TYPE
                    ? "Historical factory invoice · included in customer balance"
                    : "Historical PO reference · reference only · balance unchanged"
                  : v.voucherType}
              </div>
            </TableCell>
            {appMode === "factory" && (
              <TableCell className="py-3 text-[11px] text-muted-foreground max-w-[280px] truncate">
                {v.narration}
              </TableCell>
            )}
            {showDestination && (
              <TableCell
                className="py-3 text-xs text-muted-foreground max-w-[210px] truncate"
                data-testid="cell-customer-destination"
              >
                {v.destination?.trim() || "—"}
              </TableCell>
            )}
            {!hideBalances && (
              <TableCell className="py-3 text-right font-mono text-sm tabular-nums">
                {v.totalDebit > 0 ? (
                  <span className="text-foreground">
                    {formatTransactionAmount && v.transactionCurrency
                      ? formatTransactionAmount(v.transactionDebitAmount || v.totalDebit, v.transactionCurrency)
                      : fmt(v.totalDebit)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </TableCell>
            )}
            {!hideBalances && (
              <TableCell className="py-3 text-right font-mono text-sm tabular-nums">
                {v.totalCredit > 0 ? (
                  <span className="text-foreground">
                    {formatTransactionAmount && v.transactionCurrency
                      ? formatTransactionAmount(v.transactionCreditAmount || v.totalCredit, v.transactionCurrency)
                      : fmt(v.totalCredit)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </TableCell>
            )}
            {!hideBalances && (
              <TableCell className="py-3 text-right font-mono text-sm tabular-nums font-semibold">
                {v.runningBalance != null ? (
                  <>
                    {fmt(Math.abs(v.runningBalance))}
                    <span className="ml-1 text-[11px] font-normal opacity-50">
                      {v.runningBalance >= 0 ? "Dr" : "Cr"}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </TableCell>
            )}
          </TableRow>
        );
      })}

      {virtualRows.bottomSpacerHeight > 0 && (
        <TableRow aria-hidden="true" data-testid="account-virtual-spacer-bottom">
          <TableCell
            colSpan={totalColumns}
            className="p-0 border-0"
            style={{ height: virtualRows.bottomSpacerHeight }}
          />
        </TableRow>
      )}

      {!hideBalances && (
        <>
          <TableRow className="bg-muted/20 border-t-2 text-xs font-medium text-muted-foreground">
            <TableCell className="py-2 print:hidden" />
            <TableCell colSpan={colSpanMid} className="py-2 text-right pr-4 text-xs text-muted-foreground">
              Opening Balance
            </TableCell>
            <TableCell className="py-2 text-right font-mono tabular-nums text-sm">
              {isSupplier
                ? openingBalance < 0
                  ? fmt(Math.abs(openingBalance))
                  : "—"
                : openingBalance > 0
                  ? fmt(openingBalance)
                  : "—"}
            </TableCell>
            <TableCell className="py-2 text-right font-mono tabular-nums text-sm">
              {isSupplier
                ? openingBalance > 0
                  ? fmt(openingBalance)
                  : "—"
                : openingBalance < 0
                  ? fmt(Math.abs(openingBalance))
                  : "—"}
            </TableCell>
            <TableCell className="py-2" />
          </TableRow>
          <TableRow className="bg-muted/20 text-xs font-medium text-muted-foreground">
            <TableCell className="py-2 print:hidden" />
            <TableCell colSpan={colSpanMid} className="py-2 text-right pr-4 text-xs text-muted-foreground">
              {showDestination && destinationFilter !== "all" ? "Period Total (all destinations)" : "Period Total"}
            </TableCell>
            <TableCell className="py-2 text-right font-mono tabular-nums text-sm">
              {totalDebit > 0 ? fmt(totalDebit) : "—"}
            </TableCell>
            <TableCell className="py-2 text-right font-mono tabular-nums text-sm">
              {totalCredit > 0 ? fmt(totalCredit) : "—"}
            </TableCell>
            <TableCell className="py-2" />
          </TableRow>
          <TableRow className="bg-muted/50 border-t text-sm font-semibold">
            <TableCell className="py-2.5 print:hidden" />
            <TableCell colSpan={colSpanMid} className="py-2.5 text-right pr-4">
              Closing Balance
            </TableCell>
            <TableCell className="py-2.5" />
            <TableCell className="py-2.5" />
            <TableCell className="py-2.5 text-right font-mono tabular-nums">
              {fmt(Math.abs(closingBalance))}
              <span className="ml-1 text-[11px] font-normal opacity-60">{balSide(closingBalance)}</span>
            </TableCell>
          </TableRow>
        </>
      )}
    </TableBody>
  );
}
