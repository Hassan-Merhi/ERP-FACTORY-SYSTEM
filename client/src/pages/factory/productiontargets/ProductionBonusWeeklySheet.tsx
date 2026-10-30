import { useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";

/**
 * A read-only production ledger: exactly the same offer rows and worker
 * selections used by checkout, never an independent bonus calculation.
 */
export type BonusSheetDay = {
  date: string;
  target: number;
  produced: number;
  extra: number;
  category: string;
  issue: string | null;
  status: string;
};
export type BonusSheetWorker = {
  workerId: number;
  workerName: string;
  days: BonusSheetDay[];
  target: number;
  produced: number;
  extra: number;
  amount: number;
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
  loading: boolean;
};

const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

function columnsBetween(from: string, to: string): string[] {
  if (!validDate(from) || !validDate(to) || from > to) return [];
  const first = new Date(from + "T12:00:00Z");
  const length = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (length < 1 || length > 32) return [];
  return Array.from({ length }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

const dayLabel = (date: string) => new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
}).format(new Date(date + "T12:00:00Z"));

const dollars = (amount: number) => amount.toLocaleString("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function ProductionBonusWeeklySheet({
  from, to, workers, selected, onToggle, loading,
}: Props) {
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof bonusText>[0]) => bonusText(key, language);
  const dates = useMemo(() => columnsBetween(from, to), [from, to]);
  const dayTotals = useMemo(() => dates.map(date =>
    workers.reduce((total, worker) =>
      total + (worker.days.find(day => day.date === date)?.produced ?? 0), 0),
  ), [dates, workers]);
  const totalProduced = workers.reduce((total, worker) => total + worker.produced, 0);
  const totalTarget = workers.reduce((total, worker) => total + worker.target, 0);
  const totalExtra = workers.reduce((total, worker) => total + worker.extra, 0);
  const payableTotal = workers.reduce((total, worker) => total + Math.round(worker.amount * 100), 0) / 100;

  return <section className="overflow-hidden rounded-xl border border-border/70"
    aria-label={t("sheetView")} data-testid="production-bonus-daily-sheet">
    <div className="border-b bg-muted/20 px-4 py-3">
      <h3 className="font-semibold">{t("sheetView")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("sheetHint")}</p>
    </div>
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-muted/80">
          <tr>
            <th scope="col" className="sticky left-0 z-20 min-w-[230px] border-b border-r bg-muted px-3 py-3 text-left">
              {t("worker")}
            </th>
            {dates.map(date => <th key={date} scope="col"
              className="min-w-[128px] border-b border-r px-3 py-3 text-center font-semibold">
              {dayLabel(date)}
            </th>)}
            <th scope="col" className="min-w-[160px] border-b border-r px-3 py-3 text-right">
              {t("sheetTotal")}
            </th>
            <th scope="col" className="min-w-[124px] border-b px-3 py-3 text-right">
              {t("bonus")}
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={dates.length + 3}
            className="px-4 py-10 text-center text-muted-foreground">{t("loading")}</td></tr>}
          {!loading && !workers.length && <tr><td colSpan={dates.length + 3}
            className="px-4 py-10 text-center text-muted-foreground">{t("noRows")}</td></tr>}
          {!loading && workers.map((worker, index) => {
            const ready = worker.readyDays > 0;
            const byDate = new Map(worker.days.map(day => [day.date, day]));
            const status = ready ? t("ready") :
              worker.paidDays ? t("paidStatus") :
              worker.weeklyDays ? t("weeklyStatus") :
              worker.needsSetup ? t("needsSetup") :
              worker.blockedDays ? t("needsReview") : t("sheetNoExtra");
            return <tr key={worker.workerId} className={index % 2 ? "bg-muted/10" : "bg-background"}>
              <th scope="row" className="sticky left-0 z-[1] border-b border-r bg-card px-3 py-3 text-left align-middle">
                <div className="flex items-center gap-3">
                  <Checkbox checked={selected.includes(worker.workerId)} disabled={!ready}
                    aria-label={t("selectBonus") + " " + worker.workerName}
                    onCheckedChange={checked => onToggle(worker.workerId, checked === true)} />
                  <div>
                    <span className="block font-medium" dir="auto">{worker.workerName}</span>
                    <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                      {status}
                    </span>
                  </div>
                </div>
              </th>
              {dates.map(date => {
                const day = byDate.get(date);
                return <td key={date} className="border-b border-r px-3 py-2 text-center align-middle tabular-nums">
                  {day ? <div className="space-y-1">
                    <div className="text-base font-semibold">{day.produced}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        / {day.target} {t("target")}
                      </span>
                    </div>
                    {day.category && <div className="max-w-[145px] truncate text-xs text-muted-foreground"
                      title={day.category}>{day.category}</div>}
                    {day.extra > 0 && <div className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      +{day.extra} {t("extra")}
                    </div>}
                  </div> : <span className="text-muted-foreground/60">—</span>}
                </td>;
              })}
              <td className="border-b border-r px-3 py-2 text-right align-middle tabular-nums">
                <strong className="block text-base">{worker.produced}</strong>
                <span className="block text-xs text-muted-foreground">
                  {t("target")}: {worker.target}
                </span>
                <span className={"block text-xs font-medium " +
                  (worker.extra > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  +{worker.extra} {t("extra")}
                </span>
              </td>
              <td className="border-b px-3 py-2 text-right align-middle tabular-nums">
                <strong className={ready ? "text-primary" : "text-muted-foreground"}>
                  {dollars(worker.amount)}
                </strong>
              </td>
            </tr>;
          })}
        </tbody>
        {workers.length > 0 && !loading && <tfoot>
          <tr className="bg-muted/40 font-semibold tabular-nums">
            <th scope="row" className="sticky left-0 z-[1] border-r bg-muted px-3 py-3 text-left">
              {t("total")}
            </th>
            {dayTotals.map((total, index) => <td key={dates[index]}
              className="border-r px-3 py-3 text-center">{total}</td>)}
            <td className="border-r px-3 py-3 text-right">
              {totalProduced} <span className="block text-xs font-normal text-muted-foreground">
                {t("target")}: {totalTarget} · +{totalExtra} {t("extra")}
              </span>
            </td>
            <td className="px-3 py-3 text-right">{dollars(payableTotal)}</td>
          </tr>
        </tfoot>}
      </table>
    </div>
  </section>;
}
