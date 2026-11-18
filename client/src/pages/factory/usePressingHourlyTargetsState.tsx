// Extracted from ./PressingHourlyTargets.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePressingUiText } from "@/i18n/pressingUiTranslations";
import type { PressingHourlySnapshot } from "./pressing-scanner/pressingHourlyKpi";

export const ENDPOINT = "/api/factory/pressing-machines/report/hourly-targets";

export const ZONE = "Asia/Beirut";

export const SCHEDULE_HOURS = Array.from({ length: 10 }, (_, index) => index + 7);

export const SCHEDULE_DAYS = [
  { id: 1, name: "Monday", short: "Mon" },
  { id: 2, name: "Tuesday", short: "Tue" },
  { id: 3, name: "Wednesday", short: "Wed" },
  { id: 4, name: "Thursday", short: "Thu" },
  { id: 5, name: "Friday", short: "Fri" },
  { id: 6, name: "Saturday", short: "Sat" },
] as const;

export const scheduleHourLabel = (hour: number) =>
  String(hour).padStart(2, "0") + ":00–" + String(hour + 1).padStart(2, "0") + ":00";

type HourlyResponse = PressingHourlySnapshot;

export const formatKg = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });

export function localHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso))
  );
}

export function hourLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
}

type Verdict = "off" | "zero" | "upcoming" | "progress" | "none" | "met" | "above" | "below";

export function resultStatus(kg: number, target: number, bales: number, started: boolean, complete: boolean): Verdict {
  if (target === 0) return "zero";
  if (!started) return "upcoming";
  if (!complete) return "progress";
  if (!bales) return "none";
  if (Math.abs(kg - target) < 0.001) return "met";
  return kg > target ? "above" : "below";
}

export const verdictStyle: Record<Verdict, { label: string; pill: string; bar: string }> = {
  off: { label: "Day off", pill: "bg-slate-500/15 text-muted-foreground", bar: "bg-slate-500" },
  zero: { label: "No target", pill: "bg-slate-500/15 text-muted-foreground", bar: "bg-slate-500" },
  upcoming: { label: "upcoming", pill: "bg-slate-500/10 text-slate-500", bar: "bg-slate-500" },
  progress: { label: "In progress", pill: "bg-sky-500/15 text-sky-600 dark:text-sky-300", bar: "bg-sky-500" },
  none: { label: "No scans", pill: "bg-slate-500/15 text-muted-foreground", bar: "bg-slate-500" },
  met: { label: "Target met", pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500" },
  above: {
    label: "aboveTarget",
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    bar: "bg-emerald-500",
  },
  below: { label: "belowTarget", pill: "bg-rose-500/15 text-rose-700 dark:text-rose-300", bar: "bg-rose-500" },
};

export function usePressingHourlyTargetsState({
  active,
  companyId,
  serverToday,
  selectedDay,
  onDayChange,
  onDataChange,
}: {
  active: boolean;
  companyId: number;
  serverToday?: string;
  selectedDay?: string;
  onDayChange?: (day: string) => void;
  onDataChange?: (data: PressingHourlySnapshot | undefined, companyId: number) => void;
}) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof translatePressingUiText>[0]) => translatePressingUiText(key, language);
  const [localDay, setLocalDay] = useState(serverToday || "");
  const day = selectedDay === undefined ? localDay : selectedDay;
  const setDay = onDayChange ?? setLocalDay;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingHour, setSavingHour] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<string, Record<string, string>>>({});
  const [selectedWeekday, setSelectedWeekday] = useState(1);
  const [savingSchedule, setSavingSchedule] = useState(false);
  useEffect(() => {
    setScheduleOpen(false);
    setScheduleDrafts({});
  }, [companyId]);
  useEffect(() => {
    if (selectedDay === undefined) setLocalDay(serverToday || "");
    setDrafts({});
  }, [companyId, serverToday, selectedDay]);
  useEffect(() => {
    setDrafts({});
  }, [day]);
  const hourly = useQuery<HourlyResponse>({
    queryKey: [ENDPOINT, companyId, day],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ENDPOINT + (day ? "?day=" + encodeURIComponent(day) : ""), {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load hourly targets (" + response.status + ")");
      return response.json() as Promise<HourlyResponse>;
    },
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: false,
  });
  const data = hourly.data;
  useEffect(() => {
    onDataChange?.(data, companyId);
  }, [data, companyId, onDataChange]);
  const serverDate = data?.serverNow
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(data.serverNow))
    : [];
  const datePart = (type: string) => serverDate.find((part) => part.type === type)?.value;
  const maxDay =
    serverToday || (serverDate.length ? [datePart("year"), datePart("month"), datePart("day")].join("-") : undefined);
  const now = data ? new Date(data.serverNow).getTime() : 0;
  // Keep all ten production hours visible (including upcoming hours) so every
  // daily target can be entered in advance. DST transitions use true instants.
  const hours = [...new Set((data?.hours || []).map((row) => row.hourStart))]
    .filter((hour) => localHour(hour) >= 7 && localHour(hour) < 17)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  const configured = (hour: string) => data?.hourlyTargetsKg?.[String(localHour(hour))];
  const baseline = (data?.workers || []).map((worker) => worker.targetKgPerHour);
  const uniformBaseline = baseline.length && baseline.every((v) => v === baseline[0]) ? baseline[0] : null;
  const targetText = (hour: string) => {
    const value = configured(hour);
    if (data?.scheduledWorkday === false && value === undefined) return "";
    return value !== undefined ? String(value) : uniformBaseline !== null ? String(uniformBaseline) : "";
  };
  const valueForHour = (hour: string) => drafts[hour] ?? targetText(hour);
  const dirty = (hour: string) => drafts[hour] !== undefined && drafts[hour] !== targetText(hour);
  return {
    configured,
    data,
    day,
    dirty,
    hourly,
    hours,
    maxDay,
    now,
    savingHour,
    savingSchedule,
    scheduleDrafts,
    scheduleOpen,
    selectedWeekday,
    setDay,
    setDrafts,
    setSavingHour,
    setSavingSchedule,
    setScheduleDrafts,
    setScheduleOpen,
    setSelectedWeekday,
    t,
    toast,
    uniformBaseline,
    valueForHour,
  };
}

