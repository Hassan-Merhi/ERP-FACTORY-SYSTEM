/**
 * Body for every voucher type that is not Purchase/Sales/POS: the cash-account
 * banner for Payment/Receipt, the stock-transfer route bar, the entries table
 * (stock lines, single-amount lines or debit/credit lines) and the totals row.
 *
 * Split out of VoucherDetailsDialog.tsx unchanged — the column sets, the
 * Payment/Receipt row filtering, the multi-currency sub-labels and the Mixed
 * voucher's separate footer all behave exactly as before.
 */
import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isSingleAmountVoucherType, isStockEntryVoucherType } from "./utils";
import { AccountEntryRows, type LedgerVoucherEntriesProps } from "./AccountEntryRows";

function CashAccountBanner({
  selectedVoucher,
  viewVoucherEntries,
  cashAccountBalance,
  formatAmount,
  resolveEntryName,
}: Pick<
  LedgerVoucherEntriesProps,
  "selectedVoucher" | "viewVoucherEntries" | "cashAccountBalance" | "formatAmount" | "resolveEntryName"
>) {
  const isPayment = selectedVoucher.voucherType === "Payment";
  const counterEntry = isPayment
    ? viewVoucherEntries.find((e) => parseFloat(e.creditAmount || "0") > 0)
    : viewVoucherEntries.find((e) => parseFloat(e.debitAmount || "0") > 0 && (e.ledgerAccountId || e.bankAccountId));
  if (!counterEntry) return null;
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-2.5 text-sm">
      <div>
        <span className="text-xs text-muted-foreground uppercase tracking-wide mr-2">
          {isPayment ? "Paid from" : "Received into"}
        </span>
        <span className="font-medium">{resolveEntryName(counterEntry)}</span>
      </div>
      <div className="text-right">
        <span className="text-xs text-muted-foreground mr-1">Balance:</span>
        <span className="font-mono font-medium">{formatAmount(cashAccountBalance)}</span>
      </div>
    </div>
  );
}

function StockEntryRows({
  selectedVoucher,
  viewVoucherEntries,
  isPOSUser,
  isStockTransferType,
  transferDetail,
  formatAmount,
}: Pick<
  LedgerVoucherEntriesProps,
  "selectedVoucher" | "viewVoucherEntries" | "isPOSUser" | "isStockTransferType" | "transferDetail" | "formatAmount"
>) {
  if (viewVoucherEntries.length === 0) {
    return (
      <TableRow key="empty-state">
        <TableCell colSpan={5} className="text-center text-muted-foreground py-8 text-sm">
          No items found for this voucher
        </TableCell>
      </TableRow>
    );
  }
  return (
    <>
      {viewVoucherEntries.map((entry) => {
        const qty = parseFloat(entry.quantity || "0");
        const rate = entry.rate != null ? parseFloat(entry.rate) : 0;
        const totalAmount = entry.totalAmount != null ? parseFloat(entry.totalAmount) : qty * rate;
        return (
          <TableRow key={entry.id}>
            <TableCell>
              <div className="font-medium">{entry.stockItemName || entry.accountName}</div>
            </TableCell>
            {selectedVoucher.voucherType === "Mixed" && (
              <TableCell>
                <Badge variant={entry.adjustmentType === "Production" ? "default" : "secondary"}>
                  {entry.adjustmentType || (qty > 0 ? "Production" : "Consumption")}
                </Badge>
              </TableCell>
            )}
            {isStockTransferType && (
              <TableCell className="text-sm text-muted-foreground">
                {entry.sourceLocationName || transferDetail?.sourceLocationName || "—"}
              </TableCell>
            )}
            <TableCell className="text-right font-mono">{Math.round(Math.abs(qty)).toLocaleString()}</TableCell>
            {!isPOSUser && (
              <>
                <TableCell className="text-right font-mono">{formatAmount(rate)}</TableCell>
                <TableCell className="text-right font-mono">{formatAmount(totalAmount)}</TableCell>
              </>
            )}
          </TableRow>
        );
      })}
    </>
  );
}

