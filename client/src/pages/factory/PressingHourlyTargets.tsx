import { CalendarClock, CalendarDays, Check, RefreshCw, Target, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type PressingHourlySnapshot } from "./pressing-scanner/pressingHourlyKpi";
import {
  ENDPOINT,
  PressingHourlyTargetsSection,
  PressingHourlyTargetsSection2,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  ZONE,
  formatKg,
  hourLabel,
  localHour,
  resultStatus,
  scheduleHourLabel,
  usePressingHourlyTargetsState,
  verdictStyle,
} from "./usePressingHourlyTargetsState";

/** Confirmed scans only; editable date-scoped hour targets are shared by P1/P2/P3.
 * No active shift schedule exists, so zero-scan completed hours stay neutral. */
export default function PressingHourlyTargets(props: {
  active: boolean;
  companyId: number;
  serverToday?: string;
  selectedDay?: string;
  onDayChange?: (day: string) => void;
  onDataChange?: (data: PressingHourlySnapshot | undefined, companyId: number) => void;
}) {
  const {
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
  } = usePressingHourlyTargetsState(props);

  async function save(hour: string) {
    if (!data?.canEdit || savingHour) return;
    const raw = valueForHour(hour);
    const targetKgPerHour = Number(raw);
    if (!raw.trim() || !Number.isFinite(targetKgPerHour) || targetKgPerHour < 0 || targetKgPerHour > 100000) {
      toast({ title: "Invalid target", description: t("invalidTargetDescription"), variant: "destructive" });
      return;
    }
    setSavingHour(hour);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: data.day, hour: localHour(hour), targetKgPerHour }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || "Could not save hourly target");
      }
      await hourly.refetch();
      setDrafts((current) => {
        const next = { ...current };
        delete next[hour];
        return next;
      });
      toast({
        title: "Hourly target saved",
        description: hourLabel(hour) + " — " + formatKg(targetKgPerHour) + " KG per worker",
      });
    } catch (error) {
      toast({
        title: "Target not saved",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingHour(null);
    }
  }

  function openDailySchedule() {
    if (!data?.canEdit) return;
    // Preload all six templates. Keep each weekday's draft in memory when
    // switching between tabs, and never derive it from the historical date.
    const draftsByDay: Record<string, Record<string, string>> = {};
    for (const weekday of SCHEDULE_DAYS) {
      const fields: Record<string, string> = {};
      for (const hour of SCHEDULE_HOURS) {
        const target = data.editableWeeklySchedulesKg?.[String(weekday.id)]?.[String(hour)] ?? uniformBaseline ?? 850;
        fields[String(hour)] = String(target);
      }
      draftsByDay[String(weekday.id)] = fields;
    }
    const todayName = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      weekday: "long",
    }).format(new Date(data.serverNow));
    setSelectedWeekday(SCHEDULE_DAYS.find((day) => day.name === todayName)?.id ?? 1);
    setScheduleDrafts(draftsByDay);
    setScheduleOpen(true);
  }

  async function saveDailySchedule() {
    if (!data?.canEdit || savingSchedule) return;
    const targetsKg: number[] = [];
    const selectedFields = scheduleDrafts[String(selectedWeekday)] ?? {};
    for (const hour of SCHEDULE_HOURS) {
      const raw = selectedFields[String(hour)] ?? "";
      const kg = Number(raw);
      if (!raw.trim() || !Number.isFinite(kg) || kg < 0 || kg > 100000) {
        toast({
          title: "Invalid daily schedule",
          description: scheduleHourLabel(hour) + ": enter a target between 0 and 100,000 KG.",
          variant: "destructive",
        });
        return;
      }
      targetsKg.push(kg);
    }
    setSavingSchedule(true);
    try {
      const response = await fetch(ENDPOINT + "/daily-schedule", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekday: selectedWeekday, targetsKg }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || "Could not save recurring daily schedule");
      }
      await hourly.refetch();
      const weekdayName = SCHEDULE_DAYS.find((day) => day.id === selectedWeekday)?.name ?? "Selected day";
      toast({
        title: weekdayName + " schedule saved",
        description:
          "The hourly targets repeat every " + weekdayName + " from today onward. You can now select another day.",
      });
    } catch (error) {
      toast({
        title: "Daily schedule not saved",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingSchedule(false);
    }
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-sky-500/[0.035] shadow-[0_12px_38px_-22px_hsl(var(--factory-hue)_89%_48%_/_0.25)]"
      data-testid="pressing-hourly-targets"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4 sm:px-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-2.5 text-blue-500">
            <Target className="h-5 w-5" />
          </div>
          <div>
            <h4 className="text-base font-bold tracking-tight sm:text-lg">Hourly KG targets</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              07:00–17:00 Beirut time · confirmed scans only · target per worker
            </p>
            {data?.canEdit && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 h-8 gap-1.5 rounded-lg border-sky-500/30 bg-sky-500/5 text-xs font-semibold hover:bg-sky-500/10"
                onClick={openDailySchedule}
                data-testid="pressing-open-daily-schedule"
              >
                <CalendarClock className="h-3.5 w-3.5 text-sky-500" />
                Weekly schedule
              </Button>
            )}
            {data?.dailyScheduleEffectiveDay && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Recurring hourly schedule active · saved {data.dailyScheduleEffectiveDay}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="hidden h-4 w-4 text-muted-foreground sm:block" />
          <Input
            aria-label="Hourly target date"
            type="date"
            max={maxDay}
            className="h-9 w-[150px] rounded-lg border-border/70 bg-background/70 text-xs"
            value={day || data?.day || ""}
            onChange={(event) => setDay(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-9 rounded-lg"
            disabled={hourly.isFetching}
            onClick={() => void hourly.refetch()}
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (hourly.isFetching ? "animate-spin" : "")} />
            <span className="sr-only">Refresh hourly targets</span>
          </Button>
        </div>
      </div>
      {hourly.isError && (
        <p role="alert" className="p-4 text-sm text-destructive">
          Could not load hourly targets. Try Refresh.
        </p>
      )}
      {hourly.isLoading && <p className="p-4 text-sm text-muted-foreground">Loading hourly production…</p>}
      {data && (
        <>
          <div className="overflow-x-auto p-3 sm:p-4">
            <table className="w-full min-w-[840px] border-separate border-spacing-0 text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="bg-muted/50">
                  <th scope="col" className="rounded-l-lg px-3 py-3 font-semibold">
                    Hour (Beirut)
                  </th>
                  <th scope="col" className="w-[178px] px-3 py-3 font-semibold">
                    {t("hourTargetHeader")}
                  </th>
                  {data.workers.map((worker) => (
                    <th scope="col" key={worker.userId} className="min-w-[200px] px-3 py-3 font-semibold">
                      {worker.name}
                    </th>
                  ))}
                  {data.workers.length === 0 && <th className="rounded-r-lg px-3 py-3">{t("noWorkersConfigured")}</th>}
                </tr>
              </thead>
              <tbody>
                {hours.map((hour) => {
                  const started = new Date(hour).getTime() <= now;
                  const complete = new Date(hour).getTime() + 3600000 <= now;
                  const hourTarget = configured(hour);
                  return (
                    <tr key={hour} className="group transition-colors hover:bg-sky-500/[0.035]">
                      <th
                        scope="row"
                        className="whitespace-nowrap border-b border-border/50 px-3 py-3 font-bold tabular-nums"
                      >
                        {hourLabel(hour)}
                      </th>
                      <td className="border-b border-border/50 px-3 py-2">
                        <div className="flex items-center gap-1">
                          <div className="relative">
                            <Input
                              type="number"
                              min="0"
                              max="100000"
                              step="0.001"
                              aria-label={"Hourly target for " + hourLabel(hour)}
                              title={t("hourTargetDescription")}
                              className="h-9 w-[105px] rounded-lg border-border/80 bg-background/75 pr-8 text-right font-bold tabular-nums"
                              placeholder="Mixed"
                              value={valueForHour(hour)}
                              readOnly={!data.canEdit}
                              disabled={savingHour === hour}
                              onChange={(event) => setDrafts((current) => ({ ...current, [hour]: event.target.value }))}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && dirty(hour)) void save(hour);
                                if (event.key === "Escape")
                                  setDrafts((current) => {
                                    const next = { ...current };
                                    delete next[hour];
                                    return next;
                                  });
                              }}
                            />
                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted-foreground">
                              KG
                            </span>
                          </div>
                          {data.canEdit && (
                            <Button
                              type="button"
                              size="icon"
                              variant={dirty(hour) ? "default" : "ghost"}
                              className={"h-8 w-8 shrink-0 rounded-lg " + (!dirty(hour) ? "opacity-30" : "")}
                              aria-label={"Save target for " + hourLabel(hour)}
                              title={t("saveHourTarget")}
                              disabled={!dirty(hour) || savingHour !== null}
                              onClick={() => void save(hour)}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                        {hourTarget === undefined && uniformBaseline === null && (
                          <span className="text-[10px] text-muted-foreground">{t("workerDefaults")}</span>
                        )}
                      </td>
                      {data.workers.map((worker) => {
                        const row = data.hours.find((item) => item.hourStart === hour && item.userId === worker.userId);
                        const kg = Number(row?.kg || 0);
                        // Sundays without an explicit or historical target are off,
                        // not 0/850 KG misses. Existing historical Sunday targets remain visible.
                        const scheduled = data.scheduledWorkday !== false || hourTarget !== undefined;
                        const target = scheduled ? (hourTarget ?? worker.targetKgPerHour) : 0;
                        const verdict = scheduled
                          ? resultStatus(kg, target, Number(row?.bales || 0), started, complete)
                          : "off";
                        const style = verdictStyle[verdict];
                        const percent = target > 0 ? Math.round((kg / target) * 100) : 0;
                        return (
                          <td key={worker.userId} className="border-b border-border/50 px-3 py-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <strong className="whitespace-nowrap tabular-nums">
                                {formatKg(kg)} / {scheduled ? formatKg(target) + " KG" : "Off"}
                              </strong>
                              <span className={"rounded-full px-2 py-1 text-[10px] font-semibold " + style.pill}>
                                {verdict === "upcoming" || verdict === "above" || verdict === "below"
                                  ? t(style.label as "upcoming" | "aboveTarget" | "belowTarget")
                                  : style.label}
                              </span>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <div
                                role="progressbar"
                                aria-label={worker.name + " at " + hourLabel(hour)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.min(100, Math.max(0, percent))}
                                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                              >
                                <div
                                  className={"h-full rounded-full transition-all " + style.bar}
                                  style={{ width: Math.min(100, Math.max(0, percent)) + "%" }}
                                />
                              </div>
                              <span className="w-9 shrink-0 text-right font-medium tabular-nums text-muted-foreground">
                                {target > 0 ? percent + "%" : "—"}
                              </span>
                            </div>
                            {complete &&
                              Number(row?.bales || 0) > 0 &&
                              verdict !== "met" &&
                              verdict !== "off" &&
                              verdict !== "zero" && (
                                <div
                                  className={
                                    "mt-1 text-[10px] " + (verdict === "above" ? "text-emerald-500" : "text-rose-500")
                                  }
                                >
                                  {formatKg(Math.abs(kg - target))} KG {verdict === "above" ? "over" : "short"}
                                </div>
                              )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {!hours.length && (
                  <tr>
                    <td colSpan={data.workers.length + 2} className="p-5 text-center text-muted-foreground">
                      {t("noProductionHours")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span>
              <TrendingUp className="mr-1 inline h-3.5 w-3.5 text-emerald-500" />
              Green = met/above · Red = below · Blue = in progress · Grey = no scans/upcoming
            </span>
            <span>
              {data.canEdit
                ? "Edit any hour, then click ✓ to save for the selected day."
                : "Targets are set by Admin / Owner."}
            </span>
          </div>
        </>
      )}
      <Dialog
        open={scheduleOpen}
        onOpenChange={(open) => {
          if (!savingSchedule) setScheduleOpen(open);
        }}
      >
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 overflow-hidden rounded-2xl border-border/70 bg-background p-0 shadow-2xl">
          <DialogHeader className="shrink-0 border-b border-border/60 bg-gradient-to-r from-sky-500/10 via-background to-violet-500/5 px-5 pb-4 pt-5">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <CalendarClock className="h-5 w-5 text-sky-500" />
              Weekly KG schedule
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Select Monday–Saturday and set each hour's KG target per worker. Save each day separately; it repeats
              every week from today in Beirut time. Sunday is excluded, and previous days retain their history.
            </DialogDescription>
          </DialogHeader>
          <PressingHourlyTargetsSection2
            savingSchedule={savingSchedule}
            selectedWeekday={selectedWeekday}
            setSelectedWeekday={setSelectedWeekday}
          />
          <PressingHourlyTargetsSection
            savingSchedule={savingSchedule}
            scheduleDrafts={scheduleDrafts}
            selectedWeekday={selectedWeekday}
            setScheduleDrafts={setScheduleDrafts}
          />
          <DialogFooter className="shrink-0 flex-row gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:justify-end">
            <Button type="button" variant="outline" disabled={savingSchedule} onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={savingSchedule || !data?.canEdit} onClick={() => void saveDailySchedule()}>
              {savingSchedule
                ? "Saving…"
                : "Save " + (SCHEDULE_DAYS.find((day) => day.id === selectedWeekday)?.name ?? "day") + " schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
