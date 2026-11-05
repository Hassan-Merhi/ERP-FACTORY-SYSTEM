import { AlertTriangle, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PricingMode = "per_bale" | "per_kg";
export type MobileProformaRow = {
  articleCode: string;
  productName: string;
  categoryName?: string;
  freeToPromise: number;
  stockAvailable: number;
  totalLoaded: number;
};

type Props = {
  rows: MobileProformaRow[];
  quantities: Record<string, string>;
  prices: Record<string, string>;
  kgPrices: Record<string, string>;
  pricingModes: Record<string, PricingMode>;
  onQuantityChange: (articleCode: string, value: string) => void;
  onPriceChange: (articleCode: string, value: string) => void;
  onKgPriceChange: (articleCode: string, value: string) => void;
  onModeChange: (articleCode: string, mode: PricingMode) => void;
  weightPerBale: (articleCode: string) => number;
  shortageCount: (row: MobileProformaRow, quantity: number) => number;
  multiplier?: number;
  errors?: Record<string, string>;
  existingCodes?: ReadonlySet<string>;
  onClear?: (articleCode: string) => void;
  variant: "create" | "edit";
};

/**
 * Phone-only presentation of the same controlled V5 proforma draft used by the
 * desktop table. All writes go through the existing parent handlers.
 *
 * The two layouts intentionally share state, but have distinct test IDs; only
 * one is visible at a time, including short landscape touch screens.
 */
export function V5ProformaMobileLines({
  rows,
  quantities,
  prices,
  kgPrices,
  pricingModes,
  onQuantityChange,
  onPriceChange,
  onKgPriceChange,
  onModeChange,
  weightPerBale,
  shortageCount,
  multiplier = 1,
  errors,
  existingCodes,
  onClear,
  variant,
}: Props) {
  return (
    <section
      className="mx-3 space-y-3 rounded-b-xl border border-t-0 bg-card p-3 md:hidden phone-land:block sm:mx-5"
      aria-label={variant === "create" ? "Create proforma item lines" : "Edit proforma item lines"}
      data-testid={variant === "create" ? "v5-create-mobile-lines" : "v5-edit-mobile-lines"}
    >
      {rows.map((row) => {
        const raw = quantities[row.articleCode] ?? "";
        const quantity = Math.max(0, Number.parseInt(raw, 10) || 0);
        const short = quantity > 0 ? shortageCount(row, quantity) : 0;
        const weight = weightPerBale(row.articleCode);
        const totalWeight = quantity > 0 && weight > 0 ? quantity * weight : 0;
        const requested = quantity * multiplier;
        const mode = pricingModes[row.articleCode] ?? "per_bale";
        const error = errors?.[`qty_${row.articleCode}`];
        const existing = existingCodes?.has(row.articleCode) && quantity > 0;
        return (
          <article
            key={row.articleCode}
            className={cn("min-w-0 rounded-xl border bg-background p-3 shadow-sm", quantity > 0 && "border-violet-500/40 bg-violet-500/[0.04]")}
            data-testid={`v5-${variant}-mobile-line-${row.articleCode}`}
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-sm font-semibold">{row.productName}</h3>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.articleCode}</p>
                {row.categoryName ? <p className="mt-1 text-xs text-muted-foreground">{row.categoryName}</p> : null}
              </div>
              {existing && onClear ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11 shrink-0 text-destructive"
                  aria-label={`Remove ${row.productName} from proforma`}
                  onClick={() => onClear(row.articleCode)}
                  data-testid={`v5-${variant}-mobile-clear-${row.articleCode}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-muted/40 p-2 text-xs">
              <div>
                <span className="block text-muted-foreground">Available balance</span>
                <strong className={cn("tabular-nums", row.freeToPromise < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
                  {row.freeToPromise > 0 ? "+" : ""}{row.freeToPromise.toLocaleString()}
                </strong>
              </div>
              <div>
                <span className="block text-muted-foreground">Total weight</span>
                <strong className="tabular-nums">{totalWeight ? `${totalWeight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg` : "—"}</strong>
              </div>
              {multiplier > 1 ? (
                <div className="col-span-2">
                  <span className="block text-muted-foreground">Expected across {multiplier} containers</span>
                  <strong className="tabular-nums">{requested.toLocaleString()} bales</strong>
                </div>
              ) : null}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3">
              <label className="block min-w-0 text-sm font-medium">
                Qty / container
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={raw}
                  onChange={(event) => onQuantityChange(row.articleCode, event.target.value)}
                  onFocus={(event) => event.target.select()}
                  aria-label={`Quantity for ${row.productName}`}
                  aria-invalid={Boolean(error)}
                  className={cn("mt-1 h-11 w-full text-base tabular-nums", (error || short > 0) && "border-amber-500")}
                  data-testid={`v5-${variant}-mobile-qty-${row.articleCode}`}
                />
              </label>
              <div className="min-w-0">
                <span className="block text-sm font-medium">Price</span>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <div className="flex shrink-0 overflow-hidden rounded-lg border" role="group" aria-label={`Price unit for ${row.productName}`}>
                    {(["per_bale", "per_kg"] as const).map((nextMode) => (
                      <button
                        key={nextMode}
                        type="button"
                        className={cn("min-h-11 px-3 text-xs font-semibold", mode === nextMode ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")}
                        aria-pressed={mode === nextMode}
                        onClick={() => onModeChange(row.articleCode, nextMode)}
                        data-testid={`v5-${variant}-mobile-mode-${nextMode}-${row.articleCode}`}
                      >
                        {nextMode === "per_kg" ? "/kg" : "/bale"}
                      </button>
                    ))}
                  </div>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={mode === "per_kg" ? "0.001" : "0.01"}
                    value={mode === "per_kg" ? kgPrices[row.articleCode] ?? "" : prices[row.articleCode] ?? ""}
                    onChange={(event) => mode === "per_kg"
                      ? onKgPriceChange(row.articleCode, event.target.value)
                      : onPriceChange(row.articleCode, event.target.value)}
                    onFocus={(event) => event.target.select()}
                    aria-label={`${mode === "per_kg" ? "Per-kg" : "Per-bale"} price for ${row.productName}`}
                    className="h-11 min-w-0 flex-1 text-base tabular-nums"
                    data-testid={`v5-${variant}-mobile-price-${row.articleCode}`}
                  />
                </div>
              </div>
            </div>
            {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
            {short > 0 ? (
              <p className="mt-2 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {variant === "create" ? `Short ${short.toLocaleString()} bales` : "Low stock"}
              </p>
            ) : null}
          </article>
        );
      })}
      {!rows.length ? <p className="p-6 text-center text-sm text-muted-foreground">No items match these filters.</p> : null}
    </section>
  );
}
