import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * RecordAdvanceDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
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

export function RecordAdvanceDialog({
  addOpen,
  cashAccounts,
  createMutation,
  form,
  setAddOpen,
  setForm,
  workers,
}: {
  addOpen: AdvancesModel["addOpen"];
  cashAccounts: AdvancesModel["cashAccounts"];
  createMutation: AdvancesModel["createMutation"];
  form: AdvancesModel["form"];
  setAddOpen: AdvancesModel["setAddOpen"];
  setForm: AdvancesModel["setForm"];
  workers: AdvancesModel["workers"];
}) {
  return (
    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Advance</DialogTitle>
          <DialogDescription>Give a cash advance to a factory worker</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Worker</Label>
            <Select value={form.workerId} onValueChange={(v) => setForm({ ...form, workerId: v })}>
              <SelectTrigger data-testid="select-advance-worker">
                <SelectValue placeholder="Select worker" />
              </SelectTrigger>
              <SelectContent>
                {(workers || []).map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={form.advanceDate}
                onChange={(e) => setForm({ ...form, advanceDate: e.target.value })}
                data-testid="input-advance-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Amount ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                data-testid="input-advance-amount"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Cash Account</Label>
            <UnifiedAccountPicker
              options={(cashAccounts || []).map((account) => ({ value: String(account.id), name: account.name }))}
              value={form.cashAccountId}
              onChange={(v) => setForm({ ...form, cashAccountId: v })}
              placeholder={"Select cash account (optional)"}
              testId={"select-advance-cash-account"}
            />
          </div>
          <div className="space-y-2">
            <Label>Repayment Type</Label>
            <Select value={form.repaymentType} onValueChange={(v) => setForm({ ...form, repaymentType: v })}>
              <SelectTrigger data-testid="select-advance-repayment-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="salary_deduction">Deduct from Salary</SelectItem>
                <SelectItem value="manual_repayment">Manual Repayment (Loan)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              placeholder="Optional notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="resize-none"
              data-testid="input-advance-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddOpen(false)} data-testid="button-cancel-advance">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!form.workerId || !form.amount || parseFloat(form.amount) <= 0 || createMutation.isPending}
            data-testid="button-submit-advance"
          >
            {createMutation.isPending ? "Saving..." : "Record Advance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
