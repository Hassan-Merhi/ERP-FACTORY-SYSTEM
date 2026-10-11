import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Amounts that are not in the ledger yet (accounting audit wave 10): factory
 * POS credit sales, unposted factory invoices, cache-only customer records.
 * The server lists them next to a customer's ledger statement; they are shown
 * here for information and are never part of the statement's balance.
 */
export interface NotInLedgerRow {
  id: string;
  voucherNumber: string;
  voucherDate: string;
  voucherDescription: string;
  debitAmount: string;
  creditAmount: string;
  currency?: string | null;
}

export interface NotInLedgerData {
  label: string;
  total: string;
  rows: NotInLedgerRow[];
}

export function readNotInLedger(payload: unknown): NotInLedgerData | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const section = (payload as { notInLedger?: unknown }).notInLedger;
  if (!section || typeof section !== "object") return null;
  const rows = (section as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return section as NotInLedgerData;
}

export function NotInLedgerSection({
  data,
  formatAmount,
  formatDisplayDate,
}: {
  data: NotInLedgerData;
  formatAmount: (amount: number) => string;
  formatDisplayDate: (date: string) => string;
}) {
  return (
    <div className="mt-4 rounded-md border border-dashed p-3" data-testid="section-not-in-ledger">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Not yet in the ledger</Badge>
        <span className="text-xs text-muted-foreground">
          Shown for information only; not part of the ledger balance above.
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row) => (
            <TableRow key={row.id} data-testid={`row-not-in-ledger-${row.id}`}>
              <TableCell className="whitespace-nowrap font-mono text-sm">
                {formatDisplayDate(row.voucherDate)}
              </TableCell>
              <TableCell className="font-mono text-sm">{row.voucherNumber}</TableCell>
              <TableCell className="text-sm">{row.voucherDescription}</TableCell>
              <TableCell className="text-right font-mono text-sm">
                {Number(row.debitAmount) ? formatAmount(Number(row.debitAmount)) : ""}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {Number(row.creditAmount) ? formatAmount(Number(row.creditAmount)) : ""}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={3} className="text-sm font-semibold">
              Total not yet in the ledger
            </TableCell>
            <TableCell colSpan={2} className="text-right font-mono text-sm font-semibold">
              {formatAmount(Number(data.total))}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
