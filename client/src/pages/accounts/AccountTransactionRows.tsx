import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import type { Account, Transaction } from "./accountTypes";

const HISTORICAL_REFERENCE_TYPE = "Historical PO Reference";
const ACCOUNT_ROW_HEIGHT = 56;

export interface AccountStatementRow extends Transaction {
  totalDebit: number;
  totalCredit: number;
  runningBalance: number;
}

export interface AccountTransactionRowsProps {
  vouchersWithBalance: AccountStatementRow[];
  selectedVoucherIds: Set<number>;
  toggleSelectAll: () => void;
  toggleVoucherSelection: (id: number) => void;
  handleOpenVoucher: (v: AccountStatementRow) => void;
  formatAmount: (amt: number) => string;
  formatTransactionAmount?: (amt: number | string, currency: string) => string;
  hideBalances: boolean;
  appMode: string;
  openingBalance: number;
  closingBalance: number;
  selectedAccount: Account;
  formatDisplayDate: (date: Date | string) => string;
}

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
}: AccountTransactionRowsProps) {
  const colSpanMid = appMode === "factory" ? 3 : 2;
  const totalColumns = 3 + (appMode === "factory" ? 1 : 0) + (hideBalances ? 0 : 3);
  const totalDebit = vouchersWithBalance.reduce((s, v) => s + (v.totalDebit || 0), 0);
  const totalCredit = vouchersWithBalance.reduce((s, v) => s + (v.totalCredit || 0), 0);
  const isSupplier = selectedAccount.type === "supplier";
  const isReferenceRow = (v: AccountStatementRow) => v.voucherType === HISTORICAL_REFERENCE_TYPE;
  const selectableRows = vouchersWithBalance.filter((v) => !isReferenceRow(v));
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((v) => selectedVoucherIds.has(v.voucherId));
  const virtualRows = useBoundedTableRows({
    rowCount: vouchersWithBalance.length,
    rowHeight: ACCOUNT_ROW_HEIGHT,
    minimumRows: 120,
    overscan: 16,
  });
  const renderedVouchers = vouchersWithBalance.slice(virtualRows.startIndex, virtualRows.endIndex);

  const handleSelectAllRows = () => {
    if (selectableRows.length === vouchersWithBalance.length) {
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

  return (
    <div
      ref={virtualRows.scrollRef}
      className="rounded-xl border overflow-auto max-h-[70vh] table-responsive print:border-0 print:max-h-none print:overflow-visible hidden md:block print:!block"
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
        <TableBody>
          <TableRow className="bg-accent/20 border-b border-border/60" data-testid="row-opening-balance">
            <TableCell className="py-3 print:hidden" />
            <TableCell className="py-3 text-xs text-muted-foreground tabular-nums font-mono" colSpan={colSpanMid}>
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
                  <span className="ml-1 text-[10px] opacity-60">
                    {isSupplier ? (openingBalance > 0 ? "Cr" : "Dr") : openingBalance >= 0 ? "Dr" : "Cr"}
                  </span>
                </>
              )}
            </TableCell>
          </TableRow>

          {virtualRows.topSpacerHeight > 0 && (
            <TableRow aria-hidden="true" data-testid="account-virtual-spacer-top">
              <TableCell
                colSpan={totalColumns}
                className="p-0 border-0"
                style={{ height: virtualRows.topSpacerHeight }}
              />
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
                    {isReference ? "Historical PO reference · reference only · balance unchanged" : v.voucherType}
                  </div>
                </TableCell>
                {appMode === "factory" && (
                  <TableCell className="py-3 text-[11px] text-muted-foreground max-w-[280px] truncate">
                    {v.narration}
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
                        <span className="ml-1 text-[10px] font-normal opacity-50">
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
                  Period Total
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
                  <span className="ml-1 text-[10px] font-normal opacity-60">{balSide(closingBalance)}</span>
                </TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
