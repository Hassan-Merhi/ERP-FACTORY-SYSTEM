// Extracted from ./Customers.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { drCrClass } from "@/lib/formatNumber";
import { Building2, Printer, Wallet } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { typeBadgeClass, useCompanyCustomersState } from "./useCompanyCustomersState";

export function CompanyCustomersDialogSection({
  formatHistoricalBaseAmount,
  ledgerTxns,
  retailHistory,
  retailHistoryError,
  retailHistoryLoading,
  selectedCompany,
  setStatementCustomer,
  statementCustomer,
  txnsLoading,
}: Pick<
  ReturnType<typeof useCompanyCustomersState>,
  | "formatHistoricalBaseAmount"
  | "ledgerTxns"
  | "retailHistory"
  | "retailHistoryError"
  | "retailHistoryLoading"
  | "selectedCompany"
  | "setStatementCustomer"
  | "statementCustomer"
  | "txnsLoading"
>) {
  return (
    <Dialog open={!!statementCustomer} onOpenChange={(open) => !open && setStatementCustomer(null)}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col gap-4">
        <DialogHeader className="pb-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            {statementCustomer?.legalName}
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Balance</span>
              <span className={`font-mono font-semibold ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}>
                {formatHistoricalBaseAmount(statementCustomer?.balance || 0)}
              </span>
              <Badge variant="secondary" className={`text-xs ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}>
                {statementCustomer?.balanceSide || "Dr"}
              </Badge>
            </div>
            {!txnsLoading && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground font-medium">
                {ledgerTxns.length} transaction{ledgerTxns.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          {txnsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            (() => {
              const sorted = [...ledgerTxns].sort(
                (a, b) => new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime()
              );
              const totalDr = sorted.reduce((s, t) => s + parseFloat(t.debitAmount || "0"), 0);
              const totalCr = sorted.reduce((s, t) => s + parseFloat(t.creditAmount || "0"), 0);
              const closingBalance = statementCustomer?.balance || 0;
              const openingBalance = closingBalance - totalDr + totalCr;
              let running = openingBalance;

              return sorted.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No transactions"
                  description="No ledger entries found for this customer"
                  className="py-10"
                />
              ) : (
                <div className="border rounded-xl overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
                        <TableHead className="text-xs h-9 font-semibold">Type</TableHead>
                        <TableHead className="text-xs h-9 font-semibold">Description</TableHead>
                        <TableHead className="text-xs h-9 font-semibold text-right">Debit</TableHead>
                        <TableHead className="text-xs h-9 font-semibold text-right">Credit</TableHead>
                        <TableHead className="text-xs h-9 font-semibold text-right">Balance</TableHead>
                        <TableHead className="text-xs h-9 w-8"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openingBalance !== 0 && (
                        <TableRow className="text-muted-foreground text-xs italic">
                          <TableCell className="py-2">—</TableCell>
                          <TableCell className="py-2"></TableCell>
                          <TableCell className="py-2">Opening Balance</TableCell>
                          <TableCell className="py-2"></TableCell>
                          <TableCell className="py-2"></TableCell>
                          <TableCell className="py-2 text-right font-mono font-medium">
                            {formatHistoricalBaseAmount(Math.abs(openingBalance))}
                          </TableCell>
                          <TableCell className="py-2"></TableCell>
                        </TableRow>
                      )}
                      {sorted.map((t, i) => {
                        const dr = parseFloat(t.debitAmount || "0");
                        const cr = parseFloat(t.creditAmount || "0");
                        running = running + dr - cr;
                        const isSale = t.voucherType === "Sales" && t.voucherId;
                        return (
                          <TableRow key={t.entryId ?? i} className="text-xs hover:bg-muted/40">
                            <TableCell className="py-2 font-mono whitespace-nowrap">
                              {t.voucherDate ? format(new Date(t.voucherDate), "yyyy-MM-dd") : "—"}
                            </TableCell>
                            <TableCell className="py-2">
                              {t.voucherType ? (
                                <Badge variant="secondary" className={`text-xs ${typeBadgeClass[t.voucherType] || ""}`}>
                                  {t.voucherType}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="py-2 text-muted-foreground max-w-[160px] truncate">
                              {t.narration || t.voucherDescription || "—"}
                            </TableCell>
                            <TableCell className="py-2 text-right font-mono">
                              {dr > 0 ? formatHistoricalBaseAmount(dr) : ""}
                            </TableCell>
                            <TableCell className="py-2 text-right font-mono">
                              {cr > 0 ? formatHistoricalBaseAmount(cr) : ""}
                            </TableCell>
                            <TableCell className="py-2 text-right font-mono font-medium">
                              {formatHistoricalBaseAmount(Math.abs(running))}
                              <span className={`text-xs font-semibold ml-1 ${drCrClass(running >= 0 ? "Dr" : "Cr")}`}>
                                {running >= 0 ? "Dr" : "Cr"}
                              </span>
                            </TableCell>
                            <TableCell className="py-2">
                              {isSale ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6"
                                  title="Print Invoice"
                                  aria-label="Print"
                                  data-testid={`btn-print-invoice-${t.voucherId}`}
                                  onClick={() => window.open(`/api/pos/invoice/${t.voucherId}/pdf`, "_blank")}
                                >
                                  <Printer className="h-3 w-3" />
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    <TableFooter className="bg-muted/40">
                      <TableRow className="font-semibold text-xs">
                        <TableCell colSpan={3}>Total</TableCell>
                        <TableCell className="text-right font-mono">{formatHistoricalBaseAmount(totalDr)}</TableCell>
                        <TableCell className="text-right font-mono">{formatHistoricalBaseAmount(totalCr)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatHistoricalBaseAmount(Math.abs(closingBalance))}
                          <span
                            className={`text-xs font-semibold ml-1 ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}
                          >
                            {statementCustomer?.balanceSide || "Dr"}
                          </span>
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              );
            })()
          )}
          {selectedCompany?.companyType === "retail" && statementCustomer && (
            <section className="mt-4 space-y-2 border-t pt-3" data-testid="retail-customer-purchases">
              <div>
                <h3 className="text-sm font-semibold">Retail POS purchases and returns</h3>
                <p className="text-xs text-muted-foreground">
                  Paid purchases appear here as sales history, not extra receivables. On-account sales and payments
                  affect the accounting ledger above.
                </p>
              </div>
              {retailHistoryLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : retailHistoryError ? (
                <p className="text-xs text-destructive">Could not load Retail POS purchase history.</p>
              ) : !retailHistory?.sales.length && !retailHistory?.returns.length ? (
                <p className="text-xs text-muted-foreground">No Retail POS purchases or returns yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Date</TableHead>
                        <TableHead className="text-xs">Transaction</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {retailHistory?.sales.map((sale) => (
                        <TableRow key={`sale-${sale.id}`} data-testid={`retail-customer-sale-${sale.id}`}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {format(new Date(sale.createdAt), "dd/MM/yyyy")}
                          </TableCell>
                          <TableCell className="text-xs">Sale #{sale.id}</TableCell>
                          <TableCell className="text-xs">{sale.status}</TableCell>
                          <TableCell className="text-xs text-right font-mono">
                            {formatHistoricalBaseAmount(sale.totalAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                      {retailHistory?.returns.map((entry) => (
                        <TableRow key={`return-${entry.id}`} data-testid={`retail-customer-return-${entry.id}`}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {format(new Date(entry.createdAt), "dd/MM/yyyy")}
                          </TableCell>
                          <TableCell className="text-xs">
                            Return #{entry.id} (sale #{entry.saleId ?? "—"})
                          </TableCell>
                          <TableCell className="text-xs">Refund</TableCell>
                          <TableCell className="text-xs text-right font-mono">
                            {formatHistoricalBaseAmount(entry.refundAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
