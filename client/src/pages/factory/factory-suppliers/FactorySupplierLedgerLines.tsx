import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FactorySupplierLedgerLineDto } from "./factorySupplierTypes";

interface FactorySupplierLedgerLinesProps {
  lines: FactorySupplierLedgerLineDto[];
  openingBalanceUsd: string;
  formatDate: (value: string) => string;
  formatNum: (val: string) => string;
}

const crText = (value: string, formatNum: (val: string) => string) => {
  const negative = value.startsWith("-");
  return `${formatNum(negative ? value.slice(1) : value)}${negative ? " DR" : ""}`;
};

/**
 * The factory supplier statement (accounting audit phase 25, AR-8): its rows
 * are the ledger lines the balance engine attributes to the supplier, oldest
 * first, with the running USD balance (Cr positive) from the ledger opening,
 * so the last row is the ledger balance. The container activity list is the
 * operational memo below it.
 */
export function FactorySupplierLedgerLines({
  lines,
  openingBalanceUsd,
  formatDate,
  formatNum,
}: FactorySupplierLedgerLinesProps) {
  return (
    <div className="min-w-0" data-testid="table-supplier-ledger-lines">
      <Table scrollLabel="Supplier ledger lines">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Voucher</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-end">Debit (USD)</TableHead>
            <TableHead className="text-end">Credit (USD)</TableHead>
            <TableHead className="text-end">Native</TableHead>
            <TableHead className="text-end">Balance (USD)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="bg-muted/20">
            <TableCell colSpan={6} className="text-sm text-muted-foreground">
              Opening Balance
            </TableCell>
            <TableCell className="text-end font-mono text-sm">{crText(openingBalanceUsd, formatNum)}</TableCell>
          </TableRow>
          {lines.map((line) => (
            <TableRow key={line.entryId} data-testid={`row-supplier-ledger-line-${line.entryId}`}>
              <TableCell className="font-mono text-sm whitespace-nowrap">{formatDate(line.date)}</TableCell>
              <TableCell className="font-mono text-xs">{line.voucherNumber}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{line.description}</TableCell>
              <TableCell className="text-end font-mono text-sm">
                {line.debitUsd === "0.00" ? "—" : formatNum(line.debitUsd)}
              </TableCell>
              <TableCell className="text-end font-mono text-sm">
                {line.creditUsd === "0.00" ? "—" : formatNum(line.creditUsd)}
              </TableCell>
              <TableCell className="text-end font-mono text-xs text-muted-foreground">
                {line.currency === "USD"
                  ? ""
                  : `${line.currency} ${formatNum(line.nativeCredit !== "0.00" ? line.nativeCredit : line.nativeDebit)}`}
              </TableCell>
              <TableCell className="text-end font-mono text-sm">{crText(line.runningBalanceUsd, formatNum)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
