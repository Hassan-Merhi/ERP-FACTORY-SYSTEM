import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/decimal-input";
import { Label } from "@/components/ui/label";
import { money, type RetailPaymentDraft } from "./retailPosTypes";
import { paymentAccountValue, paymentFromAccount, RetailPaymentAccountOptions, type RetailPaymentAccounts } from "./RetailPaymentAccountSelect";

export function RetailPaymentPanel({
  total,
  value,
  onChange,
  canUseCredit = false,
  accounts,
  customerName,
}: {
  total: number;
  value: RetailPaymentDraft[];
  onChange: (payments: RetailPaymentDraft[]) => void;
  canUseCredit?: boolean;
  accounts?: RetailPaymentAccounts;
  customerName?: string | null;
}) {
  const formId = useId();
  const allocated = value.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const paid = value.reduce(
    (sum, payment) => (payment.method === "credit" ? sum : sum + (Number(payment.amount) || 0)),
    0
  );
  const credit = value.reduce(
    (sum, payment) => (payment.method === "credit" ? sum + (Number(payment.amount) || 0) : sum),
    0
  );
  const remaining = Math.max(0, total - allocated);
  const over = Math.max(0, allocated - total);

  const update = (index: number, patch: Partial<RetailPaymentDraft>) => {
    onChange(value.map((payment, paymentIndex) => (paymentIndex === index ? { ...payment, ...patch } : payment)));
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="retail-payment-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Payment</div>
          <div className="text-xs text-muted-foreground">
            Select a cash/bank account. Customer credit posts only to the chosen customer ledger.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={value.length >= 8 || total <= 0}
          onClick={() => {
            // Most sales start with one tender covering the *full* invoice.
            // In that case simply appending the unallocated remainder would
            // create a zero-value tender, which checkout cannot post. Split
            // the existing largest tender instead, preserving exact totals.
            const amounts = value.map((payment) => Number(payment.amount) || 0);
            const largestIndex = amounts.indexOf(Math.max(...amounts));
            const available = Number((amounts[largestIndex] ?? 0).toFixed(2));
            const allocatedAmount = Number(remaining.toFixed(2));
            if (allocatedAmount > 0) {
              onChange([...value, { method: "cash", amount: allocatedAmount, tenderedAmount: null }]);
              return;
            }
            if (available < 0.02) return;
            const splitOff = Number((available / 2).toFixed(2));
            const existingAmount = Number((available - splitOff).toFixed(2));
            if (splitOff <= 0 || existingAmount <= 0) return;
            onChange([
              ...value.map((payment, index) =>
                index === largestIndex
                  ? {
                      ...payment,
                      amount: existingAmount,
                      tenderedAmount: payment.method === "cash" ? existingAmount : null,
                    }
                  : payment
              ),
              { method: "cash", amount: splitOff, tenderedAmount: null },
            ]);
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Split
        </Button>
      </div>

      {value.map((payment, index) => {
        const amount = Number(payment.amount) || 0;
        const tendered = Number(payment.tenderedAmount ?? amount) || 0;
        const change = payment.method === "cash" ? Math.max(0, tendered - amount) : 0;
        return (
          <div key={index} className="grid gap-2 rounded-md border bg-background p-2 md:grid-cols-[minmax(190px,2fr)_1fr_1fr_auto]">
            <div>
              <Label htmlFor={`${formId}-method-${index}`} className="text-xs">
                Account
              </Label>
              <select
                id={`${formId}-method-${index}`}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={paymentAccountValue(payment)}
                onChange={(event) => {
                  const selection = event.target.value;
                  if (!accounts) return;
                  onChange(value.map((entry, paymentIndex) => paymentIndex !== index ? entry :
                    selection ? paymentFromAccount(selection, entry.amount, accounts)
                    : ({ method: "cash", amount: entry.amount, tenderedAmount: null } as RetailPaymentDraft)));
                }}
              >
                <RetailPaymentAccountOptions accounts={accounts} allowCredit={canUseCredit} customerName={customerName} />
              </select>
            </div>
            <div>
              <Label htmlFor={`${formId}-amount-${index}`} className="text-xs">
                Amount
              </Label>
              <MoneyInput
                id={`${formId}-amount-${index}`}
                className="mt-1 h-9"
                min="0"
                step="0.01"
                value={payment.amount}
                onChange={(event) => update(index, { amount: Number(event.target.value) })}
              />
            </div>
            {payment.method === "cash" ? (
              <div>
                <Label htmlFor={`${formId}-tendered-${index}`} className="text-xs">
                  Tendered
                </Label>
                <MoneyInput
                  id={`${formId}-tendered-${index}`}
                  className="mt-1 h-9"
                  min="0"
                  step="0.01"
                  value={payment.tenderedAmount ?? payment.amount}
                  onChange={(event) => update(index, { tenderedAmount: Number(event.target.value) })}
                />
                {change > 0 ? <div className="mt-1 text-xs text-muted-foreground">Change {money(change)}</div> : null}
              </div>
            ) : (
              <div>
                <Label htmlFor={`${formId}-reference-${index}`} className="text-xs">
                  Reference
                </Label>
                <Input
                  id={`${formId}-reference-${index}`}
                  className="mt-1 h-9"
                  value={payment.reference ?? ""}
                  placeholder="Optional"
                  onChange={(event) => update(index, { reference: event.target.value })}
                />
              </div>
            )}
            <div className="flex items-end">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove payment ${index + 1}`}
                disabled={value.length === 1}
                onClick={() => onChange(value.filter((_, paymentIndex) => paymentIndex !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}

      <div className="grid grid-cols-4 gap-2 border-t pt-2 text-sm" aria-label="Payment totals">
        <div>
          <div className="text-xs text-muted-foreground">Due</div>
          <div className="font-semibold">{money(total)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Collected</div>
          <div className="font-semibold">{money(paid)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">On account</div>
          <div className="font-semibold">{money(credit)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{over > 0 ? "Over" : "Remaining"}</div>
          <div className={Math.abs(allocated - total) > 0.005 ? "font-semibold text-destructive" : "font-semibold"}>
            {money(over > 0 ? over : remaining)}
          </div>
        </div>
      </div>
    </div>
  );
}
