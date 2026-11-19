// Extracted from ./FactoryMonthlyProductionMatrix.tsx
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { Button } from "@/components/ui/button";
import { ListOrdered } from "lucide-react";
import { useFactoryMonthlyProductionMatrixState } from "./useFactoryMonthlyProductionMatrixState";

export function FactoryMonthlyProductionMatrixContent({
  byId,
  canReorder,
  language,
  mhd,
  monthLabel,
  months,
  openMoveDialog,
  openWorkerBreakdown,
  overallTotal,
  rowTotal,
  saving,
  t,
  visibleProducts,
}: Pick<
  ReturnType<typeof useFactoryMonthlyProductionMatrixState>,
  | "byId"
  | "canReorder"
  | "language"
  | "mhd"
  | "monthLabel"
  | "months"
  | "openMoveDialog"
  | "openWorkerBreakdown"
  | "overallTotal"
  | "rowTotal"
  | "saving"
  | "t"
  | "visibleProducts"
>) {
  return (
    <section
      className="space-y-3 md:hidden phone-land:block"
      aria-label={t("monthlyProduction.title")}
      data-testid="monthly-matrix-mobile"
    >
      <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-3 py-2 text-sm">
        <span>
          {visibleProducts.length} {t("monthlyProduction.items")}
        </span>
        <strong className="tabular-nums">
          {overallTotal.toLocaleString()} {t("monthlyProduction.baleUnits")}
        </strong>
      </div>
      {visibleProducts.map((product) => {
        const values = months.map((month) => byId(product.id, month));
        const min = Math.min(...values);
        const max = Math.max(...values);
        const hasRange = values.length > 1 && min !== max;
        const total = rowTotal(product.id);
        return (
          <article
            key={product.id}
            className="min-w-0 rounded-xl border bg-card p-3 shadow-sm"
            data-testid={`monthly-matrix-mobile-item-${product.id}`}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-sm font-semibold">{mhd.nameFor(product.articleCode, product.name)}</h2>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {product.articleCode} · {product.categoryName}
                </p>
              </div>
              <button
                type="button"
                disabled={total <= 0}
                onClick={() => openWorkerBreakdown(product.id, months)}
                aria-label={`${duoMobileText("workerBales", language)}: ${mhd.nameFor(product.articleCode, product.name)} · ${total} ${duoMobileText("bales", language)}`}
                className="min-h-11 shrink-0 rounded-lg bg-primary/10 px-3 text-right font-bold text-primary tabular-nums disabled:opacity-50"
                data-testid={`monthly-matrix-mobile-total-${product.id}`}
              >
                {total.toLocaleString()}
                <span className="block text-[10px] font-normal">{t("monthlyProduction.baleUnits")}</span>
              </button>
            </div>
            <details className="mt-3 rounded-lg border bg-muted/20">
              <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
                {t("monthlyProduction.months")} · {months.length}
              </summary>
              <div className="grid grid-cols-2 gap-2 border-t p-2">
                {months.map((month, i) => {
                  const value = values[i];
                  const accent =
                    hasRange && value === max
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : hasRange && value === min
                        ? "bg-red-500/10 text-red-700 dark:text-red-300"
                        : "bg-background";
                  return (
                    <button
                      key={month}
                      type="button"
                      disabled={value <= 0}
                      onClick={() => openWorkerBreakdown(product.id, [month])}
                      aria-label={`${duoMobileText("workerBales", language)}: ${mhd.nameFor(product.articleCode, product.name)} · ${monthLabel(month)} · ${value} ${duoMobileText("bales", language)}`}
                      className={`min-h-11 rounded-lg border p-2 text-left disabled:opacity-60 ${accent}`}
                      data-testid={`monthly-matrix-mobile-month-${product.id}-${month}`}
                    >
                      <span className="block text-xs">{monthLabel(month)}</span>
                      <strong className="text-lg tabular-nums">{value.toLocaleString()}</strong>
                    </button>
                  );
                })}
              </div>
            </details>
            {canReorder && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 min-h-11 w-full"
                disabled={saving}
                onClick={() => openMoveDialog(product.id)}
                data-testid={`monthly-matrix-mobile-move-${product.id}`}
              >
                <ListOrdered className="mr-2 h-4 w-4" /> {t("monthlyProduction.moveTo")}
              </Button>
            )}
          </article>
        );
      })}
      {!visibleProducts.length && (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          {t("monthlyProduction.noMatching")}
        </p>
      )}
    </section>
  );
}
