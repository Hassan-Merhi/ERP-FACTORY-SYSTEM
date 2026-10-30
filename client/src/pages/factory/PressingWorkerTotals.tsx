import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rankPressingWorkers, type PressingStanding, type PressingWorkerTotal } from "./pressingWorkerRanking";

const ROOT = "/api/factory/pressing-machines/report";

interface WorkerTotalsResponse {
  day: string;
  serverToday: string;
  workers: PressingWorkerTotal[];
}
const formatCount = (value: number) => value.toLocaleString();
const formatKg = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });

const standingStyles: Record<PressingStanding, {
  row: string; name: string; kg: string; badge: string; label: string;
}> = {
  leading: {
    row: "bg-emerald-500/5",
    name: "text-base font-extrabold text-emerald-700 dark:text-emerald-400",
    kg: "text-xl font-extrabold text-emerald-700 dark:text-emerald-400",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    label: "Leading",
  },
  middle: {
    row: "bg-amber-500/5",
    name: "text-base font-bold text-amber-700 dark:text-amber-400",
    kg: "text-lg font-bold text-amber-700 dark:text-amber-400",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    label: "Middle",
  },
  lowest: {
    row: "bg-rose-500/5",
    name: "text-lg font-extrabold text-rose-700 dark:text-rose-400",
    kg: "text-xl font-extrabold text-rose-700 dark:text-rose-400",
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    label: "Lowest",
  },
  unranked: {
    row: "",
    name: "text-base font-semibold",
    kg: "text-lg font-bold",
    badge: "border-border bg-muted text-muted-foreground",
    label: "No scans",
  },
};

/** Workers see colleague totals, never another worker's individual bale history. */
export default function PressingWorkerTotals({ active, companyId, userId }: {
  active: boolean; companyId: number; userId: string;
}) {
  const [day, setDay] = useState("");
  const totals = useQuery<WorkerTotalsResponse>({
    queryKey: [ROOT, "worker-totals", companyId, userId, day],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ROOT + "/worker-totals" + (day ? "?day=" + encodeURIComponent(day) : ""), {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load pressing worker totals");
      return response.json() as Promise<WorkerTotalsResponse>;
    },
    staleTime: 15000,
    // Only refresh the small aggregate, not the page or scanner camera.
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: false,
  });
  const workers = totals.data?.workers ?? [];
  const rankedWorkers = rankPressingWorkers(workers);
  const totalBales = workers.reduce((sum, worker) => sum + Number(worker.totalBales || 0), 0);
  const totalKg = workers.reduce((sum, worker) => sum + Number(worker.totalKg || 0), 0);

  return (
    <section className="min-w-0 space-y-3" data-testid="pressing-worker-totals">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Scanned Bales by Worker</h3>
          <p className="text-xs text-muted-foreground">Daily confirmed scans (Beirut time) · ranked by KG</p>
        </div>
        <div className="flex items-center gap-2">
          <Input aria-label="Scanned bales date" type="date"
            data-testid="input-pressing-worker-date"
            max={totals.data?.serverToday}
            className="h-9 w-[145px] text-xs"
            value={day || totals.data?.day || ""}
            onChange={event => setDay(event.target.value)} />
          <Button type="button" size="sm" variant="outline"
            data-testid="button-refresh-pressing-totals"
            disabled={totals.isFetching}
            onClick={() => void totals.refetch()}>
            <RefreshCw className="mr-1 h-4 w-4" />Refresh
          </Button>
        </div>
      </div>
      {totals.isLoading && <p className="text-sm text-muted-foreground">Loading worker totals…</p>}
      {totals.isError && (
        <p role="alert" className="text-sm text-destructive">
          {totals.error instanceof Error ? totals.error.message : "Could not load worker totals"}
        </p>
      )}
      {!totals.isLoading && !totals.isError && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[550px] text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="p-3 font-medium">Worker</th>
                <th scope="col" className="p-3 text-right font-medium">Total Bales</th>
                <th scope="col" className="p-3 text-right font-medium">Total KG</th>
              </tr>
            </thead>
            <tbody>
              {rankedWorkers.map(worker => {
                const style = standingStyles[worker.standing];
                return (
                  <tr key={worker.userId} data-testid={"pressing-worker-row-" + worker.userId}
                    className={"border-t " + style.row}>
                    <td className="min-w-[210px] p-3">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={style.name}>{worker.name?.trim() || "Display name not set"}</span>
                        {worker.userId === userId && <span className="text-xs font-normal text-muted-foreground">(You)</span>}
                        <span className={"rounded-full border px-2 py-0.5 text-xs font-semibold " + style.badge}>
                          {style.label}
                        </span>
                      </div>
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums">{formatCount(Number(worker.totalBales || 0))}</td>
                    <td className={"p-3 text-right tabular-nums " + style.kg}>{formatKg(Number(worker.totalKg || 0))}</td>
                  </tr>
                );
              })}
              {!workers.length && (
                <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No pressing workers yet.</td></tr>
              )}
            </tbody>
            <tfoot className="border-t bg-muted/50 font-semibold">
              <tr>
                <td className="p-3">Total</td>
                <td className="p-3 text-right tabular-nums">{formatCount(totalBales)}</td>
                <td className="p-3 text-right tabular-nums">{formatKg(totalKg)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
