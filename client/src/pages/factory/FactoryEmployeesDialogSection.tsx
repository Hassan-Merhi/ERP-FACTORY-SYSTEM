// Extracted from ./FactoryEmployees.tsx to keep that module under the source-size cap.
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFactoryEmployeesState } from "./useFactoryEmployeesState";
import { formatUsd } from "@/lib/moneyDisplay";

export function FactoryEmployeesDialogFooterSection({
  createMutation,
  editingEmployee,
  formData,
  recordChanges,
  setCreateOpen,
  setEditingEmployee,
  updateMutation,
}: Pick<
  ReturnType<typeof useFactoryEmployeesState>,
  | "createMutation"
  | "editingEmployee"
  | "formData"
  | "recordChanges"
  | "setCreateOpen"
  | "setEditingEmployee"
  | "updateMutation"
>) {
  return (
    <DialogFooter>
      <Button
        variant="outline"
        onClick={() => {
          setCreateOpen(false);
          setEditingEmployee(null);
        }}
        data-testid="button-cancel"
      >
        Cancel
      </Button>
      {(editingEmployee ? recordChanges.allowed : recordChanges.canCreate("POST", "/api/factory/employees")) && (
        <Button
          onClick={() => {
            if (editingEmployee) {
              updateMutation.mutate({ id: editingEmployee.id, data: formData });
            } else {
              createMutation.mutate(formData);
            }
          }}
          disabled={createMutation.isPending || updateMutation.isPending}
          data-testid="button-save"
        >
          {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save"}
        </Button>
      )}
    </DialogFooter>
  );
}

export function FactoryEmployeesDialogSection({
  deactivateMutation,
  employees,
  endingContractEmployee,
  setEndingContractEmployee,
}: Pick<
  ReturnType<typeof useFactoryEmployeesState>,
  "deactivateMutation" | "employees" | "endingContractEmployee" | "setEndingContractEmployee"
>) {
  return (
    <Dialog
      open={!!endingContractEmployee}
      onOpenChange={(open) => {
        if (!open) setEndingContractEmployee(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>End Contract</DialogTitle>
        </DialogHeader>
        {endingContractEmployee &&
          (() => {
            const liveEmp = employees.find((e) => e.id === endingContractEmployee.id) ?? endingContractEmployee;
            const balance = parseFloat(liveEmp.currentBalance || "0");
            const fmtBal = (v: number) => formatUsd(v, 2);
            return (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ending contract for{" "}
                  <span className="font-semibold text-foreground">
                    {endingContractEmployee.firstName} {endingContractEmployee.lastName}
                  </span>
                  . They will be marked inactive but can be reactivated later.
                </p>
                {balance > 0 ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium text-sm">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Outstanding balance: {fmtBal(balance)}
                    </div>
                    <p className="text-xs text-amber-700/80 dark:text-amber-400/80 leading-relaxed">
                      Running payroll records salary as <em>earned</em> — it doesn't mean cash was handed out. To clear
                      this balance, go to <strong>Withdrawals</strong> and record a cash payment of {fmtBal(balance)}{" "}
                      before ending the contract.
                    </p>
                  </div>
                ) : balance < 0 ? (
                  <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium text-sm">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Employee owes: {fmtBal(Math.abs(balance))}
                    </div>
                    <p className="text-xs text-red-700/80 dark:text-red-400/80">
                      This employee has a negative balance — they owe the company {fmtBal(Math.abs(balance))}. Collect
                      this before ending the contract if needed.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 p-3 flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Balance is clear — safe to end contract
                  </div>
                )}
              </div>
            );
          })()}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setEndingContractEmployee(null)}
            disabled={deactivateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => endingContractEmployee && deactivateMutation.mutate(endingContractEmployee.id)}
            disabled={deactivateMutation.isPending}
            data-testid="button-confirm-end-contract"
          >
            {deactivateMutation.isPending ? "Ending..." : "End Contract Anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryEmployeesDialogSection2({
  recalcResult,
  recalcResultOpen,
  setRecalcResultOpen,
}: Pick<ReturnType<typeof useFactoryEmployeesState>, "recalcResult" | "recalcResultOpen" | "setRecalcResultOpen">) {
  return (
    <Dialog open={recalcResultOpen} onOpenChange={setRecalcResultOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            Balances Recalculated
          </DialogTitle>
          <DialogDescription>
            {recalcResult?.updated ?? 0} employee{recalcResult?.updated !== 1 ? "s" : ""} updated from voucher records.
          </DialogDescription>
        </DialogHeader>
        {recalcResult &&
        recalcResult.employees.filter((e) => Math.abs(e.oldBalance - e.newBalance) > 0.005).length > 0 ? (
          <div className="max-h-64 overflow-y-auto border rounded-xl overflow-hidden text-sm">
            <div className="grid grid-cols-3 px-3 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground">
              <span>Employee</span>
              <span className="text-right">Old Balance</span>
              <span className="text-right">New Balance</span>
            </div>
            {recalcResult.employees
              .filter((e) => Math.abs(e.oldBalance - e.newBalance) > 0.005)
              .map((e) => (
                <div key={e.id} className="grid grid-cols-3 px-3 py-2 border-t">
                  <span className="truncate">{e.name}</span>
                  <span className="text-right font-mono text-muted-foreground">${e.oldBalance.toFixed(2)}</span>
                  <span
                    className={`text-right font-mono font-medium ${e.newBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    ${e.newBalance.toFixed(2)}
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            All balances were already correct — no changes needed.
          </p>
        )}
        <DialogFooter>
          <Button onClick={() => setRecalcResultOpen(false)} data-testid="button-close-recalc-result">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryEmployeesDialogSection3({
  recalcConfirmOpen,
  recalcMutation,
  setRecalcConfirmOpen,
}: Pick<ReturnType<typeof useFactoryEmployeesState>, "recalcConfirmOpen" | "recalcMutation" | "setRecalcConfirmOpen">) {
  return (
    <Dialog open={recalcConfirmOpen} onOpenChange={setRecalcConfirmOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recalculate All Employee Balances</DialogTitle>
          <DialogDescription>
            This will rebuild every employee's current balance, total deposits, and total withdrawals from their actual
            accounting records. Use this to fix balances that were corrupted by deletions that didn't reverse properly.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            This will overwrite the stored balances for <strong>all employees</strong> based on surviving voucher
            records.
          </span>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setRecalcConfirmOpen(false)} disabled={recalcMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => recalcMutation.mutate()}
            disabled={recalcMutation.isPending}
            data-testid="button-confirm-recalculate"
          >
            {recalcMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Recalculating...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Recalculate Now
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
