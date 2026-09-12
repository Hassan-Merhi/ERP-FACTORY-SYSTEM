/**
 * Payment / Receipt body of the All Daybook voucher detail dialog: the
 * paid-from / received-in banner plus the single-amount entries table.
 *
 * Split out of TransactionJournal.tsx unchanged, including which side of the
 * double entry is treated as the source account and which rows are listed.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JournalViewEntry } from "../../types";
import type { DetailPanelFormatters } from "./panelTypes";

export function PaymentReceiptPanel({
  vtype,
  viewEntries,
  entryBalances,
  fmt,
}: {
  vtype: string;
  viewEntries: JournalViewEntry[];
  entryBalances: Record<number, string>;
} & Pick<DetailPanelFormatters, "fmt">) {
  const sourceEntry =
    vtype === "Payment"
      ? viewEntries.find((e) => parseFloat(e.creditAmount || "0") > 0)
      : viewEntries.find((e) => parseFloat(e.debitAmount || "0") > 0);

  const total =
    vtype === "Payment"
      ? viewEntries.reduce((s, e) => s + parseFloat(e.debitAmount || "0"), 0)
      : viewEntries.reduce((s, e) => s + parseFloat(e.creditAmount || "0"), 0);

  const displayEntries = viewEntries.filter((e) =>
    vtype === "Payment" ? parseFloat(e.debitAmount || "0") > 0 : parseFloat(e.creditAmount || "0") > 0
  );

  return (
    <div className="space-y-4">
      {sourceEntry && (
        <div className="p-3 md:p-4 bg-muted/50 rounded-md">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
            <div>
              <p className="text-sm text-muted-foreground mb-1">{vtype === "Payment" ? "Paid From" : "Received In"}</p>
              <div className="font-medium text-base md:text-lg">{sourceEntry.accountName}</div>
              {entryBalances[sourceEntry.id] !== undefined && (
                <div className="text-sm font-mono mt-2">Balance: {fmt(entryBalances[sourceEntry.id])}</div>
              )}
            </div>
            <div className="sm:text-right">
              <p className="text-sm text-muted-foreground mb-1">Total Amount</p>
              <div className="text-xl md:text-2xl font-bold font-mono">{fmt(total)}</div>
            </div>
          </div>
        </div>
      )}
      <div>
        <h3 className="font-semibold mb-3">Entries</h3>
        <div className="border rounded-md">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayEntries.map((entry) => {
                const amount = Math.max(parseFloat(entry.debitAmount || "0"), parseFloat(entry.creditAmount || "0"));
                return (
                  <TableRow key={entry.id} data-testid={`row-entry-${entry.id}`}>
                    <TableCell>
                      <div className="font-medium">{entry.accountName}</div>
                      {entryBalances[entry.id] !== undefined && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Balance: {fmt(entryBalances[entry.id])}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmt(amount)}</TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="font-bold bg-muted/50">
                <TableCell>Total</TableCell>
                <TableCell className="text-right font-mono">{fmt(total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
