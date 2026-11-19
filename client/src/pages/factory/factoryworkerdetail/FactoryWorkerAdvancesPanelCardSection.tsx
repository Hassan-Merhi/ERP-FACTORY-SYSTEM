// Extracted from ./FactoryWorkerAdvancesPanel.tsx to keep that module under the source-size cap.
import { Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmt } from "./utils";
import { useFactoryWorkerAdvancesPanelState } from "./useFactoryWorkerAdvancesPanelState";
import { FactoryWorkerAdvancesPanelCardSectionCardContent } from "./FactoryWorkerAdvancesPanelCardSectionCardContent";

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
      <FactoryWorkerAdvancesPanelCardSectionCardContent
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
        setAdvanceAmount={setAdvanceAmount}
        setAdvanceCashAccountId={setAdvanceCashAccountId}
        setAdvanceDate={setAdvanceDate}
        setAdvanceNotes={setAdvanceNotes}
        setAdvanceRepaymentType={setAdvanceRepaymentType}
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
    </Card>
  );
}
