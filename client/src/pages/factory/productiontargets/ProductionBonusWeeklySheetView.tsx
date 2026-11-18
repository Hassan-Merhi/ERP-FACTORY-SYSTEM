// Extracted from ./ProductionBonusWeeklySheet.tsx to keep that module under the source-size cap.
import { BarChart3, Check, UserRound, UsersRound } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  ProductionBonusWeeklySheetSection,
  ProductionBonusWeeklySheetSection2,
  avatarStyles,
  dollars,
  legacyWeeklyHint,
  linkedDailyProgress,
  productionTeamPeriodTotals,
  useProductionBonusWeeklySheetState,
  type Props,
} from "./ProductionBonusWeeklySheetLinkedDailyProgress";
import {
  ProductionBonusWeeklySheetProductionBonusMobileWorkers,
  ProductionBonusWeeklySheetSection3,
} from "./ProductionBonusWeeklySheetProductionBonusMobileWorkers";

export function ProductionBonusWeeklySheet(props: Props) {
  const {
    arrangedWorkers,
    dates,
    dayTotals,
    displayedTotal,
    dt,
    includesWeekly,
    loading,
    manualAmounts,
    manualMode,
    manuallyPaidIds,
    onAmountChange,
    onToggle,
    rangeLabel,
    renderDayActions,
    selected,
    t,
    totalExtra,
    totalProduced,
    totalTarget,
    totalWorkdays,
    visibleWorkers,
  } = useProductionBonusWeeklySheetState(props);

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      aria-label={t("sheetView")}
      data-testid="production-bonus-daily-sheet"
    >
      <ProductionBonusWeeklySheetSection3 rangeLabel={rangeLabel} t={t} totalWorkdays={totalWorkdays} />
      <ProductionBonusWeeklySheetProductionBonusMobileWorkers
        arrangedWorkers={arrangedWorkers}
        dates={dates}
        displayedTotal={displayedTotal}
        dt={dt}
        includesWeekly={includesWeekly}
        loading={loading}
        manualAmounts={manualAmounts}
        manualMode={manualMode}
        manuallyPaidIds={manuallyPaidIds}
        onAmountChange={onAmountChange}
        onToggle={onToggle}
        renderDayActions={renderDayActions}
        selected={selected}
        t={t}
        totalExtra={totalExtra}
        totalProduced={totalProduced}
        totalTarget={totalTarget}
        visibleWorkers={visibleWorkers}
      />
      <div
        className="hidden max-h-[75vh] w-full overflow-auto overscroll-contain md:block phone-land:hidden"
        data-testid="production-daily-sheet-scroll-area"
      >
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
          <ProductionBonusWeeklySheetSection2 dates={dates} t={t} />
          <tbody>
            {loading && (
              <tr>
                <td colSpan={dates.length + 3} className="px-4 py-12 text-center text-muted-foreground">
                  {t("loading")}
                </td>
              </tr>
            )}
            {!loading && !visibleWorkers.length && (
              <tr>
                <td colSpan={dates.length + 3} className="px-4 py-12 text-center text-muted-foreground">
                  {t("noRows")}
                </td>
              </tr>
            )}
            {!loading &&
              arrangedWorkers.map(({ worker, members, first }, index) => {
                const ready = worker.readyDays > 0;
                const made = worker.days.reduce((sum, day) => sum + day.produced, 0);
                const target = worker.days.reduce((sum, day) => sum + day.target, 0);
                const achievedWeek = target > 0 && made >= target;
                const teamPeriod = productionTeamPeriodTotals(members);
                return (
                  <tr key={worker.workerId} className="group hover:bg-muted/20">
                    {first && (
                      <th
                        scope="row"
                        rowSpan={members.length}
                        className="sticky left-0 z-10 border-b border-r border-border/50 bg-card px-2 py-2 text-left align-top group-hover:bg-muted sm:px-3"
                      >
                        <div
                          className={
                            members.length > 1
                              ? "overflow-hidden rounded-xl border-2 border-violet-500/40 bg-violet-500/[0.06]"
                              : ""
                          }
                          data-linked-workers={members.length > 1 ? "true" : undefined}
                        >
                          {members.length > 1 && (
                            <div className="flex items-center gap-1.5 border-b border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
                              <UsersRound className="h-3.5 w-3.5" aria-hidden="true" />
                              Linked team · {members.length} workers
                            </div>
                          )}
                          {members.map((member, memberIndex) => {
                            const alreadyPaidManually = manualMode && manuallyPaidIds.includes(member.workerId);
                            const eligible = !alreadyPaidManually && (manualMode || member.readyDays > 0);
                            const memberState = eligible
                              ? t("ready")
                              : member.paidDays
                                ? t("paidStatus")
                                : member.weeklyProjected
                                  ? "Bonus projected"
                                  : member.weeklyApproved
                                    ? "Bonus approved"
                                    : member.weeklyDays
                                      ? "Weekly bonus"
                                      : member.needsSetup
                                        ? t("needsSetup")
                                        : member.blockedDays
                                          ? t("needsReview")
                                          : t("sheetNoExtra");
                            return (
                              <div
                                key={member.workerId}
                                className={
                                  "flex min-h-[80px] items-center gap-2 px-2 py-2 " +
                                  (memberIndex > 0 ? "border-t border-violet-500/20 " : "") +
                                  (members.length > 1 ? "sm:px-3" : "")
                                }
                              >
                                <Checkbox
                                  checked={selected.includes(member.workerId)}
                                  disabled={!eligible}
                                  aria-label={t("selectBonus") + " " + member.workerName}
                                  title={
                                    alreadyPaidManually
                                      ? "Manual bonus already paid for this week"
                                      : !eligible &&
                                          (member.weeklyProjected || member.weeklyApproved || member.weeklyDays)
                                        ? "Weekly flat bonuses are handled in the Weekly Bonus Review & Pay section below"
                                        : !eligible
                                          ? "No approved or payable daily bonus for this worker"
                                          : undefined
                                  }
                                  onCheckedChange={(checked) => onToggle(member.workerId, checked === true)}
                                />
                                <span
                                  className={
                                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full " +
                                    avatarStyles[(index + memberIndex) % avatarStyles.length]
                                  }
                                >
                                  <UserRound className="h-4 w-4" aria-hidden="true" />
                                </span>
                                <div className="min-w-0">
                                  <button
                                    type="button"
                                    dir="auto"
                                    disabled={!eligible}
                                    aria-label={"Select " + member.workerName}
                                    onClick={() => onToggle(member.workerId, !selected.includes(member.workerId))}
                                    className="block whitespace-nowrap text-left text-sm font-semibold hover:underline disabled:cursor-not-allowed disabled:no-underline"
                                  >
                                    {member.workerName}
                                  </button>
                                  {memberIndex > 0 && (
                                    <span
                                      className="block text-[10px] font-semibold text-violet-700 dark:text-violet-300"
                                      dir="auto"
                                    >
                                      Linked to {members[0].workerName}
                                    </span>
                                  )}
                                  <span
                                    className={
                                      "mt-1 inline-flex max-w-[145px] rounded-md border px-2 py-0.5 text-[10px] font-medium " +
                                      (member.weeklyDays || member.weeklyProjected || member.weeklyApproved
                                        ? "border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                                        : "border-border/70 bg-muted/70 text-muted-foreground")
                                    }
                                  >
                                    {alreadyPaidManually
                                      ? "Manual paid"
                                      : manualMode
                                        ? "Enter manual payment"
                                        : memberState}
                                  </span>
                                  {manualMode && selected.includes(member.workerId) && !alreadyPaidManually && (
                                    <label className="mt-2 flex items-center gap-1 text-xs font-medium text-foreground">
                                      <span className="shrink-0">Pay $</span>
                                      <Input
                                        type="number"
                                        min="0.01"
                                        max="1000000"
                                        step="0.01"
                                        inputMode="decimal"
                                        aria-label={"Manual bonus USD for " + member.workerName}
                                        placeholder="0.00"
                                        className="h-8 w-[100px] text-sm tabular-nums"
                                        value={manualAmounts[member.workerId] ?? ""}
                                        onChange={(event) => onAmountChange?.(member.workerId, event.target.value)}
                                      />
                                    </label>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </th>
                    )}
                    {dates.map((date) => {
                      const day = linkedDailyProgress(worker, visibleWorkers, date);
                      const memberIndices =
                        day?.linkedMemberIds.map((workerId) =>
                          arrangedWorkers.findIndex((entry) => entry.worker.workerId === workerId)
                        ) ?? [];
                      const orderedIndices = [...memberIndices].sort((left, right) => left - right);
                      // A spanning cell must not cover unrelated category rows.
                      // When members are not adjacent, show the same shared result in
                      // their own cells rather than swallowing another worker's cell.
                      const canSpan =
                        orderedIndices.length > 1 &&
                        orderedIndices.every(
                          (position, offset) => position >= 0 && position === orderedIndices[0] + offset
                        );
                      if (canSpan && index !== orderedIndices[0]) return null;
                      const span = canSpan ? orderedIndices.length : 1;
                      const achieved = Boolean(day && day.target > 0 && day.produced >= day.target);
                      const percent =
                        day && day.target > 0
                          ? Math.min(100, Math.max(0, Math.round((day.produced / day.target) * 100)))
                          : 0;
                      const memberIds = canSpan && day ? day.linkedMemberIds : [worker.workerId];
                      const issues = [
                        ...new Set(
                          memberIds.flatMap((workerId) => {
                            const member = visibleWorkers.find((entry) => entry.workerId === workerId);
                            const entry = member?.days.find((value) => value.date === date);
                            return entry?.issue && !legacyWeeklyHint(entry.issue) && entry.status !== "weekly"
                              ? [entry.issue]
                              : [];
                          })
                        ),
                      ];
                      const issue = issues.join(" · ");
                      return (
                        <td
                          key={date}
                          rowSpan={span}
                          data-testid={
                            day && day.linkedMemberIds.length > 1
                              ? `linked-daily-cell-${date}-${worker.workerId}`
                              : undefined
                          }
                          data-linked-daily-target={day && day.linkedMemberIds.length > 1 ? "true" : undefined}
                          className="border-b border-r border-border/40 p-1.5 align-middle"
                        >
                          {day ? (
                            <div
                              className={
                                "relative flex min-h-[76px] flex-col justify-center rounded-xl border px-3 py-3 transition-colors " +
                                (achieved
                                  ? "border-emerald-500/30 bg-emerald-500/15 dark:bg-emerald-800/35"
                                  : day.linkedMemberIds.length > 1
                                    ? "border-violet-500/30 bg-violet-500/[0.07] dark:bg-violet-500/[0.12]"
                                    : "border-border/60 bg-muted/30 hover:bg-muted/60")
                              }
                              style={span > 1 ? { minHeight: span * 80 - 4 } : undefined}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="whitespace-nowrap font-bold tabular-nums">
                                  <span className="text-lg">{day.produced}</span>
                                  <span className="ml-1 text-xs font-normal text-muted-foreground">/ {day.target}</span>
                                </div>
                                {achieved ? (
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm">
                                    <Check className="h-4 w-4" strokeWidth={3} aria-label="Target met" />
                                  </span>
                                ) : (
                                  <span
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-[4px]"
                                    role="img"
                                    aria-label={String(percent) + "% of daily target"}
                                    style={{ background: "conic-gradient(#34d399 " + percent + "%, #47556944 0)" }}
                                  >
                                    <span className="h-full w-full rounded-full bg-card" />
                                  </span>
                                )}
                              </div>
                              <div
                                className="mt-1 max-w-[132px] truncate text-[11px] font-medium text-muted-foreground"
                                title={day.category}
                              >
                                {day.category || "—"}
                              </div>
                              {day.linkedMemberIds.length > 1 && (
                                <div className="mt-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
                                  Shared daily target · {day.linkedMemberIds.length} workers
                                </div>
                              )}
                              {issue && (
                                <div
                                  className="mt-1 max-w-[132px] truncate text-[10px] text-amber-600 dark:text-amber-400"
                                  title={issue}
                                >
                                  {issue}
                                </div>
                              )}
                              {memberIds.map((workerId) => {
                                const action = renderDayActions?.(workerId, date);
                                if (!action) return null;
                                const memberName = visibleWorkers.find(
                                  (entry) => entry.workerId === workerId
                                )?.workerName;
                                return (
                                  <div key={workerId}>
                                    {span > 1 && (
                                      <div className="mt-1 text-[10px] text-muted-foreground" dir="auto">
                                        {memberName}
                                      </div>
                                    )}
                                    {action}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="flex min-h-[76px] items-center justify-center rounded-xl border border-dashed border-border/40 text-muted-foreground/50">
                              —
                            </div>
                          )}
                        </td>
                      );
                    })}
                    {first && (
                      <td
                        rowSpan={members.length}
                        data-testid={members.length > 1 ? `linked-period-total-${worker.workerId}` : undefined}
                        className="border-b border-r border-border/40 p-1.5 align-middle"
                      >
                        {members.length > 1 ? (
                          <div
                            className="flex h-full min-h-[76px] flex-col justify-center rounded-xl border border-violet-500/30 bg-violet-500/[0.08] px-3 py-3"
                            style={{ minHeight: members.length * 80 - 4 }}
                          >
                            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
                              <UsersRound className="h-4 w-4" aria-hidden="true" />
                              Linked team total · {members.length} workers
                            </div>
                            <strong className="block text-right text-2xl font-bold tabular-nums">
                              {teamPeriod.produced}
                            </strong>
                            <span className="block text-right text-[11px] text-muted-foreground">
                              {t("target")}: {teamPeriod.target} · +{teamPeriod.extra} {t("extra")}
                            </span>
                            <div
                              className="mt-3 h-2.5 overflow-hidden rounded-full bg-violet-500/15"
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
                        ) : (
                          <div
                            className={
                              "flex min-h-[76px] items-center gap-3 rounded-xl border px-3 py-2.5 " +
                              (achievedWeek
                                ? "border-emerald-500/30 bg-emerald-500/10"
                                : "border-border/60 bg-muted/35")
                            }
                          >
                            <span
                              className={
                                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg " +
                                (achievedWeek ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground")
                              }
                            >
                              <BarChart3 className="h-5 w-5" aria-hidden="true" />
                            </span>
                            <div className="text-right">
                              <strong className="block text-xl font-bold tabular-nums">{made}</strong>
                              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                                {t("target")}: {target} · +{worker.extra} {t("extra")}
                              </span>
                            </div>
                          </div>
                        )}
                      </td>
                    )}
                    <td className="border-b border-border/40 p-2 text-right align-middle tabular-nums">
                      <strong
                        className={
                          "block whitespace-nowrap text-base font-bold " +
                          (ready ? "text-emerald-600 dark:text-emerald-400" : "")
                        }
                      >
                        {dollars(worker.amount + worker.weeklyAmount)}
                      </strong>
                      {worker.weeklyAmount > 0 && (
                        <span className="mt-1 block text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          {worker.weeklyProjected
                            ? "Projected · finish week and approve before payment"
                            : "Weekly approved · pay in the section below"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
          {visibleWorkers.length > 0 && !loading && (
            <ProductionBonusWeeklySheetSection
              dates={dates}
              dayTotals={dayTotals}
              displayedTotal={displayedTotal}
              includesWeekly={includesWeekly}
              t={t}
              totalExtra={totalExtra}
              totalProduced={totalProduced}
              totalTarget={totalTarget}
            />
          )}
        </table>
      </div>
    </section>
  );
}
