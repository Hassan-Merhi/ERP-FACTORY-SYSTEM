// Extracted from ./ProductionBonusWeeklySheet.tsx to keep that module under the source-size cap.
import { BarChart3, CalendarDays, CalendarOff, UserRound, UsersRound } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  avatarStyles,
  dayLabel,
  dollars,
  legacyWeeklyHint,
  linkedDailyProgress,
  productionTeamPeriodTotals,
  useProductionBonusWeeklySheetState,
} from "./ProductionBonusWeeklySheetLinkedDailyProgress";

export function ProductionBonusWeeklySheetProductionBonusMobileWorkers({
  arrangedWorkers,
  dates,
  displayedTotal,
  dt,
  includesWeekly,
  loading,
  manualAmounts,
  manualMode,
  manuallyPaidIds,
  onAmountChange,
  onToggle,
  renderDayActions,
  selected,
  t,
  totalExtra,
  totalProduced,
  totalTarget,
  visibleWorkers,
}: Pick<
  ReturnType<typeof useProductionBonusWeeklySheetState>,
  | "arrangedWorkers"
  | "dates"
  | "displayedTotal"
  | "dt"
  | "includesWeekly"
  | "loading"
  | "manualAmounts"
  | "manualMode"
  | "manuallyPaidIds"
  | "onAmountChange"
  | "onToggle"
  | "renderDayActions"
  | "selected"
  | "t"
  | "totalExtra"
  | "totalProduced"
  | "totalTarget"
  | "visibleWorkers"
>) {
  return (
    <div className="space-y-3 p-3 md:hidden phone-land:block" data-testid="production-bonus-mobile-workers">
      {loading ? (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t("loading")}</p>
      ) : null}
      {!loading && !arrangedWorkers.length ? (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t("noRows")}</p>
      ) : null}
      {!loading &&
        arrangedWorkers.map(({ worker, members, first }, index) => {
          const paidManually = manualMode && manuallyPaidIds.includes(worker.workerId);
          const eligible = !paidManually && (manualMode || worker.readyDays > 0);
          const made = worker.days.reduce((total, day) => total + day.produced, 0);
          const target = worker.days.reduce((total, day) => total + day.target, 0);
          const achieved = target > 0 && made >= target;
          const teamLead = members[0];
          const teamPeriod = productionTeamPeriodTotals(members);
          return (
            <article
              key={worker.workerId}
              className={
                "min-w-0 rounded-xl border bg-card p-3 shadow-sm " + (members.length > 1 ? "border-violet-500/40" : "")
              }
              data-testid={`bonus-mobile-worker-${worker.workerId}`}
            >
              {members.length > 1 && (
                <div
                  className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-300"
                  data-linked-workers="true"
                >
                  <UsersRound className="h-4 w-4" aria-hidden="true" />
                  {worker.workerId === teamLead.workerId
                    ? `${dt("linkedTeam")} · ${members.length} ${t("worker")}`
                    : `${dt("linkedTo")} ${teamLead.workerName}`}
                </div>
              )}
              {first && members.length > 1 && (
                <div
                  className="mb-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.07] p-3"
                  data-testid={`linked-mobile-period-total-${worker.workerId}`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
                    <span>Linked team period total</span>
                    <span>{members.length} workers</span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2 tabular-nums">
                    <strong className="text-xl">{teamPeriod.produced}</strong>
                    <span className="text-xs text-muted-foreground">
                      Target: {teamPeriod.target} · +{teamPeriod.extra} extra
                    </span>
                  </div>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full bg-violet-500/15"
                    role="progressbar"
                    aria-label="Linked team period target progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={teamPeriod.percent}
                  >
                    <div
                      className="h-full rounded-full bg-violet-500 transition-all"
                      style={{ width: `${teamPeriod.percent}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="flex min-w-0 items-start gap-3">
                <Checkbox
                  checked={selected.includes(worker.workerId)}
                  disabled={!eligible}
                  aria-label={t("selectBonus") + " " + worker.workerName}
                  onCheckedChange={(checked) => onToggle(worker.workerId, checked === true)}
                />
                <span
                  className={
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full " +
                    avatarStyles[index % avatarStyles.length]
                  }
                >
                  <UserRound className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    disabled={!eligible}
                    onClick={() => onToggle(worker.workerId, !selected.includes(worker.workerId))}
                    aria-label={t("select") + " " + worker.workerName}
                    className="break-words text-left text-sm font-semibold disabled:cursor-not-allowed"
                  >
                    {worker.workerName}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {paidManually
                      ? dt("manualPaid")
                      : manualMode
                        ? dt("manualPayment")
                        : worker.paidDays
                          ? t("paidStatus")
                          : worker.readyDays
                            ? t("ready")
                            : worker.weeklyProjected
                              ? dt("bonusProjected")
                              : worker.weeklyApproved
                                ? dt("bonusApproved")
                                : worker.needsSetup
                                  ? t("needsSetup")
                                  : t("sheetNoExtra")}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-muted/30 p-2 text-center text-xs tabular-nums">
                <div>
                  <span className="block text-muted-foreground">{dt("produced")}</span>
                  <strong className="text-base">{made}</strong>
                </div>
                <div>
                  <span className="block text-muted-foreground">{t("target")}</span>
                  <strong className="text-base">{target}</strong>
                </div>
                <div>
                  <span className="block text-muted-foreground">{t("extra")}</span>
                  <strong className={worker.extra > 0 ? "text-emerald-600" : ""}>{worker.extra}</strong>
                </div>
              </div>
              <p
                className={
                  "mt-2 text-sm font-semibold tabular-nums " +
                  (achieved ? "text-emerald-600 dark:text-emerald-400" : "")
                }
              >
                {t("bonus")}: {dollars(worker.amount + worker.weeklyAmount)}
              </p>
              {worker.weeklyAmount > 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {dt(worker.weeklyProjected ? "projectedPayHint" : "weeklyApprovedPay")}
                </p>
              )}
              {manualMode && selected.includes(worker.workerId) && !paidManually && (
                <label className="mt-3 block text-sm font-medium">
                  {dt("manualBonusUsd")}
                  <Input
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    inputMode="decimal"
                    value={manualAmounts[worker.workerId] ?? ""}
                    onChange={(event) => onAmountChange?.(worker.workerId, event.target.value)}
                    aria-label={dt("manualBonusUsd") + ": " + worker.workerName}
                    className="mt-1 h-11 w-full text-base tabular-nums"
                    data-testid={`bonus-mobile-amount-${worker.workerId}`}
                  />
                </label>
              )}
              <details className="mt-3 rounded-lg border bg-muted/20">
                <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
                  {dt("dailyProduction")} · {dates.length} {dt("workdays")}
                </summary>
                <div className="space-y-2 border-t p-2">
                  {dates.map((date) => {
                    const day = linkedDailyProgress(worker, visibleWorkers, date);
                    const met = Boolean(day && day.target > 0 && day.produced >= day.target);
                    return (
                      <div key={date} className="rounded-lg border bg-background p-2 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium">{dayLabel(date)}</span>
                          <strong className={met ? "text-emerald-600 dark:text-emerald-400" : ""}>
                            {day ? `${day.produced} / ${day.target}` : "—"}
                            {met ? " ✓" : ""}
                          </strong>
                        </div>
                        {day?.category ? (
                          <p className="mt-1 break-words text-muted-foreground">{day.category}</p>
                        ) : null}
                        {day && day.linkedMemberIds.length > 1 && (
                          <p className="mt-1 text-[11px] font-semibold text-violet-600 dark:text-violet-300">
                            Shared daily target · {day.linkedMemberIds.length} workers
                          </p>
                        )}
                        {day?.issue && !legacyWeeklyHint(day.issue) && day.status !== "weekly" ? (
                          <p className="mt-1 break-words text-amber-600 dark:text-amber-400">{day.issue}</p>
                        ) : null}
                        {day ? renderDayActions?.(worker.workerId, date) : null}
                      </div>
                    );
                  })}
                </div>
              </details>
            </article>
          );
        })}
      {!loading && visibleWorkers.length > 0 && (
        <div className="rounded-xl border bg-muted/40 p-3 text-sm" data-testid="bonus-mobile-summary">
          <div className="flex justify-between">
            <span>{t("sheetTotal")}</span>
            <strong>
              {totalProduced} / {totalTarget}
            </strong>
          </div>
          <div className="mt-2 flex justify-between">
            <span>{t("extra")}</span>
            <strong>{totalExtra}</strong>
          </div>
          <div className="mt-2 flex justify-between font-semibold">
            <span>{t("bonus")}</span>
            <strong>{dollars(displayedTotal)}</strong>
          </div>
          {includesWeekly && <p className="mt-2 text-xs text-muted-foreground">{dt("weeklyEstimateHint")}</p>}
        </div>
      )}
    </div>
  );
}

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
