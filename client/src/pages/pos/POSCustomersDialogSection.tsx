// Extracted from ./POSCustomers.tsx to keep that module under the source-size cap.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { drCrClass } from "@/lib/formatNumber";
import { format } from "date-fns";
import { usePOSCustomersState } from "./usePOSCustomersState";

export function POSCustomersDialogSection({
  closingBalance,
  formatAmount,
  formatCashAmount,
  handlePrint,
  openingBalance,
  setStatementCustomer,
  sorted,
  statementCustomer,
  totalCr,
  totalDr,
  txnsLoading,
}: Pick<
  ReturnType<typeof usePOSCustomersState>,
  | "closingBalance"
  | "formatAmount"
  | "formatCashAmount"
  | "handlePrint"
  | "openingBalance"
  | "setStatementCustomer"
  | "sorted"
  | "statementCustomer"
  | "totalCr"
  | "totalDr"
  | "txnsLoading"
>) {
  return (
    <Dialog open={!!statementCustomer} onOpenChange={(open) => !open && setStatementCustomer(null)}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <DialogTitle className="text-lg">{statementCustomer?.legalName}</DialogTitle>
              <div className="flex items-center gap-3 pt-1 text-sm text-muted-foreground">
                <span>
                  Balance:{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {formatCashAmount(statementCustomer?.balance || 0)}
                  </span>
                </span>
                <Badge variant="secondary" className={drCrClass(statementCustomer?.balanceSide || "Dr")}>
                  {statementCustomer?.balanceSide || "Dr"}
                </Badge>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <ExportButton
                kind="print"
                variant="outline"
                size="sm"
                onClick={() => handlePrint()}
                data-testid="button-print-statement"
              />
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto mt-2">
          {txnsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No transactions found</div>
          ) : (
            (() => {
              let running = openingBalance;
              return (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openingBalance !== 0 && (
                      <TableRow className="text-muted-foreground text-sm">
                        <TableCell>—</TableCell>
                        <TableCell className="italic">Opening Balance</TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell className="text-right font-mono">{formatAmount(Math.abs(openingBalance))}</TableCell>
                      </TableRow>
                    )}
                    {sorted.map((t, i) => {
                      const dr = parseFloat(t.debitAmount || "0");
                      const cr = parseFloat(t.creditAmount || "0");
                      running = running + dr - cr;
                      return (
                        <TableRow key={t.entryId ?? i}>
                          <TableCell className="font-mono text-sm whitespace-nowrap">
                            {t.voucherDate ? format(new Date(t.voucherDate), "yyyy-MM-dd") : "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                            {t.narration || t.voucherDescription || t.voucherType || "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {dr > 0 ? formatAmount(dr) : ""}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {cr > 0 ? formatAmount(cr) : ""}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">
                            {formatAmount(Math.abs(running))}
                            <span className={`text-xs font-semibold ml-1 ${drCrClass(running >= 0 ? "Dr" : "Cr")}`}>
                              {running >= 0 ? "Dr" : "Cr"}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  <TableHeader className="border-t-2">
                    <TableRow className="font-semibold">
                      <TableHead colSpan={2}>Total</TableHead>
                      <TableHead className="text-right font-mono text-foreground">{formatAmount(totalDr)}</TableHead>
                      <TableHead className="text-right font-mono text-foreground">{formatAmount(totalCr)}</TableHead>
                      <TableHead className="text-right font-mono text-foreground">
                        {formatAmount(Math.abs(closingBalance))}
                        <span
                          className={`text-xs font-semibold ml-1 ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}
                        >
                          {statementCustomer?.balanceSide || "Dr"}
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                </Table>
              );
            })()
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