function TotalsRow({
  selectedVoucher,
  viewVoucherEntries,
  formatAmount,
  user,
}: Pick<LedgerVoucherEntriesProps, "selectedVoucher" | "viewVoucherEntries" | "formatAmount" | "user">) {
  const isNonMixedStock =
    isStockEntryVoucherType(selectedVoucher.voucherType) && selectedVoucher.voucherType !== "Mixed";
  const quantityTotal = viewVoucherEntries
    .reduce((sum, e) => sum + Math.abs(parseFloat(e.quantity || "0")), 0)
    .toFixed(3)
    .replace(/\.?0+$/, "");

  return (
    <TableRow className="font-bold bg-muted/50">
      {isNonMixedStock ? (
        <>
          <TableCell>Total</TableCell>
          <TableCell className="text-right font-mono">{quantityTotal}</TableCell>
          {user && user?.role !== "POS" && (
            <>
              <TableCell></TableCell>
              <TableCell className="text-right font-mono">
                {formatAmount(
                  viewVoucherEntries.reduce((sum, e) => {
                    if (e.totalAmount != null) return sum + Math.abs(parseFloat(e.totalAmount));
                    const qty = Math.abs(parseFloat(e.quantity || "0"));
                    const rate = e.rate != null ? parseFloat(e.rate) : 0;
                    return sum + qty * rate;
                  }, 0)
                )}
              </TableCell>
            </>
          )}
        </>
      ) : isSingleAmountVoucherType(selectedVoucher.voucherType) ? (
        <>
          <TableCell>Total</TableCell>
          <TableCell className="text-right font-mono">
            {formatAmount(
              Math.max(
                viewVoucherEntries.reduce((sum, e) => sum + parseFloat(e.debitAmount || "0"), 0),
                viewVoucherEntries.reduce((sum, e) => sum + parseFloat(e.creditAmount || "0"), 0)
              )
            )}
          </TableCell>
        </>
      ) : (
        <>
          <TableCell>Total</TableCell>
          <TableCell className="text-right font-mono">
            {formatAmount(viewVoucherEntries.reduce((sum, e) => sum + parseFloat(e.debitAmount || "0"), 0))}
          </TableCell>
          <TableCell className="text-right font-mono">
            {formatAmount(viewVoucherEntries.reduce((sum, e) => sum + parseFloat(e.creditAmount || "0"), 0))}
          </TableCell>
          <TableCell></TableCell>
        </>
      )}
    </TableRow>
  );
}

function MixedFooter({
  viewVoucherEntries,
  formatAmount,
  user,
}: Pick<LedgerVoucherEntriesProps, "viewVoucherEntries" | "formatAmount" | "user">) {
  const prodTotal = viewVoucherEntries
    .filter((e) => e.adjustmentType === "Production" || (e.adjustmentType == null && parseFloat(e.quantity || "0") > 0))
    .reduce((sum, e) => sum + Math.abs(parseFloat(e.totalAmount || "0")), 0);
  const consTotal = viewVoucherEntries
    .filter(
      (e) => e.adjustmentType === "Consumption" || (e.adjustmentType == null && parseFloat(e.quantity || "0") < 0)
    )
    .reduce((sum, e) => sum + Math.abs(parseFloat(e.totalAmount || "0")), 0);
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t font-bold">
      <div className="flex items-center gap-4">
        <span>Total</span>
        <span className="font-mono text-sm text-muted-foreground">
          {viewVoucherEntries
            .reduce((sum, e) => sum + Math.abs(parseFloat(e.quantity || "0")), 0)
            .toFixed(3)
            .replace(/\.?0+$/, "")}{" "}
          units
        </span>
      </div>
      {user && user?.role !== "POS" && <span className="font-mono">{formatAmount(prodTotal - consTotal)}</span>}
    </div>
  );
}

export function LedgerVoucherEntries(props: LedgerVoucherEntriesProps) {
  const { selectedVoucher, viewVoucherEntries, isPOSUser, isStockTransferType, transferDetail, user } = props;
  const isStockEntry = isStockEntryVoucherType(selectedVoucher.voucherType);
  const isSingleAmount = isSingleAmountVoucherType(selectedVoucher.voucherType);

  return (
    <div className="space-y-3">
      {(selectedVoucher.voucherType === "Payment" || selectedVoucher.voucherType === "Receipt") && !isPOSUser && (
        <CashAccountBanner {...props} />
      )}
      {/* ── Stock Transfer route bar ── */}
      {isStockTransferType && transferDetail && (
        <div className="flex items-center gap-2 mb-2 px-1 text-sm text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-foreground">{transferDetail.sourceLocationName || "—"}</span>
          <span>→</span>
          <span className="font-medium text-foreground">{transferDetail.destinationLocationName || "—"}</span>
        </div>
      )}
      <div className="border rounded-md">
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              {isStockEntry ? (
                <>
                  <TableHead>Item Name</TableHead>
                  {selectedVoucher.voucherType === "Mixed" && <TableHead>Type</TableHead>}
                  {isStockTransferType && <TableHead>Source Location</TableHead>}
                  <TableHead className="text-right">Qty</TableHead>
                  {user && user?.role !== "POS" && (
                    <>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Total Amount</TableHead>
                    </>
                  )}
                </>
              ) : isSingleAmount ? (
                <>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </>
              ) : (
                <>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Narration</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isStockEntry ? <StockEntryRows {...props} /> : <AccountEntryRows {...props} />}
            {selectedVoucher.voucherType !== "Mixed" && <TotalsRow {...props} />}
          </TableBody>
        </Table>
        {selectedVoucher.voucherType === "Mixed" && (
          <MixedFooter viewVoucherEntries={viewVoucherEntries} formatAmount={props.formatAmount} user={user} />
        )}
      </div>
    </div>
  );
}
