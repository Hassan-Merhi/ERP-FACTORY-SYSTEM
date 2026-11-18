// Extracted from ./ViewEntryModal.tsx: the voucher-backed entry view.
import { EmptyState } from "@/components/ui/page-state";
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import { apiNumber } from "./entry-views/types";
import { formatDaybookDescription } from "./daybookUtils";
import type { ViewEntryModalProps } from "./ViewEntryModal";
import type { ViewEntryModalModel } from "./ViewEntryModalModel";

export function renderVoucherBackedEntry({
  entry,
  m,
  formatDisplayDate,
}: {
  entry: ViewEntryModalProps["entry"];
  m: ViewEntryModalModel;
  formatDisplayDate: ViewEntryModalProps["formatDisplayDate"];
}) {
  // Determine voucher type from txType: PAYMENT → Payment, RECEIPT → Receipt, JOURNAL → Journal
  const voucherType =
    entry.txType === "PAYMENT"
      ? "Payment"
      : entry.txType === "RECEIPT"
        ? "Receipt"
        : entry.txType === "JOURNAL"
          ? "Journal"
          : entry.txType;

  const isPayment = voucherType === "Payment";
  const isReceipt = voucherType === "Receipt";
  const isJournal = voucherType === "Journal";
  const isPaymentOrReceipt = isPayment || isReceipt;

  // Source account: For Payment = credit entry (cash going OUT), For Receipt = debit entry (cash coming IN)
  const sourceEntry = isPayment
    ? m.viewEntries.find((e) => apiNumber(e.creditAmount) > 0)
    : isReceipt
      ? m.viewEntries.find((e) => apiNumber(e.debitAmount) > 0)
      : null;

  // Total = opposite side of source for Payment/Receipt
  const totalAmount = isPayment
    ? m.viewEntries.reduce((s: number, e) => s + apiNumber(e.debitAmount), 0)
    : isReceipt
      ? m.viewEntries.reduce((s: number, e) => s + apiNumber(e.creditAmount), 0)
      : Math.max(m.totalDebit, m.totalCredit);

  // Display entries: Payment = debit side only, Receipt = credit side only, Journal = all
  const displayEntries = isPayment
    ? m.viewEntries.filter((e) => apiNumber(e.debitAmount) > 0)
    : isReceipt
      ? m.viewEntries.filter((e) => apiNumber(e.creditAmount) > 0)
      : m.viewEntries;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Voucher Details</DialogTitle>
        <DialogDescription>View voucher information</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 md:space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Date</p>
            <p className="font-medium">{formatDisplayDate(entry.txDate + "T00:00:00")}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Type</p>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={m.badgeVariant} className={m.badgeClass}>
                {voucherType}
              </Badge>
              {entry.optional && <span className="text-sm text-muted-foreground">Optional</span>}
            </div>
          </div>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Description</p>
          <p className="text-sm font-medium">{formatDaybookDescription(entry)}</p>
        </div>

        {/* Paid From / Received In card — Payment and Receipt only */}
        {isPaymentOrReceipt && sourceEntry && (
          <div className="p-3 md:p-4 bg-muted/50 rounded-md">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{isPayment ? "Paid From" : "Received In"}</p>
                <p className="font-medium text-base md:text-lg">{sourceEntry.accountName}</p>
                <p
                  className="text-sm font-mono mt-2 text-muted-foreground"
                  data-testid="factory-voucher-source-balance"
                >
                  Current balance: {m.displayCurrentBalance(m.sourceBalance)}
                </p>
              </div>
              <div className="sm:text-right">
                <p className="text-sm text-muted-foreground mb-1">Total Amount</p>
                <p className="text-xl md:text-2xl font-bold font-mono">
                  {m.sym} {formatNumber(totalAmount)}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Entries table */}
        <div>
          <h3 className="font-semibold mb-3">Entries</h3>
          {m.viewEntries.length === 0 ? (
            <EmptyState title="No entries found" className="min-h-0 py-4 sm:py-4" />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Account
                    </th>
                    {isPaymentOrReceipt || isJournal ? (
                      <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Amount
                      </th>
                    ) : (
                      <>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Debit
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Credit
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {displayEntries.map((e, i: number) => (
                    <tr key={e.id ?? i} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-medium">{e.accountName || "—"}</p>
                        {(isPaymentOrReceipt || isJournal) && (
                          <p
                            className="text-xs text-muted-foreground mt-0.5"
                            data-testid={`factory-voucher-current-balance-${e.id}`}
                          >
                            Current balance: {m.displayCurrentBalance(m.entryBalances[e.id])}
                          </p>
                        )}
                      </td>
                      {isPaymentOrReceipt || isJournal ? (
                        <td className="px-3 py-2 text-right font-mono">
                          {m.sym}
                          {formatNumber(Math.max(apiNumber(e.debitAmount), apiNumber(e.creditAmount)))}
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right font-mono">
                            {apiNumber(e.debitAmount) > 0 ? `${m.sym}${formatNumber(apiNumber(e.debitAmount))}` : "-"}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {apiNumber(e.creditAmount) > 0 ? `${m.sym}${formatNumber(apiNumber(e.creditAmount))}` : "-"}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-bold border-t">
                    <td className="px-3 py-2">Total</td>
                    {isPaymentOrReceipt || isJournal ? (
                      <td className="px-3 py-2 text-right font-mono">
                        {m.sym}
                        {formatNumber(totalAmount)}
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right font-mono">
                          {m.sym}
                          {formatNumber(m.totalDebit)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {m.sym}
                          {formatNumber(m.totalCredit)}
                        </td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
