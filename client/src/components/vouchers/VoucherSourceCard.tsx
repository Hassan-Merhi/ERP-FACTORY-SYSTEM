import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

export interface VoucherSourceCardProps {
  /** "Pay From" on a payment voucher, "Receive Into" on a receipt. */
  label: string;
  accountName: string;
  /** Tab accent — amber for payments, emerald for receipts. */
  accentColor: string;
  /** Current balance of the source account. */
  balance: number;
  /** Balance once this voucher is saved. */
  projected: number;
  /** Voucher total, used to decide whether the projection is worth showing. */
  total: number;
  /** How much of the account this voucher consumes, 0–100. */
  meterPct: number;
  /** Per-currency balances, when the account holds more than one. */
  currencyBalances?: { currency: string; balance: number }[] | null;
  onChange: () => void;
}

/**
 * The chosen source account, shown in place of the picker once one is selected.
 * Purely presentational — every figure is handed in by the voucher form.
 */
export function VoucherSourceCard({
  label,
  accountName,
  accentColor,
  balance,
  projected,
  total,
  meterPct,
  currencyBalances,
  onChange,
}: VoucherSourceCardProps) {
  const { formatAmount } = useCurrencyContext();

  const balColor = (v: number) =>
    v < 0
      ? "text-red-600 dark:text-red-400"
      : v > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground";

  const fmtCurr = (n: number, curr: string) =>
    curr !== "USD"
      ? `${curr} ${Math.abs(n).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : formatAmount(Math.abs(n));

  // "Access Cash" → "AC"
  const initials = accountName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className="flex items-center gap-3 rounded-lg border bg-muted/20 px-4 py-3 min-w-0"
      style={{ borderLeftColor: accentColor, borderLeftWidth: "3px" }}
      data-testid="card-selected-source"
    >
      <div
        className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold"
        style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
        aria-hidden="true"
      >
        {initials}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold truncate mt-0.5">{accountName}</div>

        {/* How much of the account this voucher consumes */}
        {total > 0 && (
          <div className="h-1 rounded-full bg-muted mt-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${meterPct}%`, backgroundColor: accentColor }}
            />
          </div>
        )}

        {currencyBalances && currencyBalances.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
            {currencyBalances.map(({ currency, balance: bal }) => (
              <span key={currency} className="text-xs font-mono tabular-nums">
                <span className="text-muted-foreground">Bal </span>
                <span className={cn(balColor(bal))}>
                  {fmtCurr(bal, currency)} {bal > 0 ? "CR" : bal < 0 ? "DR" : ""}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap text-xs mt-1.5 font-mono tabular-nums">
            <span className="text-muted-foreground">Bal</span>
            <span className={cn(balColor(balance))}>{formatAmount(balance)}</span>
            {total > 0 && (
              <>
                <span className="text-muted-foreground">→</span>
                <span className={cn("font-semibold", balColor(projected))}>{formatAmount(projected)}</span>
                <span className="text-muted-foreground">after</span>
              </>
            )}
          </div>
        )}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        onClick={onChange}
        data-testid="button-change-source"
      >
        Change
      </Button>
    </div>
  );
}
