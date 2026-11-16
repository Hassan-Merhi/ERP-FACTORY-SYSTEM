// Extracted from ./FactoryLoadingDispatchFinance.tsx to keep that module under the source-size cap.
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useFactoryLoadingDispatchFinanceState,
  type ErpType,
  type Kind,
} from "./useFactoryLoadingDispatchFinanceState";

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
      className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/30 p-3 dark:border-blue-900 dark:bg-blue-950/20"
      data-testid="dispatch-trip-charge-form"
    >
      <p className="text-sm font-semibold">{editingId ? "Edit draft charge" : "New trip charge"}</p>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-kind">Type</Label>
        <select
          id="dispatch-charge-kind"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={form.kind}
          onChange={(e) =>
            setForm({
              ...form,
              kind: e.target.value as Kind,
              ledgerAccountId: "",
              offsetLedgerAccountId: "",
              erpChargeType: "",
            })
          }
        >
          <option value="BILLABLE">Customer-billable charge</option>
          <option value="INTERNAL">Internal expense (not billed)</option>
          <option value="DISCOUNT">Customer discount</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="dispatch-charge-name">Name</Label>
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
        <select
          id="dispatch-charge-account"
          required
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={form.ledgerAccountId}
          onChange={(e) => setForm({ ...form, ledgerAccountId: e.target.value })}
        >
          <option value="">Select account</option>
          {mainAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name} ({a.accountType})
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          All active ledger account types are available. Billable charges credit this account, discounts debit it, and
          internal expenses debit it. Confirm the intended accounting treatment before posting.
        </p>
      </div>
      {form.kind === "INTERNAL" && (
        <div className="space-y-1">
          <Label htmlFor="dispatch-charge-offset">Payable / offset account</Label>
          <select
            id="dispatch-charge-offset"
            required
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={form.offsetLedgerAccountId}
            onChange={(e) => setForm({ ...form, offsetLedgerAccountId: e.target.value })}
          >
            <option value="">Select offset</option>
            {offsetAccounts
              .filter((a) => String(a.id) !== form.ledgerAccountId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
          </select>
          <p className="text-[11px] text-muted-foreground">Recording this expense does not imply a cash payment.</p>
        </div>
      )}
      {form.kind === "BILLABLE" && (
        <div className="space-y-1">
          <Label htmlFor="dispatch-charge-erp-type">ERP PO charge mapping (optional)</Label>
          <select
            id="dispatch-charge-erp-type"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={form.erpChargeType}
            onChange={(e) => setForm({ ...form, erpChargeType: e.target.value as ErpType })}
          >
            <option value="">Not mapped to ERP PO</option>
            <option value="freight">Freight</option>
            <option value="surcharge">Surcharge</option>
            <option value="fumigation">Fumigation</option>
            <option value="documentCharges">Document charges</option>
          </select>
          <p className="text-[11px] text-muted-foreground">
            Unmapped charges will require explicit review before PO export in Phase 5.
          </p>
        </div>
      )}
      {form.kind === "DISCOUNT" && (
        <p className="text-[11px] text-muted-foreground">
          Discounts are tracked separately and will map to the ERP PO Discount column.
        </p>
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
          Save draft charge
        </Button>
      </div>
    </form>
  );
}
