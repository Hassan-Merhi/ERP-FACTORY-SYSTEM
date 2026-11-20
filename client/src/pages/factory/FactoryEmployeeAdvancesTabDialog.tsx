import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./FactoryEmployeeAdvancesTab.tsx
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
import { useFactoryEmployeeAdvancesTabState } from "./useFactoryEmployeeAdvancesTabState";

export function FactoryEmployeeAdvancesTabDialog({
  addForm,
  addMutation,
  addOpen,
  cashAccounts,
  employees,
  setAddForm,
  setAddOpen,
}: Pick<
  ReturnType<typeof useFactoryEmployeeAdvancesTabState>,
  "addForm" | "addMutation" | "addOpen" | "cashAccounts" | "employees" | "setAddForm" | "setAddOpen"
>) {
  return (
    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Employee Advance</DialogTitle>
          <DialogDescription>Record an advance paid to an employee.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Employee</Label>
            <Select value={addForm.employeeId} onValueChange={(v) => setAddForm((f) => ({ ...f, employeeId: v }))}>
              <SelectTrigger data-testid="select-add-employee">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.firstName} {e.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={addForm.advanceDate}
                onChange={(e) => setAddForm((f) => ({ ...f, advanceDate: e.target.value }))}
                data-testid="input-advance-date"
              />
            </div>
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={addForm.amount}
                onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                data-testid="input-advance-amount"
              />
            </div>
          </div>
          <div>
            <Label>Cash Account (optional)</Label>
            <UnifiedAccountPicker
              options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
              value={addForm.cashAccountId}
              onChange={(v) => setAddForm((f) => ({ ...f, cashAccountId: v }))}
              placeholder="Select account"
              testId="select-cash-account"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              placeholder="Optional notes..."
              value={addForm.notes}
              onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              data-testid="input-advance-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !addForm.employeeId || !addForm.amount}
            data-testid="button-confirm-add-advance"
          >
            {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save Advance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
