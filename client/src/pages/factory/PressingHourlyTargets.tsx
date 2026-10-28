import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Pencil, RefreshCw, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const ENDPOINT = "/api/factory/pressing-machines/report/hourly-targets";
const ZONE = "Asia/Beirut";
type Worker = { userId: string; slot: string; name: string; targetKgPerHour: number };
type HourRow = { hourStart: string; userId: string; kg: string; bales: number };
type HourlyResponse = {
  day: string; serverNow: string; canEdit: boolean;
  workers: Worker[]; hours: HourRow[];
};
const formatKg = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 3 });
function hourLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
}
// The production day is 07:00–17:00 in Beirut. The last hourly
// bucket starts at 16:00 and finishes at 17:00; never show 17:00–18:00.
function isPressingWorkHour(iso: string): boolean {
  const localHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, hour: "2-digit", hourCycle: "h23",
  }).format(new Date(iso)));
  return localHour >= 7 && localHour < 17;
}
function status(kg: number, target: number, complete: boolean, bales: number) {
  if (!complete) return { label: "In progress", cls: "text-sky-600 dark:text-sky-400" };
  if (!bales) return { label: "No scans", cls: "text-muted-foreground" };
  if (Math.abs(kg - target) < 0.001) return { label: "Met", cls: "text-emerald-600 dark:text-emerald-400" };
  return kg > target
    ? { label: "Above", cls: "text-emerald-600 dark:text-emerald-400" }
    : { label: "Below", cls: "text-rose-600 dark:text-rose-400" };
}

/** Compares completed, server-confirmed pressing hours. Hours without scans are neutral
 * because the simplified pressing system has no configured shifts or work schedules. */
export default function PressingHourlyTargets({ active, companyId, serverToday }: {
  active: boolean; companyId: number; serverToday?: string;
}) {
  const { toast } = useToast();
  const [day, setDay] = useState(serverToday || "");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDay(serverToday || ""); }, [companyId, serverToday]);
  const hourly = useQuery<HourlyResponse>({
    queryKey: [ENDPOINT, companyId, day],
    enabled: active && Boolean(day),
    queryFn: async () => {
      const response = await fetch(ENDPOINT + "?day=" + encodeURIComponent(day), {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load hourly targets (" + response.status + ")");
      return response.json() as Promise<HourlyResponse>;
    },
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: false,
  });
  const data = hourly.data;
  const now = data ? new Date(data.serverNow).getTime() : 0;
  // The UTC timestamps keep repeated Beirut DST hours separate.
  const hours = [...new Set((data?.hours || []).map(row => row.hourStart))]
    .filter(hour => new Date(hour).getTime() <= now && isPressingWorkHour(hour))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  async function save(worker: Worker) {
    const targetKgPerHour = Number(draft);
    if (!draft.trim() || !Number.isFinite(targetKgPerHour) ||
        targetKgPerHour <= 0 || targetKgPerHour > 100000) {
      toast({ title: "Invalid target", description: "Enter a target above 0 and at most 100,000 KG/hour.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: worker.userId, targetKgPerHour }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || "Could not save target");
      }
      setEditing(null);
      await hourly.refetch();
      toast({ title: "Hourly target saved", description: worker.name + ": " + formatKg(targetKgPerHour) + " KG/hour" });
    } catch (error) {
      toast({ title: "Target not saved", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-4" data-testid="pressing-hourly-targets">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold"><Target className="h-4 w-4 text-primary" />Hourly KG targets</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            07:00–17:00 Beirut time · confirmed scans only · target per worker
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input aria-label="Hourly target date" type="date" max={serverToday}
            className="h-8 w-[145px] text-xs" value={day}
            onChange={event => setDay(event.target.value)} />
          <Button size="sm" variant="outline" className="h-8" disabled={hourly.isFetching}
            onClick={() => void hourly.refetch()}>
            <RefreshCw className={"h-3.5 w-3.5 " + (hourly.isFetching ? "animate-spin" : "")} />
            <span className="sr-only">Refresh hourly targets</span>
          </Button>
        </div>
      </div>
      {hourly.isError && <p role="alert" className="text-sm text-destructive">Could not load hourly targets. Try Refresh.</p>}
      {hourly.isLoading && <p className="text-sm text-muted-foreground">Loading hourly production…</p>}
      {data && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {data.workers.map(worker => (
              <div key={worker.userId} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs">
                <span className="font-semibold">{worker.name}</span>
                {editing === worker.userId ? (
                  <>
                    <Input type="number" aria-label={"KG per hour target for " + worker.name}
                      min="0.001" max="100000" step="0.001" className="h-7 w-24 text-xs"
                      value={draft} onChange={event => setDraft(event.target.value)} />
                    <span>KG/hr</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={saving}
                      aria-label={"Save target for " + worker.name} onClick={() => void save(worker)}><Check className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={saving}
                      aria-label="Cancel target edit" onClick={() => setEditing(null)}><X className="h-3.5 w-3.5" /></Button>
                  </>
                ) : (
                  <>
                    <span className="tabular-nums text-muted-foreground">{formatKg(worker.targetKgPerHour)} KG/hr</span>
                    {data.canEdit && <Button size="icon" variant="ghost" className="h-6 w-6"
                      aria-label={"Edit target for " + worker.name}
                      onClick={() => { setEditing(worker.userId); setDraft(String(worker.targetKgPerHour)); }}>
                      <Pencil className="h-3 w-3" /></Button>}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="max-h-[310px] overflow-auto rounded-lg border">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">Hour (Beirut)</th>
                  {data.workers.map(worker => <th scope="col" key={worker.userId} className="px-3 py-2 font-semibold">{worker.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {hours.map(hour => {
                  const complete = new Date(hour).getTime() + 3600000 <= now;
                  return <tr key={hour} className="border-t">
                    <th scope="row" className="whitespace-nowrap px-3 py-2 font-medium tabular-nums">{hourLabel(hour)}</th>
                    {data.workers.map(worker => {
                      const row = data.hours.find(item => item.hourStart === hour && item.userId === worker.userId);
                      const kg = Number(row?.kg || 0);
                      const verdict = status(kg, worker.targetKgPerHour, complete, Number(row?.bales || 0));
                      return <td key={worker.userId} className="px-3 py-2">
                        <div className="whitespace-nowrap font-semibold tabular-nums">{formatKg(kg)} / {formatKg(worker.targetKgPerHour)} KG</div>
                        <div className={"mt-0.5 font-medium " + verdict.cls}>
                          {verdict.label}{complete && Number(row?.bales || 0) > 0
                            ? " · " + formatKg(Math.abs(kg - worker.targetKgPerHour)) + " KG " +
                              (verdict.label === "Above" ? "over" : verdict.label === "Below" ? "short" : "difference")
                            : ""}
                        </div>
                      </td>;
                    })}
                  </tr>;
                })}
                {!hours.length && <tr><td colSpan={data.workers.length + 1} className="p-4 text-center text-muted-foreground">No working hours (07:00–17:00 Beirut) to show for this date.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Green: met/above target · Red: below target · No scans: not assessed (no shift schedule). Current hour is in progress.
          </p>
        </>
      )}
    </section>
  );
}