export function PressingHourlyTargetsSection({
  savingSchedule,
  scheduleDrafts,
  selectedWeekday,
  setScheduleDrafts,
}: Pick<
  ReturnType<typeof usePressingHourlyTargetsState>,
  "savingSchedule" | "scheduleDrafts" | "selectedWeekday" | "setScheduleDrafts"
>) {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
      <div className="mb-2 grid grid-cols-[1fr_135px] gap-3 px-2 text-[11px] font-semibold text-muted-foreground">
        <span>{SCHEDULE_DAYS.find((day) => day.id === selectedWeekday)?.name} · Beirut time</span>
        <span>KG per worker</span>
      </div>
      {SCHEDULE_HOURS.map((hour) => (
        <div
          key={hour}
          className="grid grid-cols-[1fr_135px] items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2 transition-colors focus-within:border-sky-500/50"
        >
          <span className="font-semibold tabular-nums text-sm">{scheduleHourLabel(hour)}</span>
          <div className="relative">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              max="100000"
              step="0.001"
              aria-label={
                SCHEDULE_DAYS.find((day) => day.id === selectedWeekday)?.name + " target for " + scheduleHourLabel(hour)
              }
              className="h-9 rounded-lg bg-background pr-9 text-right font-semibold tabular-nums"
              value={scheduleDrafts[String(selectedWeekday)]?.[String(hour)] ?? ""}
              disabled={savingSchedule}
              onChange={(event) =>
                setScheduleDrafts((old) => ({
                  ...old,
                  [String(selectedWeekday)]: {
                    ...old[String(selectedWeekday)],
                    [String(hour)]: event.target.value,
                  },
                }))
              }
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted-foreground">
              KG
            </span>
          </div>
        </div>
      ))}
      <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
        Use 0 KG for an hour with no required target. Save the selected weekday; its times repeat weekly for all three
        workers. Date-specific changes still take priority.
      </p>
    </div>
  );
}

export function PressingHourlyTargetsSection2({
  savingSchedule,
  selectedWeekday,
  setSelectedWeekday,
}: Pick<
  ReturnType<typeof usePressingHourlyTargetsState>,
  "savingSchedule" | "selectedWeekday" | "setSelectedWeekday"
>) {
  return (
    <div className="shrink-0 border-b border-border/60 px-5 py-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
        <span>Select a day</span>
        <span>Sunday · off</span>
      </div>
      <div
        role="tablist"
        aria-label="Choose weekly pressing schedule day"
        className="grid grid-cols-3 gap-1.5 sm:grid-cols-6"
      >
        {SCHEDULE_DAYS.map((weekday) => (
          <button
            key={weekday.id}
            type="button"
            role="tab"
            aria-selected={selectedWeekday === weekday.id}
            aria-label={weekday.name}
            disabled={savingSchedule}
            onClick={() => setSelectedWeekday(weekday.id)}
            className={
              "rounded-lg border px-2 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
              (selectedWeekday === weekday.id
                ? "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : "border-border/70 bg-card/50 text-muted-foreground hover:bg-muted/80 hover:text-foreground")
            }
          >
            {weekday.short}
          </button>
        ))}
      </div>
    </div>
  );
}
