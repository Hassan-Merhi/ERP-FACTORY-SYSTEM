import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Check, RefreshCw, Target, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePressingUiText } from "@/i18n/pressingUiTranslations";

const ENDPOINT = "/api/factory/pressing-machines/report/hourly-targets";
const ZONE = "Asia/Beirut";
type Worker = { userId: string; slot: string; name: string; targetKgPerHour: number };
type HourRow = { hourStart: string; userId: string; kg: string; bales: number };
type HourlyResponse = {
  day: string; serverNow: string; canEdit: boolean;
  workers: Worker[]; hours: HourRow[];
  hourlyTargetsKg: Record<string, number>;
};
const formatKg = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 3 });
function localHour(iso: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, hour: "2-digit", hourCycle: "h23",
  }).format(new Date(iso)));
}
function hourLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: ZONE, hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "shortOffset",
  });
}
type Verdict = "upcoming" | "progress" | "none" | "met" | "above" | "below";
function resultStatus(kg: number, target: number, bales: number, started: boolean, complete: boolean): Verdict {
  if (!started) return "upcoming";
  if (!complete) return "progress";
  if (!bales) return "none";
  if (Math.abs(kg - target) < 0.001) return "met";
  return kg > target ? "above" : "below";
}
const verdictStyle: Record<Verdict, { label: string; pill: string; bar: string }> = {
  upcoming: { label: "upcoming", pill: "bg-slate-500/10 text-slate-500", bar: "bg-slate-500" },
  progress: { label: "In progress", pill: "bg-sky-500/15 text-sky-600 dark:text-sky-300", bar: "bg-sky-500" },
  none: { label: "No scans", pill: "bg-slate-500/15 text-muted-foreground", bar: "bg-slate-500" },
  met: { label: "Target met", pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500" },
  above: { label: "aboveTarget", pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500" },
  below: { label: "belowTarget", pill: "bg-rose-500/15 text-rose-700 dark:text-rose-300", bar: "bg-rose-500" },
};

/** Confirmed scans only; editable date-scoped hour targets are shared by P1/P2/P3.
 * No active shift schedule exists, so zero-scan completed hours stay neutral. */
export default function PressingHourlyTargets({ active, companyId, serverToday }: {
  active: boolean; companyId: number; serverToday?: string;
}) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof translatePressingUiText>[0]) => translatePressingUiText(key, language);
  const [day, setDay] = useState(serverToday || "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingHour, setSavingHour] = useState<string | null>(null);
  useEffect(() => { setDay(serverToday || ""); setDrafts({}); }, [companyId, serverToday]);
  useEffect(() => { setDrafts({}); }, [day]);
  const hourly = useQuery<HourlyResponse>({
    queryKey: [ENDPOINT, companyId, day],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ENDPOINT + (day ? "?day=" + encodeURIComponent(day) : ""), {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load hourly targets (" + response.status + ")");
      return response.json() as Promise<HourlyResponse>;
    },
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: false,
  });
  const data = hourly.data;
  const serverDate = data?.serverNow
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(data.serverNow))
    : [];
  const datePart = (type: string) => serverDate.find(part => part.type === type)?.value;
  const maxDay = serverToday || (serverDate.length
    ? [datePart("year"), datePart("month"), datePart("day")].join("-")
    : undefined);
  const now = data ? new Date(data.serverNow).getTime() : 0;
  // Keep all ten production hours visible (including upcoming hours) so every
  // daily target can be entered in advance. DST transitions use true instants.
  const hours = [...new Set((data?.hours || []).map(row => row.hourStart))]
    .filter(hour => localHour(hour) >= 7 && localHour(hour) < 17)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  const configured = (hour: string) => data?.hourlyTargetsKg?.[String(localHour(hour))];
  const baseline = (data?.workers || []).map(worker => worker.targetKgPerHour);
  const uniformBaseline = baseline.length && baseline.every(v => v === baseline[0]) ? baseline[0] : null;
  const targetText = (hour: string) => {
    const value = configured(hour);
    return value !== undefined ? String(value) : uniformBaseline !== null ? String(uniformBaseline) : "";
  };
  const valueForHour = (hour: string) => drafts[hour] ?? targetText(hour);
  const dirty = (hour: string) => drafts[hour] !== undefined &&
    drafts[hour] !== targetText(hour);

  async function save(hour: string) {
    if (!data?.canEdit || savingHour) return;
    const raw = valueForHour(hour);
    const targetKgPerHour = Number(raw);
    if (!raw.trim() || !Number.isFinite(targetKgPerHour) ||
        targetKgPerHour <= 0 || targetKgPerHour > 100000) {
      toast({ title: "Invalid target", description: t("invalidTargetDescription"), variant: "destructive" });
      return;
    }
    setSavingHour(hour);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: data.day, hour: localHour(hour), targetKgPerHour }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || "Could not save hourly target");
      }
      await hourly.refetch();
      setDrafts(current => { const next = { ...current }; delete next[hour]; return next; });
      toast({ title: "Hourly target saved", description: hourLabel(hour) + " — " + formatKg(targetKgPerHour) + " KG per worker" });
    } catch (error) {
      toast({ title: "Target not saved", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally { setSavingHour(null); }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-sky-500/[0.035] shadow-[0_12px_38px_-22px_rgba(14,165,233,0.25)]"
      data-testid="pressing-hourly-targets">
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
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="hidden h-4 w-4 text-muted-foreground sm:block" />
          <Input aria-label="Hourly target date" type="date" max={maxDay}
            className="h-9 w-[150px] rounded-lg border-border/70 bg-background/70 text-xs" value={day || data?.day || ""}
            onChange={event => setDay(event.target.value)} />
          <Button size="sm" variant="outline" className="h-9 rounded-lg" disabled={hourly.isFetching}
            onClick={() => void hourly.refetch()}>
            <RefreshCw className={"h-3.5 w-3.5 " + (hourly.isFetching ? "animate-spin" : "")} />
            <span className="sr-only">Refresh hourly targets</span>
          </Button>
        </div>
      </div>
      {hourly.isError && <p role="alert" className="p-4 text-sm text-destructive">Could not load hourly targets. Try Refresh.</p>}
      {hourly.isLoading && <p className="p-4 text-sm text-muted-foreground">Loading hourly production…</p>}
      {data && (
        <>
          <div className="overflow-x-auto p-3 sm:p-4">
            <table className="w-full min-w-[840px] border-separate border-spacing-0 text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="bg-muted/50">
                  <th scope="col" className="rounded-l-lg px-3 py-3 font-semibold">Hour (Beirut)</th>
                  <th scope="col" className="w-[178px] px-3 py-3 font-semibold">{t("hourTargetHeader")}</th>
                  {data.workers.map(worker => <th scope="col" key={worker.userId} className="min-w-[200px] px-3 py-3 font-semibold">{worker.name}</th>)}
                  {data.workers.length === 0 && <th className="rounded-r-lg px-3 py-3">{t("noWorkersConfigured")}</th>}
                </tr>
              </thead>
              <tbody>
                {hours.map(hour => {
                  const started = new Date(hour).getTime() <= now;
                  const complete = new Date(hour).getTime() + 3600000 <= now;
                  const hourTarget = configured(hour);
                  return <tr key={hour} className="group transition-colors hover:bg-sky-500/[0.035]">
                    <th scope="row" className="whitespace-nowrap border-b border-border/50 px-3 py-3 font-bold tabular-nums">{hourLabel(hour)}</th>
                    <td className="border-b border-border/50 px-3 py-2">
                      <div className="flex items-center gap-1">
                        <div className="relative">
                          <Input type="number" min="0.001" max="100000" step="0.001"
                            aria-label={"Hourly target for " + hourLabel(hour)}
                            title={t("hourTargetDescription")}
                            className="h-9 w-[105px] rounded-lg border-border/80 bg-background/75 pr-8 text-right font-bold tabular-nums"
                            placeholder="Mixed" value={valueForHour(hour)}
                            readOnly={!data.canEdit} disabled={savingHour === hour}
                            onChange={event => setDrafts(current => ({ ...current, [hour]: event.target.value }))}
                            onKeyDown={event => {
                              if (event.key === "Enter" && dirty(hour)) void save(hour);
                              if (event.key === "Escape") setDrafts(current => {
                                const next = { ...current }; delete next[hour]; return next;
                              });
                            }} />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted-foreground">KG</span>
                        </div>
                        {data.canEdit && <Button type="button" size="icon" variant={dirty(hour) ? "default" : "ghost"}
                          className={"h-8 w-8 shrink-0 rounded-lg " + (!dirty(hour) ? "opacity-30" : "")}
                          aria-label={"Save target for " + hourLabel(hour)} title={t("saveHourTarget")}
                          disabled={!dirty(hour) || savingHour !== null}
                          onClick={() => void save(hour)}><Check className="h-4 w-4" /></Button>}
                      </div>
                      {hourTarget === undefined && uniformBaseline === null && (
                        <span className="text-[10px] text-muted-foreground">{t("workerDefaults")}</span>
                      )}
                    </td>
                    {data.workers.map(worker => {
                      const row = data.hours.find(item => item.hourStart === hour && item.userId === worker.userId);
                      const kg = Number(row?.kg || 0);
                      const target = hourTarget ?? worker.targetKgPerHour;
                      const verdict = resultStatus(kg, target, Number(row?.bales || 0), started, complete);
                      const style = verdictStyle[verdict];
                      const percent = target > 0 ? Math.round(kg / target * 100) : 0;
                      return <td key={worker.userId} className="border-b border-border/50 px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <strong className="whitespace-nowrap tabular-nums">{formatKg(kg)} / {formatKg(target)} KG</strong>
                          <span className={"rounded-full px-2 py-1 text-[10px] font-semibold " + style.pill}>{verdict === "upcoming" || verdict === "above" || verdict === "below" ? t(style.label as "upcoming" | "aboveTarget" | "belowTarget") : style.label}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <div role="progressbar" aria-label={worker.name + " at " + hourLabel(hour)}
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, percent))}
                            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className={"h-full rounded-full transition-all " + style.bar}
                              style={{ width: Math.min(100, Math.max(0, percent)) + "%" }} />
                          </div>
                          <span className="w-9 shrink-0 text-right font-medium tabular-nums text-muted-foreground">{percent}%</span>
                        </div>
                        {complete && Number(row?.bales || 0) > 0 && verdict !== "met" && (
                          <div className={"mt-1 text-[10px] " + (verdict === "above" ? "text-emerald-500" : "text-rose-500")}>
                            {formatKg(Math.abs(kg - target))} KG {verdict === "above" ? "over" : "short"}
                          </div>
                        )}
                      </td>;
                    })}
                  </tr>;
                })}
                {!hours.length && <tr><td colSpan={data.workers.length + 2}
                  className="p-5 text-center text-muted-foreground">{t("noProductionHours")}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span><TrendingUp className="mr-1 inline h-3.5 w-3.5 text-emerald-500" />Green = met/above · Red = below · Blue = in progress · Grey = no scans/upcoming</span>
            <span>{data.canEdit ? "Edit any hour, then click ✓ to save for the selected day." : "Targets are set by Admin / Owner."}</span>
          </div>
        </>
      )}
    </section>
  );
}
