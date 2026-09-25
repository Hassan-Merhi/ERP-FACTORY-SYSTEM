import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErpMobileRecordCard, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import type { AccountStatementRow, AccountTransactionRowsProps } from "./AccountTransactionRows";

const HISTORICAL_REFERENCE_TYPE = "Historical PO Reference";
/** Cards render in pages so a multi-year statement does not mount thousands of cards at once. */
const CARD_PAGE_SIZE = 100;

// Bulk selection stays a desktop-table workflow; cards still show rows selected there.
type AccountStatementCardsProps = Omit<
  AccountTransactionRowsProps,
  "toggleSelectAll" | "toggleVoucherSelection" | "appMode"
>;

/**
 * Phone presentation of an account statement: opening balance, one card per transaction
 * (tap to open the voucher) and the period totals. It renders the rows and balances that
 * `AccountTransactionRows` receives, so no figure is computed twice. Below `md`, where the
 * desktop table is hidden.
 */
export function AccountStatementCards({
  vouchersWithBalance,
  selectedVoucherIds,
  handleOpenVoucher,
  formatAmount: fmt,
  formatTransactionAmount,
  hideBalances,
  openingBalance,
  closingBalance,
  selectedAccount,
  formatDisplayDate,
}: AccountStatementCardsProps) {
  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  const isSupplier = selectedAccount.type === "supplier";
  const side = (value: number) => (value >= 0 ? "Dr" : "Cr");
  const openingSide = isSupplier ? (openingBalance > 0 ? "Cr" : "Dr") : side(openingBalance);

  let totalDebit = 0;
  let totalCredit = 0;
  for (const voucher of vouchersWithBalance) {
    totalDebit += voucher.totalDebit || 0;
    totalCredit += voucher.totalCredit || 0;
  }

  const amountFor = (voucher: AccountStatementRow) => {
    const isDebit = voucher.totalDebit > 0;
    const base = isDebit ? voucher.totalDebit : voucher.totalCredit;
    if (!base) return null;
    const transactionAmount = isDebit ? voucher.transactionDebitAmount : voucher.transactionCreditAmount;
    const text =
      formatTransactionAmount && voucher.transactionCurrency
        ? formatTransactionAmount(transactionAmount || base, voucher.transactionCurrency)
        : fmt(base);
    return { text, side: isDebit ? "Dr" : "Cr" };
  };

  const rendered = vouchersWithBalance.slice(0, visibleCount);

  return (
    <div className="space-y-2 md:hidden print:hidden" data-testid="account-statement-cards">
      {!hideBalances && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border bg-accent/20 px-3 py-2 text-sm"
          data-testid="card-opening-balance"
        >
          <span className="font-medium">Opening Balance</span>
          <span className="font-mono font-semibold tabular-nums" dir="ltr">
            {fmt(Math.abs(openingBalance))}
            <span className="ms-1 text-[11px] font-normal opacity-70">{openingSide}</span>
          </span>
        </div>
      )}

      <ErpMobileRecordList isEmpty={vouchersWithBalance.length === 0} empty="No transactions in this period.">
        {rendered.map((voucher) => {
          const isReference = voucher.voucherType === HISTORICAL_REFERENCE_TYPE;
          const amount = amountFor(voucher);
          const description = voucher.voucherDescription || voucher.narration || "No description";
          return (
            <ErpMobileRecordCard
              key={`${voucher.voucherId}-${voucher.entryId}`}
              data-testid={
                isReference
                  ? `card-historical-reference-${Math.abs(voucher.voucherId)}`
                  : `card-voucher-${voucher.voucherId}`
              }
              title={description}
              subtitle={
                <>
                  <span className="font-mono tabular-nums">{formatDisplayDate(voucher.voucherDate)}</span>
                  {" · "}
                  {isReference ? "Historical PO reference · balance unchanged" : voucher.voucherType}
                </>
              }
              value={
                hideBalances || !amount ? undefined : (
                  <>
                    {amount.text}
                    <span className="ms-1 text-[11px] font-normal opacity-70">{amount.side}</span>
                  </>
                )
              }
              valueClassName={amount?.side === "Dr" ? "text-emerald-600" : "text-orange-600"}
              fields={
                hideBalances || voucher.runningBalance == null
                  ? []
                  : [
                      {
                        label: "Balance",
                        numeric: true,
                        value: (
                          <span className="font-mono font-semibold">
                            {fmt(Math.abs(voucher.runningBalance))}
                            <span className="ms-1 text-[11px] font-normal opacity-60">
                              {side(voucher.runningBalance)}
                            </span>
                          </span>
                        ),
                      },
                    ]
              }
              onOpen={isReference ? undefined : () => handleOpenVoucher(voucher)}
              openLabel={isReference ? undefined : `Open voucher ${voucher.voucherNumber || description}`}
              selected={selectedVoucherIds.has(voucher.voucherId)}
            />
          );
        })}
      </ErpMobileRecordList>

      {vouchersWithBalance.length > visibleCount && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          onClick={() => setVisibleCount((count) => count + CARD_PAGE_SIZE)}
          data-testid="button-statement-show-more"
        >
          Show more ({vouchersWithBalance.length - visibleCount} remaining)
        </Button>
      )}

      {!hideBalances && vouchersWithBalance.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <dt className="text-muted-foreground">Period debit</dt>
          <dd className="text-end font-mono tabular-nums" dir="ltr">
            {totalDebit > 0 ? fmt(totalDebit) : "—"}
          </dd>
          <dt className="text-muted-foreground">Period credit</dt>
          <dd className="text-end font-mono tabular-nums" dir="ltr">
            {totalCredit > 0 ? fmt(totalCredit) : "—"}
          </dd>
          <dt className="font-semibold">Closing Balance</dt>
          <dd className="text-end font-mono font-semibold tabular-nums" dir="ltr">
            {fmt(Math.abs(closingBalance))}
            <span className="ms-1 text-[11px] font-normal opacity-60">{side(closingBalance)}</span>
          </dd>
        </dl>
      )}
    </div>
  );
}
