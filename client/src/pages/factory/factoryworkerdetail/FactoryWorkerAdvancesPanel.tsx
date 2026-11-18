import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { fmt } from "./utils";
import {
  useFactoryWorkerAdvancesPanelState,
  type FactoryWorkerDetailModelProps,
} from "./useFactoryWorkerAdvancesPanelState";
import { FactoryWorkerAdvancesPanelCardSection } from "./FactoryWorkerAdvancesPanelCardSection";
import { formatUsd } from "@/lib/moneyDisplay";

export function FactoryWorkerAdvancesPanel(props: FactoryWorkerDetailModelProps) {
  const {
    advanceAmount,
    advanceCashAccountId,
    advanceDate,
    advanceNotes,
    advanceRepaymentType,
    bulkRepayCashAccountId,
    bulkRepayDates,
    bulkRepayMutation,
    bulkRepayOpen,
    canChangeExistingRecords,
    cashAccounts,
    createAdvanceMutation,
    expandedAdvanceId,
    formatDate,
    getEndOfMonth,
    repayAdvanceId,
    repayAmount,
    repayCashAccountId,
    repayDate,
    repayNotes,
    repaymentMutation,
    setAdvanceAmount,
    setAdvanceCashAccountId,
    setAdvanceDate,
    setAdvanceNotes,
    setAdvanceRepaymentType,
    setBulkRepayCashAccountId,
    setBulkRepayDates,
    setBulkRepayOpen,
    setExpandedAdvanceId,
    setRepayAdvanceId,
    setRepayAmount,
    setRepayCashAccountId,
    setRepayDate,
    setRepayNotes,
    setShowAdvanceForm,
    showAdvanceForm,
    showAdvances,
    workerAdvances,
    wrapAdminAction,
  } = useFactoryWorkerAdvancesPanelState(props);
  return (
    <>
      {showAdvances && (
        <TabsContent value="advances" className="space-y-4">
          {/* Advance balance KPIs */}
          {(() => {
            const allOutstanding = (workerAdvances || []).filter((a) => !a.fullyPaid);
            const salaryDeductionBal = allOutstanding
              .filter((a) => a.repaymentType !== "manual_repayment")
              .reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
            const loanBal = allOutstanding
              .filter((a) => a.repaymentType === "manual_repayment")
              .reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
            const totalOwed = salaryDeductionBal + loanBal;
            return (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Card>
                  <CardHeader className="pb-1 pt-3 px-4">
                    <CardTitle className="text-xs font-medium text-muted-foreground">
                      Salary Advance Remaining
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <p
                      className={`text-xl font-bold font-mono ${salaryDeductionBal > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
                      data-testid="kpi-salary-advance-balance"
                    >
                      {formatUsd(salaryDeductionBal, 2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {salaryDeductionBal > 0 ? "Worker owes company" : "No outstanding"}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1 pt-3 px-4">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Loan Remaining</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <p
                      className={`text-xl font-bold font-mono ${loanBal > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}
                      data-testid="kpi-loan-balance"
                    >
                      {formatUsd(loanBal, 2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {loanBal > 0 ? "Worker owes company" : "No outstanding"}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1 pt-3 px-4">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Total Balance</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <p
                      className={`text-xl font-bold font-mono ${totalOwed > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                      data-testid="kpi-total-advance-balance"
                    >
                      {formatUsd(totalOwed, 2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {totalOwed > 0 ? "Worker owes company" : "All settled"}
                    </p>
                  </CardContent>
                </Card>
              </div>
            );
          })()}

          <FactoryWorkerAdvancesPanelCardSection
            advanceAmount={advanceAmount}
            advanceCashAccountId={advanceCashAccountId}
            advanceDate={advanceDate}
            advanceNotes={advanceNotes}
            advanceRepaymentType={advanceRepaymentType}
            canChangeExistingRecords={canChangeExistingRecords}
            cashAccounts={cashAccounts}
            createAdvanceMutation={createAdvanceMutation}
            expandedAdvanceId={expandedAdvanceId}
            formatDate={formatDate}
            getEndOfMonth={getEndOfMonth}
            setAdvanceAmount={setAdvanceAmount}
            setAdvanceCashAccountId={setAdvanceCashAccountId}
            setAdvanceDate={setAdvanceDate}
            setAdvanceNotes={setAdvanceNotes}
            setAdvanceRepaymentType={setAdvanceRepaymentType}
            setBulkRepayCashAccountId={setBulkRepayCashAccountId}
            setBulkRepayDates={setBulkRepayDates}
            setBulkRepayOpen={setBulkRepayOpen}
            setExpandedAdvanceId={setExpandedAdvanceId}
            setRepayAdvanceId={setRepayAdvanceId}
            setRepayAmount={setRepayAmount}
            setRepayCashAccountId={setRepayCashAccountId}
            setRepayDate={setRepayDate}
            setRepayNotes={setRepayNotes}
            setShowAdvanceForm={setShowAdvanceForm}
            showAdvanceForm={showAdvanceForm}
            workerAdvances={workerAdvances}
            wrapAdminAction={wrapAdminAction}
          />

          {repayAdvanceId &&
            (() => {
              const adv = (workerAdvances || []).find((a) => a.id === repayAdvanceId);
              if (!adv) return null;
              const maxRepay = parseFloat(adv.remainingBalance || "0");
              return (
                <Dialog
                  open={true}
                  onOpenChange={(open) => {
                    if (!open) setRepayAdvanceId(null);
                  }}
                >
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Record Repayment</DialogTitle>
                      <DialogDescription>
                        Advance of {fmt(adv.amount)} | Remaining: {fmt(adv.remainingBalance)}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Date</Label>
                          <Input
                            type="date"
                            value={repayDate}
                            onChange={(e) => setRepayDate(e.target.value)}
                            data-testid="input-repay-date"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Amount ($)</Label>
                          <Input
                            type="number"
                            min="0"
                            max={maxRepay}
                            step="0.01"
                            placeholder={`Max ${maxRepay.toFixed(2)}`}
                            value={repayAmount}
                            onChange={(e) => setRepayAmount(e.target.value)}
                            data-testid="input-repay-amount"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Cash Account (receives repayment)</Label>
                        <Select value={repayCashAccountId} onValueChange={setRepayCashAccountId}>
                          <SelectTrigger data-testid="select-repay-cash-account">
                            <SelectValue placeholder="Select cash account (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            {(cashAccounts || []).map((a) => (
                              <SelectItem key={a.id} value={String(a.id)}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Notes</Label>
                        <Input
                          placeholder="Optional notes"
                          value={repayNotes}
                          onChange={(e) => setRepayNotes(e.target.value)}
                          data-testid="input-repay-notes"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setRepayAdvanceId(null)}
                        data-testid="button-cancel-repay"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() =>
                          wrapAdminAction(
                            () =>
                              repaymentMutation.mutate({
                                advanceId: repayAdvanceId,
                                repaymentDate: repayDate,
                                amount: repayAmount,
                                cashAccountId: repayCashAccountId ? parseInt(repayCashAccountId) : undefined,
                                notes: repayNotes || undefined,
                              }),
                            "Record Repayment"
                          )
                        }
                        disabled={!repayAmount || parseFloat(repayAmount) <= 0 || repaymentMutation.isPending}
                        data-testid="button-submit-repay"
                      >
                        {repaymentMutation.isPending ? "Saving..." : "Record Repayment"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              );
            })()}

          {/* Bulk Repay All Loans Dialog */}
          {bulkRepayOpen &&
            (() => {
              const outstandingLoans = (workerAdvances || []).filter(
                (a) =>
                  a.repaymentType === "manual_repayment" && !a.fullyPaid && parseFloat(a.remainingBalance || "0") > 0
              );
              const totalToClear = outstandingLoans.reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
              return (
                <Dialog
                  open={true}
                  onOpenChange={(open) => {
                    if (!open) setBulkRepayOpen(false);
                  }}
                >
                  <DialogContent className="max-w-lg" data-testid="dialog-bulk-repay">
                    <DialogHeader>
                      <DialogTitle>Repay All Outstanding Loans</DialogTitle>
                      <DialogDescription>
                        Each loan is repaid on the last day of its own month. Adjust any date if needed, then confirm.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      {/* Per-loan preview with individual editable dates */}
                      <div className="rounded-md border overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 bg-muted text-xs font-medium text-muted-foreground">
                          <span>Loan Issued</span>
                          <span className="text-right">Amount</span>
                          <span className="text-right">Repay On</span>
                        </div>
                        <div className="divide-y max-h-56 overflow-y-auto">
                          {outstandingLoans.map((a) => {
                            const repayDate = bulkRepayDates[a.id] || getEndOfMonth(a.advanceDate);
                            return (
                              <div
                                key={a.id}
                                className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-3 py-2 text-sm"
                              >
                                <span className="text-muted-foreground whitespace-nowrap">
                                  {formatDate(a.advanceDate)}
                                </span>
                                <span className="font-mono text-right whitespace-nowrap">
                                  {fmt(a.remainingBalance)}
                                </span>
                                <input
                                  type="date"
                                  value={repayDate}
                                  onChange={(e) => setBulkRepayDates((prev) => ({ ...prev, [a.id]: e.target.value }))}
                                  className="h-7 rounded-sm border border-input bg-transparent px-2 text-xs w-32"
                                  data-testid={`input-bulk-repay-date-${a.id}`}
                                />
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-t text-sm font-semibold">
                          <span>Total</span>
                          <span className="font-mono text-blue-700 dark:text-blue-400">{fmt(totalToClear)}</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Cash Account (receives repayment)</Label>
                        <Select value={bulkRepayCashAccountId} onValueChange={setBulkRepayCashAccountId}>
                          <SelectTrigger data-testid="select-bulk-repay-cash">
                            <SelectValue placeholder="Select cash account (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            {(cashAccounts || []).map((a) => (
                              <SelectItem key={a.id} value={String(a.id)}>
                                {a.name} ({a.code})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setBulkRepayOpen(false)}
                        data-testid="button-cancel-bulk-repay"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() =>
                          wrapAdminAction(
                            () =>
                              bulkRepayMutation.mutate({
                                advances: outstandingLoans.map((a) => ({
                                  id: a.id,
                                  repaymentDate: bulkRepayDates[a.id] || getEndOfMonth(a.advanceDate),
                                })),
                                cashAccountId: bulkRepayCashAccountId ? parseInt(bulkRepayCashAccountId) : undefined,
                              }),
                            "Repay All Loans"
                          )
                        }
                        disabled={bulkRepayMutation.isPending || outstandingLoans.length === 0}
                        data-testid="button-confirm-bulk-repay"
                      >
                        {bulkRepayMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Processing...
                          </>
                        ) : (
                          `Repay All ${fmt(totalToClear)}`
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              );
            })()}
        </TabsContent>
      )}
    </>
  );
}
