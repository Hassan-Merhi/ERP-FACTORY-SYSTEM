import { CalendarDays, Package, Scale } from "lucide-react";
import type { ProductRow } from "../types";
import { fmtKg, fmtNum } from "../utils";
import { cn } from "@/lib/utils";

interface PeriodOverviewCardProps {
  label: string;
  range: string;
  bales: number;
  kilograms: number;
  products: ProductRow[];
  tone: "blue" | "violet";
}

/**
 * Miniature bars represent actual product bale quantities within the selected
 * period, NOT a fabricated daily history or forecast.
 */
export function PeriodOverviewCard({ label, range, bales, kilograms, products, tone }: PeriodOverviewCardProps) {
  const topProducts = products
    .filter((p) => p.qty > 0)
    .slice()
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 15)
    .reverse();
  const max = Math.max(...topProducts.map((p) => p.qty), 1);
  const blue = tone === "blue";

  return (
    <article
      className={cn(
        "relative isolate min-w-0 overflow-hidden rounded-2xl border p-4 shadow-sm sm:p-5",
        blue
          ? "border-blue-500/25 bg-gradient-to-br from-blue-50 via-sky-50/60 to-blue-100/50 dark:from-[#10253d] dark:via-[#102039] dark:to-[#0e2d51]"
          : "border-violet-500/25 bg-gradient-to-br from-violet-50 via-purple-50/50 to-violet-100/60 dark:from-[#231b3e] dark:via-[#1e1b34] dark:to-[#2b1a48]"
      )}
    >
      <div className={cn("pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full blur-3xl", blue ? "bg-blue-400/15" : "bg-violet-400/15")} />
      <div className="relative flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", blue ? "bg-blue-500/15 text-blue-600 dark:text-blue-300" : "bg-violet-500/15 text-violet-600 dark:text-violet-300")}>
              <CalendarDays className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-100">{label}</h3>
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={range}>{range}</p>
            </div>
          </div>
          <p className="mt-5 text-3xl font-extrabold tracking-tight tabular-nums text-slate-900 dark:text-white sm:text-4xl">
            {fmtNum(bales)} <span className="text-xl font-semibold sm:text-2xl">bales</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className="inline-flex items-center gap-1.5"><Scale className="h-3.5 w-3.5 opacity-60" />{fmtKg(kilograms)} kg</span>
          </div>
        </div>
        <div className="hidden w-36 shrink-0 self-end sm:block lg:w-44" aria-label={"Top products by bale quantity for " + label}>
          {topProducts.length ? (
            <>
              <div className="flex h-24 items-end justify-end gap-[3px]">
                {topProducts.map((product, index) => (
                  <div
                    key={product.articleCode + "-" + index}
                    title={(product.productName || product.articleCode) + ": " + fmtNum(product.qty) + " bales"}
                    className={cn(
                      "min-w-0 flex-1 rounded-t-[3px] shadow-[0_0_12px_rgba(59,130,246,0.1)]",
                      blue ? "bg-gradient-to-t from-blue-700 to-sky-400" : "bg-gradient-to-t from-violet-700 to-fuchsia-400"
                    )}
                    style={{ height: Math.max(8, (product.qty / max) * 100) + "%" }}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-right text-[10px] text-muted-foreground">Top products by bales</p>
            </>
          ) : (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <Package className="h-6 w-6 opacity-40" />No product data
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
