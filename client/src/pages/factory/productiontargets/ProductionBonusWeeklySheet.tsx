import { useMemo, type ReactNode } from "react";
import { BarChart3, CalendarDays, Check, CalendarOff, UserRound, UsersRound } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { isProductionWorkday } from "@shared/productionTargetBonusWeeklyMethod";

/** Display only: calculated amounts/eligibility come from the checkout API. */
export type BonusSheetDay = {
  date: string;
  target: number;
  produced: number;
  extra: number;
  category: string;
  issue: string | null;
  status: string;
  linkGroupId: number | null;
};
export type BonusSheetWorker = {
  workerId: number;
  workerName: string;
  days: BonusSheetDay[];
  target: number;
  produced: number;
  extra: number;
  amount: number;
  weeklyAmount: number;
  weeklyProjected: boolean;
  weeklyApproved: boolean;
  readyDays: number;
  paidDays: number;
  needsSetup: number;
  blockedDays: number;
  weeklyDays: number;
};
type Props = {
  from: string;
  to: string;
  workers: BonusSheetWorker[];
  selected: number[];
  onToggle: (workerId: number, checked: boolean) => void;
  manualMode?: boolean;
  manualAmounts?: Record<number, string>;
  onAmountChange?: (workerId: number, amount: string) => void;
  manuallyPaidIds?: number[];
  renderDayActions?: (workerId: number, date: string) => ReactNode;
  loading: boolean;
};

const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
export function productionSheetWorkdays(from: string, to: string): string[] {
  if (!validDate(from) || !validDate(to) || from > to) return [];
  const first = new Date(from + "T12:00:00Z");
  const length = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (length < 1 || length > 32) return [];
  return Array.from({ length }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  }).filter(isProductionWorkday);
}
const dayLabel = (date: string) => new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
}).format(new Date(date + "T12:00:00Z"));
const dollars = (amount: number) => amount.toLocaleString("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const avatarStyles = [
  "bg-sky-500/15 text-sky-500 dark:text-sky-300",
  "bg-violet-500/15 text-violet-500 dark:text-violet-300",
  "bg-amber-500/15 text-amber-500 dark:text-amber-300",
  "bg-teal-500/15 text-teal-600 dark:text-teal-300",
  "bg-rose-500/15 text-rose-500 dark:text-rose-300",
];
const legacyWeeklyHint = (issue: string | null) =>
  issue !== null && /this week uses the weekly flat bonus|pay through weekly bonus payroll|already covered by a weekly bonus review/i.test(issue);

/**
 * Only combine workers who were linked on THIS date and have the same category.
 * Checkout offers use each worker's own Stock Entry credits, so summing them
 * once here gives the actual shared output without changing payment eligibility.
 */
export function linkedDailyProgress(
  worker: BonusSheetWorker, workers: BonusSheetWorker[], date: string,
): (BonusSheetDay & { linkedMemberIds: number[] }) | null {
  const day = worker.days.find(entry => entry.date === date);
  if (!day) return null;
  const individual = { ...day, linkedMemberIds: [worker.workerId] };
  const category = day.category.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (day.linkGroupId == null || !category) return individual;

  const matching = workers.map(member => ({
    workerId: member.workerId,
    day: member.days.find(entry =>
      entry.date === date &&
      entry.linkGroupId === day.linkGroupId &&
      entry.category.trim().replace(/\s+/g, " ").toLocaleLowerCase() === category),
  })).filter((entry): entry is { workerId: number; day: BonusSheetDay } => entry.day != null);
  if (matching.length < 2) return individual;

  return {
    ...day,
    produced: matching.reduce((sum, member) => sum + member.day.produced, 0),
    target: matching.reduce((sum, member) => sum + member.day.target, 0),
    linkedMemberIds: matching.map(member => member.workerId),
  };
}

