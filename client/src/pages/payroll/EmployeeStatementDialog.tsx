import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";

interface EmployeeStatementDialogProps {
  statementEmployee: PayrollModel["statementEmployee"];
  setStatementEmployee: PayrollModel["setStatementEmployee"];
  transactionsLoading: boolean;
  employeeTransactions: PayrollModel["employeeTransactions"];
  statementExpanded: boolean;
  setStatementExpanded: PayrollModel["setStatementExpanded"];
  cleanTxnDesc: PayrollModel["cleanTxnDesc"];
}

export function EmployeeStatementDialog({
  statementEmployee,
  setStatementEmployee,
  transactionsLoading,
  employeeTransactions,
  statementExpanded,
  setStatementExpanded,
  cleanTxnDesc,
}: EmployeeStatementDialogProps) {
  const { formatAmount } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();

  return (
    <Dialog open={!!statementEmployee} onOpenChange={(open) => !open && setStatementEmployee(null)}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            {statementEmployee?.firstName} {statementEmployee?.lastName}
            {statementEmployee?.code && (
              <span className="text-sm font-normal text-muted-foreground">({statementEmployee.code})</span>
            )}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">Transaction history and account statement</p>
        </DialogHeader>

        {!transactionsLoading && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Current Balance</p>
              <p className="font-mono font-semibold text-sm mt-1">
                {formatAmount(parseFloat(statementEmployee?.calculatedBalance || "0"))}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {parseFloat(statementEmployee?.calculatedBalance || "0") >= 0 ? "Owed to employee" : "Advance taken"}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Total Deposited</p>
              <p className="font-mono font-semibold text-sm mt-1">
                {formatAmount(
                  employeeTransactions.filter((t) => !t.isDebit).reduce((s, t) => s + Number(t.amount || 0), 0)
                )}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Credits</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Total Withdrawn</p>
              <p className="font-mono font-semibold text-sm mt-1">
                {formatAmount(
                  employeeTransactions.filter((t) => t.isDebit).reduce((s, t) => s + Number(t.amount || 0), 0)
                )}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Debits</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Transactions</p>
              <p className="font-mono font-semibold text-sm mt-1">{employeeTransactions.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Total entries</p>
            </div>
          </div>
        )}

        <div className="mt-2">
          {transactionsLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : employeeTransactions.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm">
              No transactions found for this employee
            </div>
          ) : (
            (() => {
              const sorted = [...employeeTransactions].sort(
                (a, b) => new Date(a.date || "").getTime() - new Date(b.date || "").getTime()
              );
              const totalDebit = sorted.reduce((s, t) => s + (t.isDebit ? Number(t.amount || 0) : 0), 0);
              const totalCredit = sorted.reduce((s, t) => s + (!t.isDebit ? Number(t.amount || 0) : 0), 0);
              const currentBalance = parseFloat(statementEmployee?.calculatedBalance || "0");
              const openingBalance = currentBalance - totalCredit + totalDebit;
              return (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setStatementExpanded((prev) => !prev)}
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover-elevate"
                    data-testid="button-toggle-statement"
                  >
                    <span className="text-muted-foreground">{sorted.length} transactions</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 transition-transform text-muted-foreground",
                        statementExpanded && "rotate-180"
                      )}
                    />
                  </button>

                  {statementExpanded && (
                    <div className="space-y-0">
                      <div className="hidden md:block border rounded-md overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Date</TableHead>
                              <TableHead>Description</TableHead>
                              <TableHead className="text-right">Debit</TableHead>
                              <TableHead className="text-right">Credit</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <TableRow className="bg-muted/20 font-medium">
                              <TableCell className="text-sm text-muted-foreground" colSpan={2}>
                                Opening Balance
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {openingBalance < 0 ? (
                                  formatAmount(Math.abs(openingBalance))
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {openingBalance >= 0 ? (
                                  formatAmount(openingBalance)
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                            {sorted.map((txn) => (
                              <TableRow key={txn.id || `${txn.voucherId}-${txn.date}`}>
                                <TableCell className="font-mono text-sm whitespace-nowrap">
                                  {txn.date ? formatDisplayDate(txn.date) : "-"}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {cleanTxnDesc(
                                    txn.narration || txn.voucherDescription || txn.description || txn.voucherType || "-"
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {txn.isDebit ? (
                                    formatAmount(Number(txn.amount || 0))
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {!txn.isDebit ? (
                                    formatAmount(Number(txn.amount || 0))
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                          <tfoot>
                            <TableRow className="border-t-2 font-semibold bg-muted/40">
                              <TableCell colSpan={2} className="text-sm">
                                Total
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatAmount(totalDebit)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {formatAmount(totalCredit)}
                              </TableCell>
                            </TableRow>
                            <TableRow className="font-semibold bg-muted/20">
                              <TableCell colSpan={3} className="text-sm text-muted-foreground">
                                Current Balance
                              </TableCell>
                              <TableCell
                                className={`text-right font-mono text-sm ${currentBalance >= 0 ? "" : "text-destructive"}`}
                              >
                                {formatAmount(Math.abs(currentBalance))}
                                {currentBalance < 0 ? " (Dr)" : ""}
                              </TableCell>
                            </TableRow>
                          </tfoot>
                        </Table>
                      </div>
                      <div className="md:hidden space-y-0 border rounded-md overflow-hidden">
                        <div className="divide-y">
                          {sorted.map((txn) => (
                            <div
                              key={txn.id || `${txn.voucherId}-${txn.date}`}
                              className="flex items-start justify-between gap-3 px-3 py-2"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-muted-foreground font-mono">
                                  {txn.date ? formatDisplayDate(txn.date) : "-"}
                                </p>
                                <p className="text-sm truncate">
                                  {cleanTxnDesc(
                                    txn.narration || txn.voucherDescription || txn.description || txn.voucherType || "-"
                                  )}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                {txn.isDebit ? (
                                  <p className="font-mono text-sm font-medium">
                                    {formatAmount(Number(txn.amount || 0))}
                                  </p>
                                ) : (
                                  <p className="font-mono text-sm font-medium text-green-600 dark:text-green-400">
                                    {formatAmount(Number(txn.amount || 0))}
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground">{txn.isDebit ? "Dr" : "Cr"}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="px-3 pt-2 pb-3 space-y-1 border-t-2">
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Opening Balance</span>
                            <span className="font-mono font-semibold">
                              {formatAmount(Math.abs(openingBalance))}
                              {openingBalance < 0 ? " (Dr)" : ""}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Total Debit</span>
                            <span className="font-mono font-semibold">{formatAmount(totalDebit)}</span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Total Credit</span>
                            <span className="font-mono font-semibold">{formatAmount(totalCredit)}</span>
                          </div>
                          <div className="flex justify-between text-sm font-semibold">
                            <span>Current Balance</span>
                            <span className={`font-mono ${currentBalance >= 0 ? "" : "text-destructive"}`}>
                              {formatAmount(Math.abs(currentBalance))}
                              {currentBalance < 0 ? " (Dr)" : ""}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
