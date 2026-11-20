import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * CashAccountAdjustmentDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt } from "../utils";

export function CashAccountAdjustmentDialog({
  cashAccounts,
  cashAdjForm,
  cashAdjMutation,
  cashAdjOpen,
  setCashAdjForm,
  setCashAdjOpen,
}: {
  cashAccounts: AdvancesModel["cashAccounts"];
  cashAdjForm: AdvancesModel["cashAdjForm"];
  cashAdjMutation: AdvancesModel["cashAdjMutation"];
  cashAdjOpen: AdvancesModel["cashAdjOpen"];
  setCashAdjForm: AdvancesModel["setCashAdjForm"];
  setCashAdjOpen: AdvancesModel["setCashAdjOpen"];
}) {
  return (
    <Dialog
      open={cashAdjOpen}
      onOpenChange={(open) => {
        setCashAdjOpen(open);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cash Account Balance Adjustment</DialogTitle>
          <DialogDescription>
            Posts a correcting journal entry against the cash account without modifying any existing records.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>
              Cash Account <span className="text-destructive">*</span>
            </Label>
            <UnifiedAccountPicker
                options={(cashAccounts || []).map((account) => ({ value: String(account.id), name: account.name }))}
                value={cashAdjForm.cashAccountId}
                onChange={(v) => setCashAdjForm((p) => ({ ...p, cashAccountId: v }))}
                placeholder={"Select cash account"}
                testId={"select-cadj-account"}
              />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                Adjustment Amount <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={cashAdjForm.amount}
                onChange={(e) => setCashAdjForm((p) => ({ ...p, amount: e.target.value }))}
                data-testid="input-cadj-amount"
              />
            </div>
            <div className="space-y-2">
              <Label>Direction</Label>
              <Select
                value={cashAdjForm.direction}
                onValueChange={(v) => setCashAdjForm((p) => ({ ...p, direction: v }))}
              >
                <SelectTrigger data-testid="select-cadj-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Credit — reduce balance ↓</SelectItem>
                  <SelectItem value="debit">Debit — increase balance ↑</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              Date <span className="text-destructive">*</span>
            </Label>
            <Input
              type="date"
              value={cashAdjForm.date}
              onChange={(e) => setCashAdjForm((p) => ({ ...p, date: e.target.value }))}
              data-testid="input-cadj-date"
            />
          </div>

          <div className="space-y-2">
            <Label>Narration</Label>
            <Input
              value={cashAdjForm.narration}
              onChange={(e) => setCashAdjForm((p) => ({ ...p, narration: e.target.value }))}
              data-testid="input-cadj-narration"
            />
          </div>

          {/* Journal preview */}
          {cashAdjForm.cashAccountId &&
            cashAdjForm.amount &&
            parseFloat(cashAdjForm.amount) > 0 &&
            (() => {
              const acct = (cashAccounts || []).find((a) => String(a.id) === cashAdjForm.cashAccountId);
              const isCredit = cashAdjForm.direction === "credit";
              return (
                <div className="rounded-md border overflow-hidden text-sm">
                  <div className="grid grid-cols-3 px-3 py-1.5 bg-muted/20 text-xs font-medium text-muted-foreground">
                    <span>Account</span>
                    <span className="text-right text-blue-600 dark:text-blue-400">DR</span>
                    <span className="text-right text-amber-600 dark:text-amber-400">CR</span>
                  </div>
                  <div className="grid grid-cols-3 px-3 py-2 border-t">
                    <span className="text-muted-foreground">Advance Adjustments</span>
                    <span className="text-right font-mono text-blue-700 dark:text-blue-400">
                      {isCredit ? fmt(cashAdjForm.amount) : "—"}
                    </span>
                    <span className="text-right font-mono text-amber-700 dark:text-amber-400">
                      {isCredit ? "—" : fmt(cashAdjForm.amount)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 px-3 py-2 border-t">
                    <span className="text-muted-foreground">{acct?.name ?? "Cash Account"}</span>
                    <span className="text-right font-mono text-blue-700 dark:text-blue-400">
                      {isCredit ? "—" : fmt(cashAdjForm.amount)}
                    </span>
                    <span className="text-right font-mono text-amber-700 dark:text-amber-400">
                      {isCredit ? fmt(cashAdjForm.amount) : "—"}
                    </span>
                  </div>
                </div>
              );
            })()}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setCashAdjOpen(false)} data-testid="button-cadj-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => cashAdjMutation.mutate(cashAdjForm)}
            disabled={
              !cashAdjForm.cashAccountId ||
              !cashAdjForm.amount ||
              !cashAdjForm.date ||
              parseFloat(cashAdjForm.amount) <= 0 ||
              cashAdjMutation.isPending
            }
            data-testid="button-cadj-confirm"
          >
            {cashAdjMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Posting…
              </>
            ) : (
              `Post ${cashAdjForm.direction === "credit" ? "Credit" : "Debit"} — ${fmt(cashAdjForm.amount)}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
