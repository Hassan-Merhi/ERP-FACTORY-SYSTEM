import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Loader2, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { factoryApiRequest } from "@/lib/factoryApi";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import type { WeeklyFlatBonusProposal } from "@shared/productionTargetBonusWeeklyCalculation";

const endpoint = "/api/factory/production-target-bonuses/weekly-preview";
type PreviewResponse = WeeklyFlatBonusProposal & { dayCount: number; note: string };
async function load(weekOf: string): Promise<PreviewResponse> {
  const response = await factoryApiRequest("GET", endpoint + "?" + new URLSearchParams({ weekOf }).toString());
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Could not calculate weekly flat bonus preview");
  }
  return response.json() as Promise<PreviewResponse>;
}
const formatReason = (issue: string) => issue.replaceAll("_", " ").toLowerCase();

/** Read-only Phase 13 eligibility preview; no approval or posting controls. */
export function ProductionBonusWeeklyPreviewPanel({ initialDate }: { initialDate: string }) {
  const [weekOf, setWeekOf] = useState(initialDate);
  useEffect(() => setWeekOf(initialDate), [initialDate]);
  const valid = isBonusCategoryDate(weekOf);
  const { data, error, isLoading } = useQuery<PreviewResponse>({
    queryKey: [endpoint, weekOf],
    queryFn: () => load(weekOf),
    enabled: valid,
  });
  const totalEligible = data?.workers.filter(worker => worker.eligible).length ?? 0;
  return (
    <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-weekly-preview">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <CalendarRange className="mr-2 inline h-4 w-4" /> Weekly flat bonus eligibility — preview only
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs text-muted-foreground">
          A worker earns the same fixed bonus for 1 or 30 extra bales above their total weekly target.
          Linked production is credited once per worker; category changes are combined, not paid separately.
          An absent day with no production is excluded from that worker's target.
          Only a completed Monday–Sunday week with frozen, reconciled production evidence can qualify.
          This screen cannot approve or pay anyone.
        </p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Select a date in the week
          <Input type="date" aria-label="Weekly flat bonus preview date" className="w-[170px]"
            value={weekOf} onChange={event => setWeekOf(event.target.value)} />
        </label>
        {!valid && <p role="alert" className="text-sm text-destructive">Choose a valid date.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Checking finalized weekly evidence…
        </p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3 text-sm">
              <span className="font-medium">{data.weekStart} to {data.weekEnd}</span>
              <span>{data.dayCount} saved production days</span>
              <span>{data.totalCreditedBales} credited bales</span>
              <span>{totalEligible} eligible workers</span>
              <span className="font-semibold tabular-nums">USD {data.totalProposedBonusUsd} proposed</span>
              <Badge variant="secondary">Preview · not payable</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Selected method: {data.method === "weekly_flat" ? "Weekly flat bonus" : "Per extra bale (existing)"}
              {data.method === "weekly_flat" && " · USD " + data.flatBonusUsd + " per eligible worker per week"}
              . Settings version: {data.methodVersionId ?? "default"}.
            </p>
            {data.globalIssues.length > 0 && <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Weekly amounts are blocked: {data.globalIssues.map(formatReason).join(", ")}.
              Complete or reconcile the source evidence before attempting a future review.
            </p>}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Worker</th>
                    <th className="px-3 py-2 text-right">Weekly target</th>
                    <th className="px-3 py-2 text-right">Credited</th>
                    <th className="px-3 py-2 text-right">Extra</th>
                    <th className="px-3 py-2 text-right">Flat bonus USD</th>
                    <th className="px-3 py-2">Eligibility</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workers.map(worker => <tr key={worker.workerId} className="border-t align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{worker.workerName}</p>
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Daily and category details</summary>
                        <div className="mt-1 space-y-1">
                          {worker.dayBreakdown.map(day => (
                            <p key={day.date}>{day.date}: {day.creditedBales} bales, target {day.targetBales ?? "none"}, {day.status}</p>
                          ))}
                          <p>Categories: {worker.categories.map(item =>
                            item.categoryLabel + " (" + item.creditedBales + ")").join(", ") || "None"}</p>
                        </div>
                      </details>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.targetBales}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.creditedBales}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.extraBales}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{worker.proposedBonusUsd}</td>
                    <td className="px-3 py-2">
                      {worker.eligible ? <Badge>Exceeds target · proposal</Badge> :
                        worker.blocked ? <Badge variant="destructive">Blocked</Badge> :
                          <Badge variant="secondary">Target not exceeded</Badge>}
                      {worker.reasons.length > 0 &&
                        <p className="mt-1 max-w-[260px] text-xs text-destructive">
                          {worker.reasons.map(formatReason).join(", ")}
                        </p>}
                    </td>
                  </tr>)}
                  {data.workers.length === 0 && <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                      No worker production found in the selected week.
                    </td>
                  </tr>}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{data.note}</p>
          </>
        )}
      </div>
    </details>
  );
}
