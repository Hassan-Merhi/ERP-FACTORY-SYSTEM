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
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

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
        <Select
          value={form.kind}
          onValueChange={(v) =>
            setForm({
              ...form,
              kind: v as Kind,
              ledgerAccountId: "",
              offsetLedgerAccountId: "",
              erpChargeType: "",
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
        <Select
          value={form.ledgerAccountId || "__none__"}
          onValueChange={(v) => setForm({ ...form, ledgerAccountId: v === "__none__" ? "" : v })}
        >
          <SelectTrigger id="dispatch-charge-account" aria-required="true" className="h-9 w-full">
            <SelectValue placeholder="Select account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Select account</SelectItem>
            {mainAccounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.code} — {a.name} ({a.accountType})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          All active ledger account types are available. Billable charges credit this account, discounts debit it, and
          internal expenses debit it. Confirm the intended accounting treatment before posting.
        </p>
      </div>
      {form.kind === "INTERNAL" && (
        <div className="space-y-1">
          <Label htmlFor="dispatch-charge-offset">Payable / offset account</Label>
          <Select
            value={form.offsetLedgerAccountId || "__none__"}
            onValueChange={(v) => setForm({ ...form, offsetLedgerAccountId: v === "__none__" ? "" : v })}
          >
            <SelectTrigger id="dispatch-charge-offset" aria-required="true" className="h-9 w-full">
              <SelectValue placeholder="Select offset" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Select offset</SelectItem>
              {offsetAccounts
                .filter((a) => String(a.id) !== form.ledgerAccountId)
                .map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">Recording this expense does not imply a cash payment.</p>
        </div>
      )}
      {form.kind === "BILLABLE" && (
        <div className="space-y-1">
          <Label htmlFor="dispatch-charge-erp-type">ERP PO charge mapping (optional)</Label>
          <Select
            value={form.erpChargeType || "__none__"}
            onValueChange={(v) => setForm({ ...form, erpChargeType: (v === "__none__" ? "" : v) as ErpType })}
          >
            <SelectTrigger id="dispatch-charge-erp-type" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Not mapped to ERP PO</SelectItem>
              <SelectItem value="freight">Freight</SelectItem>
              <SelectItem value="surcharge">Surcharge</SelectItem>
              <SelectItem value="fumigation">Fumigation</SelectItem>
              <SelectItem value="documentCharges">Document charges</SelectItem>
            </SelectContent>
          </Select>
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
