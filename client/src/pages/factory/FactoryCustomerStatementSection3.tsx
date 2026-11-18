// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink } from "lucide-react";
import { drCrClass } from "@/lib/formatNumber";
import { fmtMoney, fmtNum } from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementStatePart2";

export function FactoryCustomerStatementSection3({
  filteredHistory,
  formatDisplayDate,
  hasFilters,
  navigate,
  recordChanges,
  rowNotes,
  saveRowNote,
  savingRowNote,
  setRowNotes,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "filteredHistory"
  | "formatDisplayDate"
  | "hasFilters"
  | "navigate"
  | "recordChanges"
  | "rowNotes"
  | "saveRowNote"
  | "savingRowNote"
  | "setRowNotes"
>) {
  return (
    <div className="rounded-xl border overflow-hidden table-responsive">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30">
          <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Date
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Type
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Container
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Destination
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Bales
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Kg
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Debit
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Credit
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Balance
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Side
            </TableHead>
            <TableHead className="min-w-[160px] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Note
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredHistory.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={11}
                className="text-center text-muted-foreground py-8"
                data-testid="text-no-transactions"
              >
                {hasFilters ? "No rows match the current filters" : "No transactions yet"}
              </TableCell>
            </TableRow>
          ) : (
            filteredHistory.map((entry) => {
              const isInvoice = entry.referenceType === "INVOICE" && entry.referenceId;
              return (
                <TableRow
                  key={entry.id}
                  data-testid={`row-balance-${entry.id}`}
                  className={isInvoice ? "cursor-pointer hover-elevate" : undefined}
                  onClick={isInvoice ? () => navigate(`/factory/sales/invoices/${entry.referenceId}`) : undefined}
                >
                  <TableCell
                    className="text-sm font-mono whitespace-nowrap"
                    data-testid={`text-balance-date-${entry.id}`}
                  >
                    {entry.transactionDate ? formatDisplayDate(entry.transactionDate) : "-"}
                  </TableCell>
                  <TableCell data-testid={`text-balance-type-${entry.id}`}>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-xs">
                        {entry.transactionType}
                      </Badge>
                      {isInvoice && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                    </div>
                  </TableCell>
                  <TableCell
                    className="text-sm font-mono text-muted-foreground whitespace-nowrap"
                    data-testid={`text-balance-container-${entry.id}`}
                  >
                    {entry.containerNumber || "-"}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-balance-destination-${entry.id}`}
                  >
                    {entry.destination || "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-bales-${entry.id}`}>
                    {entry.totalQtyBales != null ? fmtNum(entry.totalQtyBales) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-kg-${entry.id}`}>
                    {entry.totalWeightKg != null ? fmtNum(entry.totalWeightKg) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-debit-${entry.id}`}>
                    {Number(entry.debitAmount || 0) > 0 ? fmtMoney(Number(entry.debitAmount)) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-credit-${entry.id}`}>
                    {Number(entry.creditAmount || 0) > 0 ? fmtMoney(Number(entry.creditAmount)) : "-"}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono font-semibold"
                    data-testid={`text-balance-running-${entry.id}`}
                  >
                    {fmtMoney(Math.abs(entry.runningBalance))}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs font-semibold ${drCrClass(entry.runningBalanceSide)}`}>
                      {entry.runningBalanceSide}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-[160px]" data-mobile-cell="wide" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      value={rowNotes[entry.id] ?? ""}
                      onChange={(e) =>
                        typeof entry.id === "number" && setRowNotes((prev) => ({ ...prev, [entry.id]: e.target.value }))
                      }
                      onBlur={() => saveRowNote(entry.id, rowNotes[entry.id] ?? "")}
                      placeholder={typeof entry.id === "string" ? "—" : "Add note…"}
                      disabled={!recordChanges.allowed || savingRowNote === entry.id || typeof entry.id === "string"}
                      title={recordChanges.reason ?? undefined}
                      className="w-full text-xs bg-transparent border border-border rounded-sm px-2 py-1 placeholder:text-muted-foreground/50 focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
                      data-testid={`input-row-note-${entry.id}`}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
