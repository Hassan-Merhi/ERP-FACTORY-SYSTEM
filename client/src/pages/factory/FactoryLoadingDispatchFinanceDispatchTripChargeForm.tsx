// Extracted from ./FactoryLoadingDispatchFinance.tsx to keep that module under the source-size cap.
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFactoryLoadingDispatchFinanceState, type Kind } from "./useFactoryLoadingDispatchFinanceState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";
import { FactoryLoadingDispatchLedgerAccountPicker } from "./FactoryLoadingDispatchLedgerAccountPicker";

export function FactoryLoadingDispatchFinanceDispatchTripChargeForm({
  busy,
  editingId,
  form,
  mainAccounts,
  offsetAccounts,
  save,
  setEditingId,
  setForm,
  setFormOpen,
  validForm,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchFinanceState>,
  | "busy"
  | "editingId"
  | "form"
  | "mainAccounts"
  | "offsetAccounts"
  | "save"
  | "setEditingId"
  | "setForm"
  | "setFormOpen"
  | "validForm"
>) {
  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (validForm && !busy) save.mutate(form);
      }}
      className="space-y-3 rounded-lg border p-3"
      data-testid="dispatch-trip-charge-form"
    >
      <p className="text-sm font-semibold">{editingId ? "Edit charge" : "Add charge"}</p>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-kind">Charge type</Label>
        <Select
          value={form.kind}
          onValueChange={(v) =>
            setForm({
              ...form,
              kind: v as Kind,
              ledgerAccountId: "",
              offsetLedgerAccountId: "",
            })
          }
        >
          <SelectTrigger id="dispatch-charge-kind" className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="BILLABLE">Customer-billable charge</SelectItem>
            <SelectItem value="INTERNAL">Internal expense (not billed)</SelectItem>
            <SelectItem value="DISCOUNT">Customer discount</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-name">Charge name</Label>
        <Input
          id="dispatch-charge-name"
          maxLength={160}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Transport, freight, handling…"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-amount">Amount (USD)</Label>
        <Input
          id="dispatch-charge-amount"
          required
          inputMode="decimal"
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-account">Ledger account</Label>
        <FactoryLoadingDispatchLedgerAccountPicker
          id="dispatch-charge-account"
          accounts={mainAccounts}
          value={form.ledgerAccountId}
          onChange={(value) => setForm({ ...form, ledgerAccountId: value })}
        />
      </div>
      {form.kind === "INTERNAL" && (
        <div className="space-y-1">
          <Label htmlFor="dispatch-charge-offset">Payable / offset account</Label>
          <FactoryLoadingDispatchLedgerAccountPicker
            id="dispatch-charge-offset"
            accounts={offsetAccounts.filter((account) => String(account.id) !== form.ledgerAccountId)}
            value={form.offsetLedgerAccountId}
            onChange={(value) => setForm({ ...form, offsetLedgerAccountId: value })}
            placeholder="Search offset account"
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-notes">Notes (optional)</Label>
        <Textarea
          id="dispatch-charge-notes"
          rows={2}
          maxLength={1000}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setFormOpen(false);
            setEditingId(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!validForm || busy}>
          {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Save charge
        </Button>
      </div>
    </form>
  );
}
