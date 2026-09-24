/**
 * Sales / POS voucher body: payment account card, keyboard hint, the profit
 * filtered item table and its totals footer.
 *
 * Split out of VoucherDetailsDialog.tsx unchanged. Cost, price, profit and the
 * Hassan's columns stay behind the same non-POS-user gate, and the totals are
 * still computed over the *filtered* rows, matching the original.
 */
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ViewVoucherEntry } from ".././types";

type ProfitFilter = "all" | "gain" | "loss" | "even";

function profitColor(profit: number): string {
  if (profit > 0.01) return "text-emerald-600 dark:text-emerald-400";
  if (profit < -0.01) return "text-destructive";
  return "text-muted-foreground";
}

export function SalesVoucherEntries({
  viewVoucherEntries,
  viewProfitFilter,
  isPOSUser,
  cashAccountBalance,
  entryBalances,
  selectedDialogRow,
  setSelectedDialogRow,
  formatAmount,
}: {
  viewVoucherEntries: ViewVoucherEntry[];
  viewProfitFilter: ProfitFilter;
  isPOSUser: boolean;
  cashAccountBalance: string;
  entryBalances: Record<number, string>;
  selectedDialogRow: number | null;
  setSelectedDialogRow: (n: number | null) => void;
  formatAmount: (amt: number | string | null | undefined) => string;
}) {
  const salesItems = viewVoucherEntries.filter((e) => e.isStockItem || e.stockItemId);
  const ledgerEntries = viewVoucherEntries.filter((e) => !e.isStockItem && !e.stockItemId);
  const filteredItems = salesItems.filter((e) => {
    if (viewProfitFilter === "all") return true;
    const profit = parseFloat(e.profit || "0");
    if (viewProfitFilter === "gain") return profit > 0.01;
    if (viewProfitFilter === "loss") return profit < -0.01;
    return Math.abs(profit) <= 0.01;
  });
  const paymentEntry = ledgerEntries.find((e) => parseFloat(e.debitAmount || "0") > 0) || ledgerEntries[0];
  const hasHassans = !isPOSUser && salesItems.some((e) => e.hassansPrice != null || e.hassansProfit != null);
  const totalQty = filteredItems.reduce((s, e) => s + parseFloat(e.quantity || "0"), 0);
  const totalAmt = filteredItems.reduce((s, e) => s + parseFloat(e.totalAmount || e.totalSales || "0"), 0);
  const totalCost = filteredItems.reduce(
    (s, e) => s + parseFloat(e.costPrice || "0") * parseFloat(e.quantity || "0"),
    0
  );
  const totalProfit = filteredItems.reduce((s, e) => s + parseFloat(e.profit || "0"), 0);
  const totalHassansPrice = filteredItems.reduce(
    (s, e) => s + parseFloat(e.hassansPrice || "0") * parseFloat(e.quantity || "0"),
    0
  );
  const totalHassansProfit = filteredItems.reduce((s, e) => s + parseFloat(e.hassansProfit || "0"), 0);
  const totalHassansPercentage = totalHassansPrice > 0 ? (totalHassansProfit / totalHassansPrice) * 100 : 0;

  return (
    <div>
      {/* Payment account card */}
      {paymentEntry && (
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
          <p className="font-semibold text-sm">{paymentEntry.accountName}</p>
          {!isPOSUser && (
            <div className="text-sm text-right">
              <span className="text-xs text-muted-foreground mr-1">Balance</span>
              <span className="font-mono font-semibold">
                ${" "}
                {parseFloat(cashAccountBalance || entryBalances[paymentEntry.id] || "0").toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>
          )}
        </div>
      )}
      {/* Keyboard hint */}
      {!isPOSUser && (
        <p className="text-xs text-muted-foreground text-right px-4 py-1.5 border-b">
          Hover or use ↑↓ to select · Alt+S to view item
        </p>
      )}
      {/* Items table */}
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead>Item Name</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            {!isPOSUser && <TableHead className="text-right">Price</TableHead>}
            {!isPOSUser && <TableHead className="text-right">Cost</TableHead>}
            {!isPOSUser && <TableHead className="text-right">Total</TableHead>}
            {!isPOSUser && <TableHead className="text-right">Profit</TableHead>}
            {hasHassans && <TableHead className="text-right">Hassan's Price</TableHead>}
            {hasHassans && <TableHead className="text-right">Hassan's Profit</TableHead>}
            {hasHassans && <TableHead className="text-right">Hassan's %</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredItems.length === 0 && (
            <TableRow>
              <TableCell colSpan={hasHassans ? 9 : 6} className="text-center text-muted-foreground py-8 text-sm">
                No items found for this voucher
              </TableCell>
            </TableRow>
          )}
          {filteredItems.map((entry, idx) => {
            const isSelected = selectedDialogRow === idx;
            const profit = parseFloat(entry.profit || "0");
            const pColor = profitColor(profit);
            const costPerUnit = entry.costPrice != null ? parseFloat(entry.costPrice) : null;
            return (
              <TableRow
                key={entry.id}
                data-dialog-row={idx}
                className={isSelected ? "bg-accent/40" : ""}
                onClick={() => setSelectedDialogRow(idx)}
              >
                <TableCell className="font-medium">{entry.stockItemName || entry.accountName}</TableCell>
                <TableCell className="text-right font-mono">{parseFloat(entry.quantity || "0")}</TableCell>
                {!isPOSUser && (
                  <TableCell className="text-right font-mono">
                    {entry.rate != null ? formatAmount(entry.rate) : "-"}
                  </TableCell>
                )}
                {!isPOSUser && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {costPerUnit != null ? formatAmount(costPerUnit) : "-"}
                  </TableCell>
                )}
                {!isPOSUser && (
                  <TableCell className="text-right font-mono">
                    {formatAmount(entry.totalAmount || entry.totalSales)}
                  </TableCell>
                )}
                {!isPOSUser && (
                  <TableCell className={`text-right font-mono font-semibold ${pColor}`}>
                    {formatAmount(profit)}
                  </TableCell>
                )}
                {hasHassans && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {entry.hassansPrice != null ? formatAmount(entry.hassansPrice) : "-"}
                  </TableCell>
                )}
                {hasHassans && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {entry.hassansProfit != null ? formatAmount(entry.hassansProfit) : "-"}
                  </TableCell>
                )}
                {hasHassans && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {entry.hassansPercentage != null ? `${parseFloat(entry.hassansPercentage).toFixed(1)}%` : "-"}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
        {!isPOSUser && filteredItems.length > 0 && (
          <TableFooter>
            <TableRow className="bg-muted/20 hover:bg-muted/20 font-semibold">
              <TableCell>Total</TableCell>
              <TableCell className="text-right font-mono text-muted-foreground">{totalQty}</TableCell>
              <TableCell aria-label="No price total" />
              <TableCell className="text-right font-mono text-muted-foreground">{formatAmount(totalCost)}</TableCell>
              <TableCell className="text-right font-mono">{formatAmount(totalAmt)}</TableCell>
              <TableCell className={`text-right font-mono ${profitColor(totalProfit)}`}>
                {formatAmount(totalProfit)}
              </TableCell>
              {hasHassans && (
                <>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatAmount(totalHassansPrice)}
                  </TableCell>
                  <TableCell className={`text-right font-mono ${profitColor(totalHassansProfit)}`}>
                    {formatAmount(totalHassansProfit)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {totalHassansPercentage.toFixed(1)}%
                  </TableCell>
                </>
              )}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}
