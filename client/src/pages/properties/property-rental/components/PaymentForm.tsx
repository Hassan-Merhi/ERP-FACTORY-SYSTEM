import type { ClientErrorLike } from "@/lib/clientError";
/**
 * PaymentForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import type { CashAccount, Contract, LedgerRow } from "../types";
import { CURRENCIES, MONTH_NAMES, buildPaymentAllocations, fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";
import { AccountSearchSelect } from "./AccountSearchSelect";

export function PaymentForm({
  contract,
  cashAccounts,
  testIdPrefix,
  unitId,
  ledger,
}: {
  contract: Contract;
  cashAccounts: CashAccount[];
  testIdPrefix: string;
  unitId: number;
  ledger?: LedgerRow[];
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [form, setForm] = useState({
    cashAccountId: "" as string,
    amount: "",
    paymentDate: new Date().toISOString().slice(0, 10),
    notes: "",
    currency: contract.currency || "USD",
    exchangeRate: "1",
  });
  const [scheduleFuturePayment, setScheduleFuturePayment] = useState(false);

  const pay = useMutation({
    mutationFn: () =>
      apiRequest("POST", apiBase + "/payments", {
        contractId: contract.id,
        cashAccountId: form.cashAccountId ? parseInt(form.cashAccountId) : null,
        amount: form.amount,
        paymentDate: form.paymentDate,
        notes: form.notes,
        currency: form.currency,
        exchangeRate: form.exchangeRate,
        scheduleFuturePayment,
      }),
    onSuccess: async (res) => {
      const data = (await res.json()) as { scheduled?: boolean };
      if (data?.scheduled) {
        toast({
          title: "Payment scheduled",
          description: `${parseFloat(form.amount).toFixed(2)} scheduled for ${form.paymentDate}. It will be posted automatically on that date.`,
        });
      } else {
        toast({ title: "Payment recorded" });
      }
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unitId, "detail"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/payments/scheduled"] });
      setForm((f) => ({ ...f, amount: "", notes: "" }));
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const allocations = useMemo(() => {
    const total = parseFloat(form.amount);
    const monthly = parseFloat(contract.rentalAmount);
    if (!total || !monthly || total <= 0) return [];
    return buildPaymentAllocations(total, monthly, form.paymentDate, ledger, contract.startDate);
  }, [form.amount, form.paymentDate, contract.rentalAmount, contract.startDate, ledger]);

  const isMultiMonth = allocations.length > 1;

  return (
    <div className="space-y-3 pt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Account</Label>
          <AccountSearchSelect
            accounts={cashAccounts}
            value={form.cashAccountId}
            onChange={(v) => setForm((f) => ({ ...f, cashAccountId: v }))}
            placeholder="Choose account…"
            testId={`select-${testIdPrefix}-cash-box`}
          />
        </div>
        <div>
          <Label>Payment Date</Label>
          <Input
            type="date"
            value={form.paymentDate}
            onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))}
            data-testid={`input-${testIdPrefix}-payment-date`}
          />
        </div>
        <div>
          <Label>Currency</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={form.currency}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                currency: e.target.value,
                exchangeRate: e.target.value === "USD" ? "1" : f.exchangeRate,
              }))
            }
            data-testid={`select-${testIdPrefix}-payment-currency`}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Amount Received ({form.currency})</Label>
          <Input
            type="number"
            step={form.currency === "CFA" ? "1" : "0.01"}
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            data-testid={`input-${testIdPrefix}-payment-amount`}
          />
        </div>
        {form.currency !== "USD" && (
          <div>
            <Label>Exchange Rate (1 USD = ? {form.currency})</Label>
            <Input
              type="number"
              step="0.000001"
              min="0"
              value={form.exchangeRate}
              onChange={(e) => setForm((f) => ({ ...f, exchangeRate: e.target.value }))}
              data-testid={`input-${testIdPrefix}-exchange-rate`}
            />
          </div>
        )}
        <div className="col-span-2">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            data-testid={`input-${testIdPrefix}-payment-notes`}
          />
        </div>
        {form.paymentDate > new Date().toISOString().slice(0, 10) && (
          <div className="col-span-2 flex items-center gap-3">
            <Switch
              id={`${testIdPrefix}-schedule-future`}
              checked={scheduleFuturePayment}
              onCheckedChange={setScheduleFuturePayment}
              data-testid={`switch-${testIdPrefix}-schedule-future`}
            />
            <label htmlFor={`${testIdPrefix}-schedule-future`} className="text-sm cursor-pointer select-none">
              Schedule future payment{" "}
              <span className="text-muted-foreground text-xs">(hold as SCHEDULED until {form.paymentDate})</span>
            </label>
          </div>
        )}
      </div>

      {isMultiMonth && (
        <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300">
            Payment will be split across {allocations.length} months
          </p>
          <div className="space-y-1">
            {allocations.map((a, i) => (
              <div key={i} className="flex items-center justify-between text-xs text-blue-800 dark:text-blue-200">
                <span>
                  {MONTH_NAMES[a.month]} {a.year}
                </span>
                <span className="font-medium">{fmtMoneyCurrency(a.chunk, form.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!form.cashAccountId && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Select a cash/bank account so this payment is posted to the Daybook.
        </p>
      )}
      <DialogFooter>
        <Button
          onClick={() => pay.mutate()}
          disabled={!form.amount || !form.cashAccountId || pay.isPending}
          data-testid={`button-${testIdPrefix}-confirm-payment`}
        >
          {pay.isPending ? "Recording…" : "Confirm Payment"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TAB 2: MODIFY RENT
// ──────────────────────────────────────────────────────────
