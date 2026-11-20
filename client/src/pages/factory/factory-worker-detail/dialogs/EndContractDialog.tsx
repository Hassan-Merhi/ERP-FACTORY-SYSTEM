import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * EndContractDialog — extracted from FactoryWorkerDetail.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryWorkerDetailModel } from "../../factoryworkerdetail/useFactoryWorkerDetailModel";

type FactoryWorkerDetailModel = ReturnType<typeof useFactoryWorkerDetailModel>;
import { UserX, Calculator, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { fmtNum } from "../../factoryworkerdetail/utils";

export function EndContractDialog({
  cashAccounts,
  endCalculating,
  endCashAccountId,
  endEnd,
  endOpen,
  endResult,
  endStart,
  endStep,
  endSubmitting,
  handleCalculate,
  handleEndContract,
  handleSkipAndEnd,
  payrollBalance,
  setEndCashAccountId,
  setEndEnd,
  setEndOpen,
  setEndResult,
  setEndStart,
  setEndStep,
  worker,
}: {
  cashAccounts: FactoryWorkerDetailModel["cashAccounts"];
  endCalculating: FactoryWorkerDetailModel["endCalculating"];
  endCashAccountId: FactoryWorkerDetailModel["endCashAccountId"];
  endEnd: FactoryWorkerDetailModel["endEnd"];
  endOpen: FactoryWorkerDetailModel["endOpen"];
  endResult: FactoryWorkerDetailModel["endResult"];
  endStart: FactoryWorkerDetailModel["endStart"];
  endStep: FactoryWorkerDetailModel["endStep"];
  endSubmitting: FactoryWorkerDetailModel["endSubmitting"];
  handleCalculate: FactoryWorkerDetailModel["handleCalculate"];
  handleEndContract: FactoryWorkerDetailModel["handleEndContract"];
  handleSkipAndEnd: FactoryWorkerDetailModel["handleSkipAndEnd"];
  payrollBalance: FactoryWorkerDetailModel["payrollBalance"];
  setEndCashAccountId: FactoryWorkerDetailModel["setEndCashAccountId"];
  setEndEnd: FactoryWorkerDetailModel["setEndEnd"];
  setEndOpen: FactoryWorkerDetailModel["setEndOpen"];
  setEndResult: FactoryWorkerDetailModel["setEndResult"];
  setEndStart: FactoryWorkerDetailModel["setEndStart"];
  setEndStep: FactoryWorkerDetailModel["setEndStep"];
  worker: FactoryWorkerDetailModel["worker"];
}) {
  if (!worker) return null;

  return (
    <Dialog
      open={endOpen}
      onOpenChange={(open) => {
        if (!open) setEndOpen(false);
      }}
    >
      <DialogContent data-testid="dialog-end-contract">
        <DialogHeader>
          <DialogTitle>End Contract — {worker.fullName}</DialogTitle>
          <DialogDescription>
            {endStep === 1
              ? "Set the settlement period to calculate the final balance."
              : "Review the settlement and choose payment."}
          </DialogDescription>
        </DialogHeader>

        {endStep === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Period Start</Label>
                <Input
                  type="date"
                  value={endStart}
                  onChange={(e) => setEndStart(e.target.value)}
                  data-testid="input-end-start"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Period End</Label>
                <Input
                  type="date"
                  value={endEnd}
                  onChange={(e) => setEndEnd(e.target.value)}
                  data-testid="input-end-end"
                />
              </div>
            </div>
            <Button
              onClick={handleCalculate}
              disabled={endCalculating || !endStart || !endEnd}
              className="w-full"
              data-testid="button-calculate"
            >
              <Calculator className="h-4 w-4 mr-2" />
              {endCalculating ? "Calculating..." : "Calculate Settlement"}
            </Button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={handleSkipAndEnd}
              disabled={endSubmitting}
              className="w-full text-muted-foreground"
              data-testid="button-skip-end-contract"
            >
              <UserX className="h-4 w-4 mr-2" />
              {endSubmitting ? "Ending..." : "End Contract Without Payment"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Immediately deactivates the worker. No settlement payroll is created.
            </p>
          </div>
        )}

        {endStep === 2 && endResult && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Earned</p>
                <p className="font-semibold text-sm" data-testid="text-earned">
                  ${fmtNum(endResult.earned)}
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Already Paid</p>
                <p className="font-semibold text-sm" data-testid="text-paid">
                  ${fmtNum(endResult.paid)}
                </p>
              </div>
              <div
                className={`rounded-md border p-3 text-center ${parseFloat(endResult.advances) > 0 ? "border-orange-300 bg-orange-50 dark:bg-orange-900/20" : ""}`}
              >
                <p className="text-xs text-muted-foreground mb-1">Advances</p>
                <p className="font-semibold text-sm" data-testid="text-advances">
                  ${fmtNum(endResult.advances)}
                </p>
              </div>
              <div
                className={`rounded-md border p-3 text-center ${payrollBalance > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20" : "border-green-300 bg-green-50 dark:bg-green-900/20"}`}
              >
                <p className="text-xs text-muted-foreground mb-1">Balance</p>
                <p className="font-semibold text-sm" data-testid="text-balance">
                  ${fmtNum(endResult.balance)}
                </p>
              </div>
            </div>
            {payrollBalance > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Cash Account (Pay Now)</Label>
                <UnifiedAccountPicker
                  options={(cashAccounts ?? []).map((a) => ({ value: String(a.id), name: a.name }))}
                  value={endCashAccountId}
                  onChange={setEndCashAccountId}
                  placeholder={"Select account..."}
                  testId={"select-cash-account"}
                />
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  setEndStep(1);
                  setEndResult(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
              {payrollBalance > 0 ? (
                <>
                  <Button
                    className="flex-1"
                    onClick={() => handleEndContract(true)}
                    disabled={endSubmitting || !endCashAccountId}
                    data-testid="button-pay-now"
                  >
                    {endSubmitting ? "Processing..." : `Pay Now $${fmtNum(endResult.balance)}`}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => handleEndContract(false)}
                    disabled={endSubmitting}
                    data-testid="button-pay-later"
                  >
                    Pay Later — End Contract
                  </Button>
                </>
              ) : (
                <Button
                  className="flex-1"
                  onClick={() => handleEndContract(false)}
                  disabled={endSubmitting}
                  data-testid="button-end-confirm"
                >
                  {endSubmitting ? "Processing..." : "End Contract"}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
