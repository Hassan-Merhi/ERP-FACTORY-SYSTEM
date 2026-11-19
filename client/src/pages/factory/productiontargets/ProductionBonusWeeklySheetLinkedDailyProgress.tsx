// Extracted from ./ProductionBonusWeeklySheet.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { isProductionWorkday } from "@shared/productionTargetBonusWeeklyMethod";
import {
  validDate,
  type BonusSheetDay,
  type BonusSheetWorker,
  type Props,
} from "./ProductionBonusWeeklySheetLinkedDailyProgressHelpers";
export {
  avatarStyles,
  type BonusSheetDay,
  type BonusSheetWorker,
  type Props,
} from "./ProductionBonusWeeklySheetLinkedDailyProgressHelpers";

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

export const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(date + "T12:00:00Z"));

export const dollars = (amount: number) =>
  amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const legacyWeeklyHint = (issue: string | null) =>
  issue !== null &&
  /this week uses the weekly flat bonus|pay through weekly bonus payroll|already covered by a weekly bonus review/i.test(
    issue
  );

/**
 * Only combine workers who were linked on THIS date and have the same category.
 * Checkout offers use each worker's own Stock Entry credits, so summing them
 * once here gives the actual shared output without changing payment eligibility.
 */
export function linkedDailyProgress(
  worker: BonusSheetWorker,
  workers: BonusSheetWorker[],
  date: string
): (BonusSheetDay & { linkedMemberIds: number[] }) | null {
  const day = worker.days.find((entry) => entry.date === date);
  if (!day) return null;
  const individual = { ...day, linkedMemberIds: [worker.workerId] };
  const category = day.category.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (day.linkGroupId == null || !category) return individual;

  const matching = workers
    .map((member) => ({
      workerId: member.workerId,
      day: member.days.find(
        (entry) =>
          entry.date === date &&
          entry.linkGroupId === day.linkGroupId &&
          entry.category.trim().replace(/\s+/g, " ").toLocaleLowerCase() === category
      ),
    }))
    .filter((entry): entry is { workerId: number; day: BonusSheetDay } => entry.day != null);
  if (matching.length < 2) return individual;

  return {
    ...day,
    produced: matching.reduce((sum, member) => sum + member.day.produced, 0),
    target: matching.reduce((sum, member) => sum + member.day.target, 0),
    linkedMemberIds: matching.map((member) => member.workerId),
  };
}

/** Display totals from each worker's credited daily output once, even in a linked team. */
export function productionTeamPeriodTotals(members: BonusSheetWorker[]) {
  const produced = members.reduce(
    (sum, member) => sum + member.days.reduce((daily, day) => daily + day.produced, 0),
    0
  );
  const target = members.reduce((sum, member) => sum + member.days.reduce((daily, day) => daily + day.target, 0), 0);
  const extra = members.reduce((sum, member) => sum + member.extra, 0);
  const percent = target > 0 ? Math.min(100, Math.max(0, Math.round((produced / target) * 100))) : 0;
  return { produced, target, extra, percent };
}

