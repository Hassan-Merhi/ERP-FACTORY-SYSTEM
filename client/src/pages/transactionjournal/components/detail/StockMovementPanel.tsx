/**
 * Stock-movement bodies of the All Daybook voucher detail dialog: stock
 * transfers, and Production / Consumption / Mixed adjustments.
 *
 * Split out of TransactionJournal.tsx unchanged, including the Mixed voucher's
 * signed grand total (production adds, consumption subtracts) and its extra
 * adjustment-type column.
 */
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JournalViewEntry } from "../../types";
import type { DetailPanelFormatters } from "./panelTypes";

export function StockTransferPanel({
  stockRows,
  fmt,
  fmtNum,
}: {
  stockRows: JournalViewEntry[];
} & DetailPanelFormatters) {
  const grandTotal = stockRows.reduce((s, r) => s + parseFloat(r.totalAmount || "0"), 0);
  const grandQty = stockRows.reduce((s, r) => s + parseFloat(r.quantity || "0"), 0);
  return (
    <div>
      <h3 className="font-semibold mb-3">Transfer Items</h3>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead>Item Name</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Total Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stockRows.map((r) => (
              <TableRow key={r.id} data-testid={`row-transfer-item-${r.id}`}>
                <TableCell>
                  <div className="font-medium">{r.stockItemName}</div>
                  {r.stockItemCode && r.stockItemCode !== "-" && (
                    <div className="text-xs text-muted-foreground">{r.stockItemCode}</div>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">{fmtNum(r.quantity)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(r.rate)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(r.totalAmount)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-bold bg-muted/50">
              <TableCell>Total</TableCell>
              <TableCell className="text-right font-mono">{fmtNum(grandQty)}</TableCell>
              <TableCell />
              <TableCell className="text-right font-mono">{fmt(grandTotal)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function StockAdjustmentPanel({
  vtype,
  stockRows,
  fmt,
  fmtNum,
}: { vtype: string; stockRows: JournalViewEntry[] } & DetailPanelFormatters) {
  const isMixed = vtype === "Mixed";
  const grandTotal = isMixed
    ? stockRows.reduce((s, r) => {
        const amt = Math.abs(parseFloat(r.totalAmount || "0"));
        return r.adjustmentType === "Production" ? s + amt : s - amt;
      }, 0)
    : stockRows.reduce((s, r) => s + Math.abs(parseFloat(r.totalAmount || "0")), 0);
  const grandQty = stockRows.reduce((s, r) => s + Math.abs(parseFloat(r.quantity || "0")), 0);
  return (
    <div>
      <h3 className="font-semibold mb-3">Stock Items</h3>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead>Item Name</TableHead>
              {isMixed && <TableHead>Type</TableHead>}
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Total Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stockRows.map((r) => (
              <TableRow key={r.id} data-testid={`row-adj-item-${r.id}`}>
                <TableCell>
                  <div className="font-medium">{r.stockItemName}</div>
                  {r.stockItemCode && r.stockItemCode !== "-" && (
                    <div className="text-xs text-muted-foreground">{r.stockItemCode}</div>
                  )}
                </TableCell>
                {isMixed && (
                  <TableCell>
                    <Badge variant={r.adjustmentType === "Production" ? "default" : "secondary"} className="text-xs">
                      {r.adjustmentType}
                    </Badge>
                  </TableCell>
                )}
                <TableCell className="text-right font-mono">{fmtNum(r.quantity)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(r.rate)}</TableCell>
                <TableCell className="text-right font-mono">
                  {fmt(Math.abs(parseFloat(r.totalAmount || "0")))}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-bold bg-muted/50">
              <TableCell colSpan={isMixed ? 2 : 1}>Total</TableCell>
              <TableCell className="text-right font-mono">{fmtNum(grandQty)}</TableCell>
              <TableCell />
              <TableCell className="text-right font-mono">{fmt(grandTotal)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
