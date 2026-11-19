// Extracted from ./LedgerVoucherEntries.tsx
import { TableCell, TableRow } from "@/components/ui/table";
import type { ViewVoucherEntry, Voucher, DaybookUser, TransferDetailData } from ".././types";
import { isSingleAmountVoucherType, txCurrencyLabel } from "./utils";

export interface LedgerVoucherEntriesProps {
  selectedVoucher: Voucher;
  viewVoucherEntries: ViewVoucherEntry[];
  isPOSUser: boolean;
  isStockTransferType: boolean;
  transferDetail: TransferDetailData | null;
  cashAccountBalance: string;
  entryBalances: Record<number, string>;
  formatAmount: (amt: number | string | null | undefined) => string;
  resolveEntryName: (entry: ViewVoucherEntry) => string;
  user: DaybookUser | null | undefined;
}

export function AccountEntryRows({
  selectedVoucher,
  viewVoucherEntries,
  entryBalances,
  formatAmount,
  resolveEntryName,
}: Pick<
  LedgerVoucherEntriesProps,
  "selectedVoucher" | "viewVoucherEntries" | "entryBalances" | "formatAmount" | "resolveEntryName"
>) {
  const isSingleAmount = isSingleAmountVoucherType(selectedVoucher.voucherType);
  const showEntryBalances = selectedVoucher.voucherType === "Journal";
  const displayEntries = isSingleAmount
    ? viewVoucherEntries.filter((entry) => {
        if (selectedVoucher.voucherType === "Payment") return parseFloat(entry.debitAmount || "0") > 0;
        if (selectedVoucher.voucherType === "Receipt") return parseFloat(entry.creditAmount || "0") > 0;
        return true;
      })
    : viewVoucherEntries;

  return (
    <>
      {displayEntries.map((entry) => (
        <TableRow key={entry.id}>
          <TableCell>
            <div className="font-medium">{resolveEntryName(entry)}</div>
            {(isSingleAmount || showEntryBalances) && entryBalances[entry.id] !== undefined && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Balance: {formatAmount(entryBalances[entry.id] ?? "0")}
              </div>
            )}
            {entry.narration && <div className="text-xs text-muted-foreground/80 mt-0.5 italic">{entry.narration}</div>}
          </TableCell>
          {isSingleAmount ? (
            <TableCell className="text-right font-mono">
              {formatAmount(Math.max(parseFloat(entry.debitAmount || "0"), parseFloat(entry.creditAmount || "0")))}
              {txCurrencyLabel(entry) && (
                <div className="text-xs text-muted-foreground mt-0.5">{txCurrencyLabel(entry)}</div>
              )}
            </TableCell>
          ) : (
            <>
              {/* Phone cards drop the empty side, so each entry shows only its own amount. */}
              <TableCell
                className="text-right font-mono"
                data-mobile-cell={parseFloat(entry.debitAmount) > 0 ? undefined : "hidden"}
              >
                {parseFloat(entry.debitAmount) > 0 ? (
                  <div>
                    {formatAmount(entry.debitAmount)}
                    {txCurrencyLabel(entry) && parseFloat(entry.transactionDebitAmount || "0") > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">{txCurrencyLabel(entry)}</div>
                    )}
                  </div>
                ) : (
                  "-"
                )}
              </TableCell>
              <TableCell
                className="text-right font-mono"
                data-mobile-cell={parseFloat(entry.creditAmount) > 0 ? undefined : "hidden"}
              >
                {parseFloat(entry.creditAmount) > 0 ? (
                  <div>
                    {formatAmount(entry.creditAmount)}
                    {txCurrencyLabel(entry) && parseFloat(entry.transactionCreditAmount || "0") > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {(() => {
                          const credit = parseFloat(entry.transactionCreditAmount || "0");
                          if (!credit || !entry.transactionCurrency || entry.transactionCurrency === "USD") return null;
                          if (entry.transactionCurrency === "CFA") return `CFA ${Math.round(credit).toLocaleString()}`;
                          return `${entry.transactionCurrency} ${credit.toFixed(2)}`;
                        })()}
                      </div>
                    )}
                  </div>
                ) : (
                  "-"
                )}
              </TableCell>
              {/* The card title already shows the narration under the account. */}
              <TableCell className="text-sm text-muted-foreground" data-mobile-cell="hidden">
                {entry.narration || "-"}
              </TableCell>
            </>
          )}
        </TableRow>
      ))}
    </>
  );
}
