// Extracted from ./FactoryWorkerAdvancesPanel.tsx to keep that module under the source-size cap.
import { Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt } from "./utils";
import { AdvanceRow } from "./components/AdvanceRow";
import { useFactoryWorkerAdvancesPanelState } from "./useFactoryWorkerAdvancesPanelState";

export function FactoryWorkerAdvancesPanelCardSection({
  advanceAmount,
  advanceCashAccountId,
  advanceDate,
  advanceNotes,
  advanceRepaymentType,
  canChangeExistingRecords,
  cashAccounts,
  createAdvanceMutation,
  expandedAdvanceId,
  formatDate,
  getEndOfMonth,
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
  workerAdvances,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useFactoryWorkerAdvancesPanelState>,
  | "advanceAmount"
  | "advanceCashAccountId"
  | "advanceDate"
  | "advanceNotes"
  | "advanceRepaymentType"
  | "canChangeExistingRecords"
  | "cashAccounts"
  | "createAdvanceMutation"
  | "expandedAdvanceId"
  | "formatDate"
  | "getEndOfMonth"
  | "setAdvanceAmount"
  | "setAdvanceCashAccountId"
  | "setAdvanceDate"
  | "setAdvanceNotes"
  | "setAdvanceRepaymentType"
  | "setBulkRepayCashAccountId"
  | "setBulkRepayDates"
  | "setBulkRepayOpen"
  | "setExpandedAdvanceId"
  | "setRepayAdvanceId"
  | "setRepayAmount"
  | "setRepayCashAccountId"
  | "setRepayDate"
  | "setRepayNotes"
  | "setShowAdvanceForm"
  | "showAdvanceForm"
  | "workerAdvances"
  | "wrapAdminAction"
>) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-sm">Advance History</CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            const allOutstanding = (workerAdvances || []).filter((a) => !a.fullyPaid);
            const salaryDeduction = allOutstanding.filter((a) => a.repaymentType !== "manual_repayment");
            const manualRepayment = allOutstanding.filter((a) => a.repaymentType === "manual_repayment");
            const salaryBal = salaryDeduction.reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
            const loanBal = manualRepayment.reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
            return (
              <>
                {salaryBal > 0 && (
                  <Badge
                    variant="outline"
                    className="border-amber-400 text-amber-700 dark:text-amber-400"
                    data-testid="badge-advance-salary-balance"
                  >
                    Salary Ded: {fmt(salaryBal)}
                  </Badge>
                )}
                {canChangeExistingRecords && loanBal > 0 && (
                  <>
                    <Badge
                      variant="outline"
                      className="border-blue-400 text-blue-700 dark:text-blue-400"
                      data-testid="badge-advance-loan-balance"
                    >
                      Loan: {fmt(loanBal)}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const loans = (workerAdvances || []).filter(
                          (a) =>
                            a.repaymentType === "manual_repayment" &&
                            !a.fullyPaid &&
                            parseFloat(a.remainingBalance || "0") > 0
                        );
                        const initialDates: Record<number, string> = {};
                        for (const loan of loans) initialDates[loan.id] = getEndOfMonth(loan.advanceDate);
                        setBulkRepayDates(initialDates);
                        setBulkRepayCashAccountId("");
                        setBulkRepayOpen(true);
                      }}
                      data-testid="button-bulk-repay-all"
                    >
                      <RotateCcw className="h-4 w-4 mr-1" /> Repay All Loans
                    </Button>
                  </>
                )}
              </>
            );
          })()}
          {canChangeExistingRecords && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAdvanceForm(true)}
              data-testid="button-new-advance"
            >
              <Plus className="h-4 w-4 mr-1" /> Add Advance
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {showAdvanceForm && (
          <div className="p-4 border-b space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="space-y-1">
                <Label className="text-xs">Date</Label>
                <Input
                  type="date"
                  value={advanceDate}
                  onChange={(e) => setAdvanceDate(e.target.value)}
                  className="w-40"
                  data-testid="input-new-advance-date"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Amount ($)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  className="w-32"
                  data-testid="input-new-advance-amount"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <Input
                  placeholder="Optional"
                  value={advanceNotes}
                  onChange={(e) => setAdvanceNotes(e.target.value)}
                  className="w-40"
                  data-testid="input-new-advance-notes"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="space-y-1">
                <Label className="text-xs">Repayment Type</Label>
                <Select value={advanceRepaymentType} onValueChange={(v) => setAdvanceRepaymentType(v)}>
                  <SelectTrigger className="w-48" data-testid="select-advance-repayment-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salary_deduction">Deduct from Salary</SelectItem>
                    <SelectItem value="manual_repayment">Manual Repayment (Loan)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Cash Account (optional)</Label>
                <Select value={advanceCashAccountId} onValueChange={setAdvanceCashAccountId}>
                  <SelectTrigger className="w-48" data-testid="select-advance-cash-account">
                    <SelectValue placeholder="None (no cash deduction)" />
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
              <div className="flex items-end gap-2 mt-auto pt-4">
                <Button
                  size="sm"
                  onClick={() =>
                    wrapAdminAction(
                      () =>
                        createAdvanceMutation.mutate({
                          advanceDate,
                          amount: advanceAmount,
                          notes: advanceNotes,
                          repaymentType: advanceRepaymentType,
                          ...(advanceCashAccountId ? { cashAccountId: parseInt(advanceCashAccountId) } : {}),
                        }),
                      "Save Advance"
                    )
                  }
                  disabled={!advanceAmount || parseFloat(advanceAmount) <= 0 || createAdvanceMutation.isPending}
                  data-testid="button-save-advance"
                >
                  {createAdvanceMutation.isPending ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowAdvanceForm(false)}
                  data-testid="button-cancel-advance"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!workerAdvances || workerAdvances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No advances recorded
                </TableCell>
              </TableRow>
            ) : (
              (() => {
                const salaryAdvances = workerAdvances.filter((a) => a.repaymentType !== "manual_repayment");
                const loanAdvances = workerAdvances.filter((a) => a.repaymentType === "manual_repayment");
                const renderRows = (list: typeof workerAdvances, isLoan: boolean) =>
                  list.map((adv) => {
                    const isExpanded = expandedAdvanceId === adv.id;
                    return (
                      <AdvanceRow
                        key={adv.id}
                        adv={adv}
                        isLoan={isLoan}
                        isExpanded={isExpanded}
                        onToggleExpand={() => setExpandedAdvanceId(isExpanded ? null : adv.id)}
                        onRepay={
                          canChangeExistingRecords
                            ? () => {
                                setRepayAdvanceId(adv.id);
                                setRepayDate(new Date().toLocaleDateString("en-CA"));
                                setRepayAmount("");
                                setRepayCashAccountId("");
                                setRepayNotes("");
                              }
                            : undefined
                        }
                        formatDate={formatDate}
                        fmt={fmt}
                      />
                    );
                  });
                return (
                  <>
                    {salaryAdvances.length > 0 && (
                      <>
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="bg-muted/50 py-1.5 px-3 text-xs font-semibold text-muted-foreground"
                          >
                            Salary Deduction Advances ({salaryAdvances.length})
                          </TableCell>
                        </TableRow>
                        {renderRows(salaryAdvances, false)}
                      </>
                    )}
                    {loanAdvances.length > 0 && (
                      <>
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="bg-muted/50 py-1.5 px-3 text-xs font-semibold text-muted-foreground"
                          >
                            Loan / Manual Repayment Advances ({loanAdvances.length})
                          </TableCell>
                        </TableRow>
                        {renderRows(loanAdvances, true)}
                      </>
                    )}
                  </>
                );
              })()
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
