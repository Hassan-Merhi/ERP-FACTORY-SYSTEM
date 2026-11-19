// Extracted from ./ProductionBonusWeeklySheetProductionBonusMobileWorkers.tsx
import { BarChart3, CalendarDays, CalendarOff } from "lucide-react";
import { useProductionBonusWeeklySheetState } from "./ProductionBonusWeeklySheetLinkedDailyProgress";

export function ProductionBonusWeeklySheetSection3({
  rangeLabel,
  t,
  totalWorkdays,
}: Pick<ReturnType<typeof useProductionBonusWeeklySheetState>, "rangeLabel" | "t" | "totalWorkdays">) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 bg-gradient-to-r from-emerald-500/[0.07] via-card to-card px-4 py-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/15 text-emerald-600 shadow-sm dark:text-emerald-400">
          <BarChart3 className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-lg font-semibold tracking-tight">{t("sheetView")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Daily output and targets; same-category linked workers share each daily target. Bonuses remain payable
            individually.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-3 py-2 font-medium tabular-nums">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {rangeLabel}
        </span>
        <span className="rounded-lg border border-border/70 bg-background/70 px-3 py-2 tabular-nums">
          {totalWorkdays} workdays
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 font-medium text-amber-700 dark:text-amber-300">
          <CalendarOff className="h-3.5 w-3.5" aria-hidden="true" />
          Sunday excluded
        </span>
      </div>
    </header>
  );
}
