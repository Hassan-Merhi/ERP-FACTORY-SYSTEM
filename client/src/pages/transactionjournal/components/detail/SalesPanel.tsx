/**
 * Sales / POS body of the All Daybook voucher detail dialog: the received-in
 * banner, the items-sold table with its optional cost and Hassan's columns,
 * and the secondary accounts table.
 *
 * Split out of TransactionJournal.tsx unchanged — the same column presence
 * rules, the same profit colouring and the same footer colspan arithmetic.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JournalViewEntry } from "../../types";
import type { DetailPanelFormatters } from "./panelTypes";

const POSITIVE = "text-green-600 dark:text-green-400";
const NEGATIVE = "text-red-600 dark:text-red-400";

function signClass(value: number): string {
  return value >= 0 ? POSITIVE : NEGATIVE;
}

export function SalesPanel({
  stockRows,
  ledgerRows,
  entryBalances,
  fmt,
  fmtNum,
}: {
  stockRows: JournalViewEntry[];
  ledgerRows: JournalViewEntry[];
  entryBalances: Record<number, string>;
} & DetailPanelFormatters) {
  const grandTotal = stockRows.reduce((s, r) => s + parseFloat(r.totalSales || r.totalAmount || "0"), 0);
  const grandProfit = stockRows.reduce((s, r) => s + parseFloat(r.profit || "0"), 0);
  const grandHassansProfit = stockRows.reduce((s, r) => s + parseFloat(r.hassansProfit || "0"), 0);
  const hasHassans = stockRows.some((r) => r.hassansPrice !== undefined && r.hassansPrice !== null);
  const hasCost = stockRows.some(
    (r) => r.costPrice !== undefined && r.costPrice !== null && parseFloat(r.costPrice || "0") > 0
  );

  // Cash / receivable account = the debit entry
  const cashEntry = ledgerRows.find((e) => parseFloat(e.debitAmount || "0") > 0);

  return (
    <div className="space-y-4">
      {cashEntry && (
        <div className="p-3 md:p-4 bg-muted/50 rounded-md">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Received In</p>
              <div className="font-medium text-base md:text-lg">{cashEntry.accountName}</div>
              {entryBalances[cashEntry.id] !== undefined && (
                <div className="text-sm font-mono mt-2">Balance: {fmt(entryBalances[cashEntry.id])}</div>
              )}
            </div>
            <div className="sm:text-right">
              <p className="text-sm text-muted-foreground mb-1">Total Sales</p>
              <div className="text-xl md:text-2xl font-bold font-mono">{fmt(grandTotal)}</div>
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="font-semibold mb-3">Items Sold</h3>
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right w-16">Qty</TableHead>
                <TableHead className="text-right w-24">Price</TableHead>
                {hasCost && <TableHead className="text-right w-24">Cost</TableHead>}
                <TableHead className="text-right w-28">Total</TableHead>
                <TableHead className="text-right w-24">Profit</TableHead>
                {hasHassans && <TableHead className="text-right w-28">Hassan's Price</TableHead>}
                {hasHassans && <TableHead className="text-right w-28">Hassan's Profit</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockRows.map((r) => {
                const profit = parseFloat(r.profit || "0");
                const hProfit = parseFloat(r.hassansProfit || "0");
                return (
                  <TableRow key={r.id} data-testid={`row-sales-item-${r.id}`}>
                    <TableCell className="py-2">
                      <div className="text-sm font-medium">{r.stockItemName}</div>
                      {r.stockItemCode && r.stockItemCode !== "-" && (
                        <div className="text-xs text-muted-foreground">{r.stockItemCode}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono py-2">{fmtNum(r.quantity)}</TableCell>
                    <TableCell className="text-right text-sm font-mono py-2">{fmt(r.sellingPrice || r.rate)}</TableCell>
                    {hasCost && (
                      <TableCell className="text-right text-sm font-mono py-2 text-muted-foreground">
                        {fmt(r.costPrice)}
                      </TableCell>
                    )}
                    <TableCell className="text-right text-sm font-mono py-2">
                      {fmt(r.totalSales || r.totalAmount)}
                    </TableCell>
                    <TableCell className={`text-right text-sm font-mono py-2 ${signClass(profit)}`}>
                      {fmt(profit)}
                    </TableCell>
                    {hasHassans && (
                      <TableCell className="text-right text-sm font-mono py-2">{fmt(r.hassansPrice)}</TableCell>
                    )}
                    {hasHassans && (
                      <TableCell className={`text-right text-sm font-mono py-2 ${signClass(hProfit)}`}>
                        {fmt(hProfit)}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              <TableRow className="font-bold bg-muted/50">
                <TableCell colSpan={hasCost ? 4 : 3}>Total</TableCell>
                <TableCell className="text-right font-mono">{fmt(grandTotal)}</TableCell>
                <TableCell className={`text-right font-mono ${signClass(grandProfit)}`}>{fmt(grandProfit)}</TableCell>
                {hasHassans && <TableCell />}
                {hasHassans && (
                  <TableCell className={`text-right font-mono ${signClass(grandHassansProfit)}`}>
                    {fmt(grandHassansProfit)}
                  </TableCell>
                )}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      {ledgerRows.length > 1 && (
        <div>
          <h3 className="font-semibold mb-3">Accounts</h3>
          <div className="border rounded-md">
            <Table>
              <TableBody>
                {ledgerRows.map((e) => {
                  const amount = Math.max(parseFloat(e.debitAmount || "0"), parseFloat(e.creditAmount || "0"));
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="py-2">
                        <div className="font-medium">{e.accountName}</div>
                        {entryBalances[e.id] !== undefined && (
                          <div className="text-xs text-muted-foreground">Balance: {fmt(entryBalances[e.id])}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmt(amount)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
