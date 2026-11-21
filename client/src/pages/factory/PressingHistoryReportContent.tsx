// Extracted from ./PressingHistoryReport.tsx
import { Weight, TrendingUp, UsersRound } from "lucide-react";
import { approx40KgText } from "./pressing-scanner/pressingKpiFormatting";
import { countText, kgText, usePressingHistoryReportState } from "./usePressingHistoryReportState";

export function PressingHistoryReportContent({
  allWorkerBales,
  allWorkerKg,
  canSeeEveryone,
  filters,
  selectWorker,
  t,
  update,
  workers,
}: Pick<
  ReturnType<typeof usePressingHistoryReportState>,
  "allWorkerBales" | "allWorkerKg" | "canSeeEveryone" | "filters" | "selectWorker" | "t" | "update" | "workers"
>) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Pressing production KPIs">
      {workers.map((worker, index) => {
        const selected = !!worker.userId && filters.userId === worker.userId;
        const theme = [
          {
            card: "border-sky-500/35 bg-gradient-to-br from-sky-500/15 via-card to-card shadow-[0_12px_30px_-22px_hsl(var(--factory-hue)_89%_48%_/_0.5)]",
            tag: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
            icon: "text-sky-500",
          },
          {
            card: "border-violet-500/30 bg-gradient-to-br from-violet-500/15 via-card to-card shadow-[0_12px_30px_-22px_hsl(var(--factory-hue)_91%_65%_/_0.5)]",
            tag: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
            icon: "text-violet-500",
          },
          {
            card: "border-amber-500/30 bg-gradient-to-br from-amber-500/15 via-card to-card shadow-[0_12px_30px_-22px_rgba(245,158,11,0.45)]",
            tag: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
            icon: "text-amber-500",
          },
        ][index] || { card: "border-border bg-card", tag: "bg-muted text-foreground", icon: "text-muted-foreground" };
        return (
          <button
            type="button"
            key={worker.slot}
            data-testid={"pressing-kpi-" + worker.slot.toLowerCase()}
            disabled={!canSeeEveryone || !worker.userId}
            aria-pressed={selected}
            onClick={() => selectWorker(worker.userId)}
            className={
              "group min-w-0 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg " +
              theme.card +
              (selected ? " ring-2 ring-primary/60" : "") +
              (!canSeeEveryone || !worker.userId ? " cursor-default" : " cursor-pointer")
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={"min-w-0 break-words rounded-lg px-2.5 py-1 text-xs font-bold sm:text-sm " + theme.tag}
                data-testid={"pressing-kpi-display-name-" + worker.slot.toLowerCase()}
              >
                {worker.label}
              </span>
              <TrendingUp className={"h-4 w-4 " + theme.icon} />
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <strong className="text-3xl font-extrabold leading-none tracking-tight tabular-nums">
                {countText(worker.bales)}
              </strong>
              <span className="text-xs text-muted-foreground">Total items</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Weight className={"h-4 w-4 shrink-0 " + theme.icon} />
                  <strong className="text-sm tabular-nums">{kgText(worker.kg)} KG</strong>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{t("totalWeight")}</div>
              </div>
              <div
                className="min-w-0 border-l border-border/60 pl-3"
                data-testid={"pressing-kpi-approx-" + worker.slot.toLowerCase()}
              >
                <div className="flex items-center gap-1.5">
                  <TrendingUp className={"h-4 w-4 shrink-0 " + theme.icon} />
                  <strong className="text-sm tabular-nums">{approx40KgText(worker.kg)}</strong>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">Approx. (KG ÷ 40)</div>
              </div>
            </div>
          </button>
        );
      })}
      <button
        type="button"
        data-testid="pressing-kpi-all"
        aria-pressed={!filters.userId}
        onClick={() => update({ userId: undefined })}
        className={
          "group min-w-0 rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/15 via-card to-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg " +
          (!filters.userId ? "ring-1 ring-emerald-500/35" : "")
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-300">
            All pressing workers
          </span>
          <UsersRound className="h-4 w-4 text-emerald-500" />
        </div>
        <div className="mt-4 flex items-baseline gap-2">
          <strong className="text-3xl font-extrabold leading-none tracking-tight tabular-nums">
            {countText(allWorkerBales)}
          </strong>
          <span className="text-xs text-muted-foreground">Total items</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Weight className="h-4 w-4 shrink-0 text-emerald-500" />
              <strong className="text-sm tabular-nums">{kgText(allWorkerKg)} KG</strong>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{t("totalWeight")}</div>
          </div>
          <div className="min-w-0 border-l border-border/60 pl-3" data-testid="pressing-kpi-approx-all">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4 shrink-0 text-emerald-500" />
              <strong className="text-sm tabular-nums">{approx40KgText(allWorkerKg)}</strong>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">Approx. (KG ÷ 40)</div>
          </div>
        </div>
      </button>
    </div>
  );
}