export function ProductionBonusWeeklySheet({
  from, to, workers, selected, onToggle, manualMode = false, manualAmounts = {},
  onAmountChange, manuallyPaidIds = [], renderDayActions, loading,
}: Props) {
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof bonusText>[0]) => bonusText(key, language);
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, language);
  const dates = useMemo(() => productionSheetWorkdays(from, to), [from, to]);
  const rangeLabel = validDate(from) && validDate(to)
    ? dayLabel(from) + " – " + dayLabel(to) : "Choose valid dates";
  const visibleWorkers = useMemo(() => workers.map(worker => {
    // The API already excludes Sunday for new awards. Defensive filtering also
    // prevents a stale checkout response from reintroducing Sunday into the sheet.
    const days = worker.days.filter(day => isProductionWorkday(day.date));
    return { ...worker, days };
  }), [workers]);
  // Group only workers sharing a currently visible production link. This changes
  // presentation order only; every member keeps their own credited bales,
  // target, checkbox and independently validated payment.
  const arrangedWorkers = useMemo(() => {
    const groups = new Map<number, BonusSheetWorker[]>();
    const latestLink = (worker: BonusSheetWorker) =>
      [...worker.days].reverse().find(day => day.linkGroupId != null)?.linkGroupId ?? null;
    for (const worker of visibleWorkers) {
      const id = latestLink(worker);
      if (id != null) groups.set(id, [...(groups.get(id) ?? []), worker]);
    }
    const arranged: Array<{ worker: BonusSheetWorker; members: BonusSheetWorker[]; first: boolean }> = [];
    const seen = new Set<number>();
    for (const worker of visibleWorkers) {
      if (seen.has(worker.workerId)) continue;
      const id = latestLink(worker);
      const team = id != null ? groups.get(id) : undefined;
      const members = team && team.length > 1 ? team.filter(member => !seen.has(member.workerId)) : [worker];
      for (const [index, member] of members.entries()) {
        arranged.push({ worker: member, members, first: index === 0 });
        seen.add(member.workerId);
      }
    }
    return arranged;
  }, [visibleWorkers]);
  const dayTotals = useMemo(() => dates.map(date =>
    visibleWorkers.reduce((total, worker) =>
      total + (worker.days.find(day => day.date === date)?.produced ?? 0), 0),
  ), [dates, visibleWorkers]);
  const totalProduced = visibleWorkers.reduce((sum, worker) =>
    sum + worker.days.reduce((n, day) => n + day.produced, 0), 0);
  const totalTarget = visibleWorkers.reduce((sum, worker) =>
    sum + worker.days.reduce((n, day) => n + day.target, 0), 0);
  const totalExtra = visibleWorkers.reduce((sum, worker) => sum + worker.extra, 0);
  const displayedTotal = visibleWorkers.reduce((sum, worker) =>
    sum + Math.round(worker.amount * 100) + Math.round(worker.weeklyAmount * 100), 0) / 100;
  const includesWeekly = visibleWorkers.some(worker => worker.weeklyAmount > 0);
  const totalWorkdays = dates.length;

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      aria-label={t("sheetView")} data-testid="production-bonus-daily-sheet">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 bg-gradient-to-r from-emerald-500/[0.07] via-card to-card px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/15 text-emerald-600 shadow-sm dark:text-emerald-400">
            <BarChart3 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-semibold tracking-tight">{t("sheetView")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Daily output and targets; same-category linked workers share each daily target. Bonuses remain payable individually.
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
      <div className="space-y-3 p-3 md:hidden phone-land:block" data-testid="production-bonus-mobile-workers">
        {loading ? <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t("loading")}</p> : null}
        {!loading && !arrangedWorkers.length ? <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t("noRows")}</p> : null}
        {!loading && arrangedWorkers.map(({ worker, members }, index) => {
          const paidManually = manualMode && manuallyPaidIds.includes(worker.workerId);
          const eligible = !paidManually && (manualMode || worker.readyDays > 0);
          const made = worker.days.reduce((total, day) => total + day.produced, 0);
          const target = worker.days.reduce((total, day) => total + day.target, 0);
          const achieved = target > 0 && made >= target;
          const teamLead = members[0];
          return (
            <article key={worker.workerId}
              className={"min-w-0 rounded-xl border bg-card p-3 shadow-sm " +
                (members.length > 1 ? "border-violet-500/40" : "")}
              data-testid={`bonus-mobile-worker-${worker.workerId}`}>
              {members.length > 1 && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-300"
                  data-linked-workers="true">
                  <UsersRound className="h-4 w-4" aria-hidden="true" />
                  {worker.workerId === teamLead.workerId
                    ? `${dt("linkedTeam")} · ${members.length} ${t("worker")}`
                    : `${dt("linkedTo")} ${teamLead.workerName}`}
                </div>
              )}
              <div className="flex min-w-0 items-start gap-3">
                <Checkbox checked={selected.includes(worker.workerId)} disabled={!eligible}
                  aria-label={t("selectBonus") + " " + worker.workerName}
                  onCheckedChange={(checked) => onToggle(worker.workerId, checked === true)} />
                <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-full " + avatarStyles[index % avatarStyles.length]}>
                  <UserRound className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <button type="button" disabled={!eligible}
                    onClick={() => onToggle(worker.workerId, !selected.includes(worker.workerId))}
                    aria-label={t("select") + " " + worker.workerName}
                    className="break-words text-left text-sm font-semibold disabled:cursor-not-allowed">
                    {worker.workerName}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {paidManually ? dt("manualPaid") : manualMode ? dt("manualPayment") : worker.paidDays
                      ? t("paidStatus") : worker.readyDays ? t("ready") : worker.weeklyProjected
                        ? dt("bonusProjected") : worker.weeklyApproved ? dt("bonusApproved")
                          : worker.needsSetup ? t("needsSetup") : t("sheetNoExtra")}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-muted/30 p-2 text-center text-xs tabular-nums">
                <div><span className="block text-muted-foreground">{dt("produced")}</span><strong className="text-base">{made}</strong></div>
                <div><span className="block text-muted-foreground">{t("target")}</span><strong className="text-base">{target}</strong></div>
                <div><span className="block text-muted-foreground">{t("extra")}</span><strong className={worker.extra > 0 ? "text-emerald-600" : ""}>{worker.extra}</strong></div>
              </div>
              <p className={"mt-2 text-sm font-semibold tabular-nums " +
                (achieved ? "text-emerald-600 dark:text-emerald-400" : "")}>
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
                  <Input type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal"
                    value={manualAmounts[worker.workerId] ?? ""}
                    onChange={(event) => onAmountChange?.(worker.workerId, event.target.value)}
                    aria-label={dt("manualBonusUsd") + ": " + worker.workerName}
                    className="mt-1 h-11 w-full text-base tabular-nums"
                    data-testid={`bonus-mobile-amount-${worker.workerId}`} />
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
{day?.category ? <p className="mt-1 break-words text-muted-foreground">{day.category}</p> : null}
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
            <div className="flex justify-between"><span>{t("sheetTotal")}</span><strong>{totalProduced} / {totalTarget}</strong></div>
            <div className="mt-2 flex justify-between"><span>{t("extra")}</span><strong>{totalExtra}</strong></div>
            <div className="mt-2 flex justify-between font-semibold"><span>{t("bonus")}</span><strong>{dollars(displayedTotal)}</strong></div>
            {includesWeekly && <p className="mt-2 text-xs text-muted-foreground">{dt("weeklyEstimateHint")}</p>}
          </div>
        )}
      </div>
      <div className="hidden max-h-[75vh] w-full overflow-auto overscroll-contain md:block phone-land:hidden" data-testid="production-daily-sheet-scroll-area">
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="bg-muted/45 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="sticky left-0 top-0 z-40 min-w-[240px] border-b border-r border-border/60 bg-muted px-4 py-4 text-left sm:px-5">
                {t("worker")}
              </th>
              {dates.map(date => <th key={date} scope="col"
                className="sticky top-0 z-30 min-w-[152px] border-b border-r border-border/50 bg-muted px-2 py-4 text-center">
                {dayLabel(date)}
              </th>)}
              <th scope="col" className="sticky top-0 z-30 min-w-[205px] border-b border-r border-border/50 bg-muted px-3 py-4 text-right">
                {t("sheetTotal")}
              </th>
              <th scope="col" className="sticky top-0 z-30 min-w-[150px] border-b border-border/50 bg-muted px-3 py-4 text-right">
                {t("bonus")}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={dates.length + 3} className="px-4 py-12 text-center text-muted-foreground">{t("loading")}</td></tr>}
            {!loading && !visibleWorkers.length && <tr><td colSpan={dates.length + 3} className="px-4 py-12 text-center text-muted-foreground">{t("noRows")}</td></tr>}
            {!loading && arrangedWorkers.map(({ worker, members, first }, index) => {
              const ready = worker.readyDays > 0;
              const made = worker.days.reduce((sum, day) => sum + day.produced, 0);
              const target = worker.days.reduce((sum, day) => sum + day.target, 0);
              const achievedWeek = target > 0 && made >= target;
              return <tr key={worker.workerId} className="group hover:bg-muted/20">
                {first && <th scope="row" rowSpan={members.length}
                  className="sticky left-0 z-10 border-b border-r border-border/50 bg-card px-2 py-2 text-left align-top group-hover:bg-muted sm:px-3">
                  <div className={members.length > 1
                    ? "overflow-hidden rounded-xl border-2 border-violet-500/40 bg-violet-500/[0.06]"
                    : ""} data-linked-workers={members.length > 1 ? "true" : undefined}>
                    {members.length > 1 && <div className="flex items-center gap-1.5 border-b border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
                      <UsersRound className="h-3.5 w-3.5" aria-hidden="true"/>
                      Linked team · {members.length} workers
                    </div>}
                    {members.map((member, memberIndex) => {
                      const alreadyPaidManually = manualMode && manuallyPaidIds.includes(member.workerId);
                      const eligible = !alreadyPaidManually && (manualMode || member.readyDays > 0);
                      const memberState = eligible ? t("ready") : member.paidDays ? t("paidStatus")
                        : member.weeklyProjected ? "Bonus projected"
                        : member.weeklyApproved ? "Bonus approved"
                        : member.weeklyDays ? "Weekly bonus"
                        : member.needsSetup ? t("needsSetup")
                        : member.blockedDays ? t("needsReview") : t("sheetNoExtra");
                      return <div key={member.workerId}
                        className={"flex min-h-[80px] items-center gap-2 px-2 py-2 " +
                          (memberIndex > 0 ? "border-t border-violet-500/20 " : "") +
                          (members.length > 1 ? "sm:px-3" : "")}>
                        <Checkbox checked={selected.includes(member.workerId)} disabled={!eligible}
                          aria-label={t("selectBonus") + " " + member.workerName}
                          title={alreadyPaidManually ? "Manual bonus already paid for this week"
                            : !eligible && (member.weeklyProjected || member.weeklyApproved || member.weeklyDays)
                            ? "Weekly flat bonuses are handled in the Weekly Bonus Review & Pay section below"
                            : !eligible ? "No approved or payable daily bonus for this worker" : undefined}
                          onCheckedChange={checked => onToggle(member.workerId, checked === true)} />
                        <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-full " +
                          avatarStyles[(index + memberIndex) % avatarStyles.length]}>
                          <UserRound className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <button type="button" dir="auto" disabled={!eligible}
                            aria-label={"Select " + member.workerName}
                            onClick={()=>onToggle(member.workerId,!selected.includes(member.workerId))}
                            className="block whitespace-nowrap text-left text-sm font-semibold hover:underline disabled:cursor-not-allowed disabled:no-underline">
                            {member.workerName}
                          </button>
                          {memberIndex > 0 && <span className="block text-[10px] font-semibold text-violet-700 dark:text-violet-300" dir="auto">
                            Linked to {members[0].workerName}
                          </span>}
                          <span className={"mt-1 inline-flex max-w-[145px] rounded-md border px-2 py-0.5 text-[10px] font-medium " +
                            (member.weeklyDays || member.weeklyProjected || member.weeklyApproved
                              ? "border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                              : "border-border/70 bg-muted/70 text-muted-foreground")}>
                            {alreadyPaidManually ? "Manual paid" : manualMode ? "Enter manual payment" : memberState}
                          </span>
                          {manualMode && selected.includes(member.workerId) && !alreadyPaidManually && (
                            <label className="mt-2 flex items-center gap-1 text-xs font-medium text-foreground">
                              <span className="shrink-0">Pay $</span>
                              <Input type="number" min="0.01" max="1000000" step="0.01"
                                inputMode="decimal" aria-label={"Manual bonus USD for " + member.workerName}
                                placeholder="0.00" className="h-8 w-[100px] text-sm tabular-nums"
                                value={manualAmounts[member.workerId] ?? ""}
                                onChange={event => onAmountChange?.(member.workerId, event.target.value)} />
                            </label>
                          )}
                        </div>
                      </div>;
                    })}
                  </div>
                </th>}
                {dates.map(date => {
                  const day = linkedDailyProgress(worker, visibleWorkers, date);
                  const memberIndices = day?.linkedMemberIds.map(workerId =>
                    arrangedWorkers.findIndex(entry => entry.worker.workerId === workerId)) ?? [];
                  const orderedIndices = [...memberIndices].sort((left, right) => left - right);
                  // A spanning cell must not cover unrelated category rows.
                  // When members are not adjacent, show the same shared result in
                  // their own cells rather than swallowing another worker's cell.
                  const canSpan = orderedIndices.length > 1 &&
                    orderedIndices.every((position, offset) =>
                      position >= 0 && position === orderedIndices[0] + offset);
                  if (canSpan && index !== orderedIndices[0]) return null;
                  const span = canSpan ? orderedIndices.length : 1;
                  const achieved = Boolean(day && day.target > 0 && day.produced >= day.target);
                  const percent = day && day.target > 0
                    ? Math.min(100, Math.max(0, Math.round(day.produced / day.target * 100)))
                    : 0;
                  const memberIds = canSpan && day ? day.linkedMemberIds : [worker.workerId];
                  const issues = [...new Set(memberIds.flatMap(workerId => {
                    const member = visibleWorkers.find(entry => entry.workerId === workerId);
                    const entry = member?.days.find(value => value.date === date);
                    return entry?.issue && !legacyWeeklyHint(entry.issue) && entry.status !== "weekly"
                      ? [entry.issue] : [];
                  }))];
                  const issue = issues.join(" · ");
                  return <td key={date} rowSpan={span}
                    data-testid={day && day.linkedMemberIds.length > 1 ? `linked-daily-cell-${date}-${worker.workerId}` : undefined}
                    data-linked-daily-target={day && day.linkedMemberIds.length > 1 ? "true" : undefined}
                    className="border-b border-r border-border/40 p-1.5 align-middle">
                    {day ? <div className={"relative flex min-h-[76px] flex-col justify-center rounded-xl border px-3 py-3 transition-colors " +
                      (achieved
                        ? "border-emerald-500/30 bg-emerald-500/15 dark:bg-emerald-800/35"
                        : day.linkedMemberIds.length > 1
                          ? "border-violet-500/30 bg-violet-500/[0.07] dark:bg-violet-500/[0.12]"
                          : "border-border/60 bg-muted/30 hover:bg-muted/60")}
                      style={span > 1 ? { minHeight: span * 80 - 4 } : undefined}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="whitespace-nowrap font-bold tabular-nums">
                          <span className="text-lg">{day.produced}</span>
                          <span className="ml-1 text-xs font-normal text-muted-foreground">/ {day.target}</span>
                        </div>
                        {achieved
                          ? <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm">
                              <Check className="h-4 w-4" strokeWidth={3} aria-label="Target met" />
                            </span>
                          : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-[4px]"
                              role="img" aria-label={String(percent) + "% of daily target"}
                              style={{ background: "conic-gradient(#34d399 " + percent + "%, #47556944 0)" }}>
                              <span className="h-full w-full rounded-full bg-card" />
                            </span>}
                      </div>
                      <div className="mt-1 max-w-[132px] truncate text-[11px] font-medium text-muted-foreground"
                        title={day.category}>{day.category || "—"}</div>
                      {day.linkedMemberIds.length > 1 && (
                        <div className="mt-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
                          Shared daily target · {day.linkedMemberIds.length} workers
                        </div>
                      )}
                      {issue && <div className="mt-1 max-w-[132px] truncate text-[10px] text-amber-600 dark:text-amber-400" title={issue}>
                        {issue}
                      </div>}
                      {memberIds.map(workerId => {
                        const action = renderDayActions?.(workerId, date);
                        if (!action) return null;
                        const memberName = visibleWorkers.find(entry => entry.workerId === workerId)?.workerName;
                        return <div key={workerId}>
                          {span > 1 && <div className="mt-1 text-[10px] text-muted-foreground" dir="auto">{memberName}</div>}
                          {action}
                        </div>;
                      })}
                    </div> : <div className="flex min-h-[76px] items-center justify-center rounded-xl border border-dashed border-border/40 text-muted-foreground/50">—</div>}
                  </td>;
                })}
                <td className="border-b border-r border-border/40 p-1.5">
                  <div className={"flex min-h-[76px] items-center gap-3 rounded-xl border px-3 py-2.5 " +
                    (achievedWeek ? "border-emerald-500/30 bg-emerald-500/10" : "border-border/60 bg-muted/35")}>
                    <span className={"flex h-10 w-10 shrink-0 items-center justify-center rounded-lg " +
                      (achievedWeek ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground")}>
                      <BarChart3 className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="text-right">
                      <strong className="block text-xl font-bold tabular-nums">{made}</strong>
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                        {t("target")}: {target} · +{worker.extra} {t("extra")}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="border-b border-border/40 p-2 text-right align-middle tabular-nums">
                  <strong className={"block whitespace-nowrap text-base font-bold " +
                    (ready ? "text-emerald-600 dark:text-emerald-400" : "")}>
                    {dollars(worker.amount + worker.weeklyAmount)}
                  </strong>
                  {worker.weeklyAmount > 0 && <span className="mt-1 block text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    {worker.weeklyProjected ? "Projected · finish week and approve before payment" : "Weekly approved · pay in the section below"}
                  </span>}
                </td>
              </tr>;
            })}
          </tbody>
          {visibleWorkers.length > 0 && !loading && <tfoot>
            <tr className="bg-muted/50 font-semibold tabular-nums">
              <th scope="row" className="sticky left-0 z-10 border-r border-border/50 bg-muted px-4 py-4 text-left">
                {t("total")}
              </th>
              {dayTotals.map((value, index) => <td key={dates[index]} className="border-r border-border/40 px-3 py-4 text-center">{value}</td>)}
              <td className="border-r border-border/40 px-3 py-3 text-right">
                <strong className="block text-lg">{totalProduced}</strong>
                <span className="text-[11px] font-normal text-muted-foreground">{t("target")}: {totalTarget} · +{totalExtra} {t("extra")}</span>
              </td>
              <td className="px-3 py-3 text-right">
                {dollars(displayedTotal)}
                {includesWeekly && <span className="block text-[10px] font-normal text-muted-foreground">Includes weekly estimates · use Weekly Bonus Review & Pay below</span>}
              </td>
            </tr>
          </tfoot>}
        </table>
      </div>
    </section>
  );
}
