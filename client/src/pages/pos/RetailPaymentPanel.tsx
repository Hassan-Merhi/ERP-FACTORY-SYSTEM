import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, type RetailPaymentDraft, type RetailPaymentMethod } from "./retailPosTypes";

const METHODS: Array<{ value: RetailPaymentMethod; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "bank", label: "Bank / Transfer" },
  { value: "mobile", label: "Mobile" },
  { value: "other", label: "Other" },
];

export function RetailPaymentPanel({
  total,
  value,
  onChange,
}: {
  total: number;
  value: RetailPaymentDraft[];
  onChange: (payments: RetailPaymentDraft[]) => void;
}) {
  const paid = value.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const remaining = Math.max(0, total - paid);
  const over = Math.max(0, paid - total);

  const update = (index: number, patch: Partial<RetailPaymentDraft>) => {
    onChange(value.map((payment, paymentIndex) => (paymentIndex === index ? { ...payment, ...patch } : payment)));
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="retail-payment-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Payment</div>
          <div className="text-xs text-muted-foreground">Cash, card, bank, mobile, other or split payment.</div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={value.length >= 8}
          onClick={() =>
            onChange([
              ...value,
              {
                method: "cash",
                amount: Number(remaining.toFixed(2)),
                tenderedAmount: remaining > 0 ? Number(remaining.toFixed(2)) : null,
              },
            ])
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Split
        </Button>
      </div>

      {value.map((payment, index) => {
        const amount = Number(payment.amount) || 0;
        const tendered = Number(payment.tenderedAmount ?? amount) || 0;
        const change = payment.method === "cash" ? Math.max(0, tendered - amount) : 0;
        return (
          <div key={index} className="grid gap-2 rounded-md border bg-background p-2 md:grid-cols-[140px_1fr_1fr_auto]">
            <div>
              <Label className="text-xs">Method</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={payment.method}
                onChange={(event) => {
                  const method = event.target.value as RetailPaymentMethod;
                  update(index, {
                    method,
                    tenderedAmount: method === "cash" ? (payment.tenderedAmount ?? payment.amount) : null,
                  });
                }}
              >
                {METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Amount</Label>
              <Input
                className="mt-1 h-9"
                type="number"
                min="0"
                step="0.01"
                value={payment.amount}
                onChange={(event) => update(index, { amount: Number(event.target.value) })}
              />
            </div>
            {payment.method === "cash" ? (
              <div>
                <Label className="text-xs">Tendered</Label>
                <Input
                  className="mt-1 h-9"
                  type="number"
                  min="0"
                  step="0.01"
                  value={payment.tenderedAmount ?? payment.amount}
                  onChange={(event) => update(index, { tenderedAmount: Number(event.target.value) })}
                />
                {change > 0 ? <div className="mt-1 text-xs text-muted-foreground">Change {money(change)}</div> : null}
              </div>
            ) : (
              <div>
                <Label className="text-xs">Reference</Label>
                <Input
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
                aria-label="Remove payment"
                disabled={value.length === 1}
                onClick={() => onChange(value.filter((_, paymentIndex) => paymentIndex !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}

      <div className="grid grid-cols-3 gap-2 border-t pt-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Due</div>
          <div className="font-semibold">{money(total)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Paid</div>
          <div className="font-semibold">{money(paid)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{over > 0 ? "Over" : "Remaining"}</div>
          <div className={Math.abs(paid - total) > 0.005 ? "font-semibold text-destructive" : "font-semibold"}>
            {money(over > 0 ? over : remaining)}
          </div>
        </div>
      </div>
    </div>
  );
}