export function useProductionBonusWeeklySheetState({
  from,
  to,
  workers,
  selected,
  onToggle,
  manualMode = false,
  manualAmounts = {},
  onAmountChange,
  manuallyPaidIds = [],
  renderDayActions,
  loading,
}: Props) {
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof bonusText>[0]) => bonusText(key, language);
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, language);
  const dates = useMemo(() => productionSheetWorkdays(from, to), [from, to]);
  const rangeLabel = validDate(from) && validDate(to) ? dayLabel(from) + " – " + dayLabel(to) : "Choose valid dates";
  const visibleWorkers = useMemo(
    () =>
      workers.map((worker) => {
        // The API already excludes Sunday for new awards. Defensive filtering also
        // prevents a stale checkout response from reintroducing Sunday into the sheet.
        const days = worker.days.filter((day) => isProductionWorkday(day.date));
        return { ...worker, days };
      }),
    [workers]
  );
  // Group only workers sharing a currently visible production link. This changes
  // presentation order only; every member keeps their own credited bales,
  // target, checkbox and independently validated payment.
  const arrangedWorkers = useMemo(() => {
    const groups = new Map<number, BonusSheetWorker[]>();
    const latestLink = (worker: BonusSheetWorker) =>
      [...worker.days].reverse().find((day) => day.linkGroupId != null)?.linkGroupId ?? null;
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
      const members = team && team.length > 1 ? team.filter((member) => !seen.has(member.workerId)) : [worker];
      for (const [index, member] of members.entries()) {
        arranged.push({ worker: member, members, first: index === 0 });
        seen.add(member.workerId);
      }
    }
    return arranged;
  }, [visibleWorkers]);
  const dayTotals = useMemo(
    () =>
      dates.map((date) =>
        visibleWorkers.reduce(
          (total, worker) => total + (worker.days.find((day) => day.date === date)?.produced ?? 0),
          0
        )
      ),
    [dates, visibleWorkers]
  );
  const totalProduced = visibleWorkers.reduce(
    (sum, worker) => sum + worker.days.reduce((n, day) => n + day.produced, 0),
    0
  );
  const totalTarget = visibleWorkers.reduce(
    (sum, worker) => sum + worker.days.reduce((n, day) => n + day.target, 0),
    0
  );
  const totalExtra = visibleWorkers.reduce((sum, worker) => sum + worker.extra, 0);
  const displayedTotal =
    visibleWorkers.reduce(
      (sum, worker) => sum + Math.round(worker.amount * 100) + Math.round(worker.weeklyAmount * 100),
      0
    ) / 100;
  const includesWeekly = visibleWorkers.some((worker) => worker.weeklyAmount > 0);
  const totalWorkdays = dates.length;
  return {
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
  };
}

export function ProductionBonusWeeklySheetSection({
  dates,
  dayTotals,
  displayedTotal,
  includesWeekly,
  t,
  totalExtra,
  totalProduced,
  totalTarget,
}: Pick<
  ReturnType<typeof useProductionBonusWeeklySheetState>,
  "dates" | "dayTotals" | "displayedTotal" | "includesWeekly" | "t" | "totalExtra" | "totalProduced" | "totalTarget"
>) {
  return (
    <tfoot>
      <tr className="bg-muted/50 font-semibold tabular-nums">
        <th scope="row" className="sticky left-0 z-10 border-r border-border/50 bg-muted px-4 py-4 text-left">
          {t("total")}
        </th>
        {dayTotals.map((value, index) => (
          <td key={dates[index]} className="border-r border-border/40 px-3 py-4 text-center">
            {value}
          </td>
        ))}
        <td className="border-r border-border/40 px-3 py-3 text-right">
          <strong className="block text-lg">{totalProduced}</strong>
          <span className="text-[11px] font-normal text-muted-foreground">
            {t("target")}: {totalTarget} · +{totalExtra} {t("extra")}
          </span>
        </td>
        <td className="px-3 py-3 text-right">
          {dollars(displayedTotal)}
          {includesWeekly && (
            <span className="block text-[10px] font-normal text-muted-foreground">
              Includes weekly estimates · use Weekly Bonus Review & Pay below
            </span>
          )}
        </td>
      </tr>
    </tfoot>
  );
}

export function ProductionBonusWeeklySheetSection2({
  dates,
  t,
}: Pick<ReturnType<typeof useProductionBonusWeeklySheetState>, "dates" | "t">) {
  return (
    <thead>
      <tr className="bg-muted/45 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <th
          scope="col"
          className="sticky left-0 top-0 z-40 min-w-[240px] border-b border-r border-border/60 bg-muted px-4 py-4 text-left sm:px-5"
        >
          {t("worker")}
        </th>
        {dates.map((date) => (
          <th
            key={date}
            scope="col"
            className="sticky top-0 z-30 min-w-[152px] border-b border-r border-border/50 bg-muted px-2 py-4 text-center"
          >
            {dayLabel(date)}
          </th>
        ))}
        <th
          scope="col"
          className="sticky top-0 z-30 min-w-[205px] border-b border-r border-border/50 bg-muted px-3 py-4 text-right"
        >
          {t("sheetTotal")}
        </th>
        <th
          scope="col"
          className="sticky top-0 z-30 min-w-[150px] border-b border-border/50 bg-muted px-3 py-4 text-right"
        >
          {t("bonus")}
        </th>
      </tr>
    </thead>
  );
}
