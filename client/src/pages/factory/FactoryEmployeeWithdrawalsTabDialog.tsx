// Extracted from ./FactoryEmployeeWithdrawalsTab.tsx
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt } from "./FactoryEmployeeWithdrawalsTabHelpers";
import { useFactoryEmployeeWithdrawalsTabState } from "./useFactoryEmployeeWithdrawalsTabState";

export function FactoryEmployeeWithdrawalsTabDialog({
  cashAccounts,
  employees,
  selectedEmp,
  setSingleForm,
  setSingleOpen,
  singleForm,
  singleMutation,
  singleOpen,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useFactoryEmployeeWithdrawalsTabState>,
  | "cashAccounts"
  | "employees"
  | "selectedEmp"
  | "setSingleForm"
  | "setSingleOpen"
  | "singleForm"
  | "singleMutation"
  | "singleOpen"
  | "wrapAdminAction"
>) {
  return (
    <Dialog
      open={singleOpen}
      onOpenChange={(o) => {
        if (!o) setSingleOpen(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw — Single Employee</DialogTitle>
          <DialogDescription>Record a cash withdrawal deducted from an employee.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Employee</Label>
            <Select
              value={singleForm.employeeId}
              onValueChange={(v) => setSingleForm((f) => ({ ...f, employeeId: v }))}
            >
              <SelectTrigger data-testid="select-single-employee">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.firstName} {e.lastName}
                    {e.code && ` (${e.code})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedEmp && (
              <p className="text-xs text-muted-foreground mt-1">
                Current balance:{" "}
                <span className={parseFloat(selectedEmp.currentBalance || "0") < 0 ? "text-red-500" : ""}>
                  {fmt(selectedEmp.currentBalance)}
                </span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={singleForm.date}
                onChange={(e) => setSingleForm((f) => ({ ...f, date: e.target.value }))}
                data-testid="input-withdraw-date"
              />
            </div>
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                placeholder="0.00"
                min="0"
                step="0.01"
                value={singleForm.amount}
                onChange={(e) => setSingleForm((f) => ({ ...f, amount: e.target.value }))}
                data-testid="input-withdraw-amount"
              />
            </div>
          </div>
          <div>
            <Label>Cash Account</Label>
            <Select
              value={singleForm.cashAccountId}
              onValueChange={(v) => setSingleForm((f) => ({ ...f, cashAccountId: v }))}
            >
              <SelectTrigger data-testid="select-cash-account">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              placeholder="Optional notes…"
              rows={2}
              value={singleForm.notes}
              onChange={(e) => setSingleForm((f) => ({ ...f, notes: e.target.value }))}
              data-testid="input-withdraw-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSingleOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => wrapAdminAction(() => singleMutation.mutate(), "Record Withdrawal")}
            disabled={
              singleMutation.isPending || !singleForm.employeeId || !singleForm.amount || !singleForm.cashAccountId
            }
            data-testid="button-confirm-single-withdraw"
          >
            {singleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Record Withdrawal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
