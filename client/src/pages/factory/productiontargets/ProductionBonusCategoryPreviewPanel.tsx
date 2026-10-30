import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calculator, Loader2, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { factoryApiRequest } from "@/lib/factoryApi";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import type { CategoryBonusDayProposal } from "@shared/productionTargetBonusCategoryCalculation";

async function fetchProposal(date: string): Promise<CategoryBonusDayProposal> {
  const response = await factoryApiRequest(
    "GET", "/api/factory/production-target-bonuses/category-preview?" +
      new URLSearchParams({date}).toString(),
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Could not calculate category bonus proposal");
  }
  return response.json() as Promise<CategoryBonusDayProposal>;
}

/** Phase 10 is exclusively a read-only amount calculator. The pre-existing
 * worker/day approval and accounting screens remain unchanged and must not
 * silently begin treating this proposal as an approved payable.
 */
export function ProductionBonusCategoryPreviewPanel({initialDate}: {initialDate:string}) {
  const [date,setDate]=useState(initialDate);
  useEffect(()=>setDate(initialDate),[initialDate]);
  const valid=isBonusCategoryDate(date);
  const {data,isLoading,error}=useQuery<CategoryBonusDayProposal>({
    queryKey:["/api/factory/production-target-bonuses/category-preview",date],
    enabled:valid,
    queryFn:()=>fetchProposal(date),
  });
  return <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-category-preview">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
      <Calculator className="mr-2 inline h-4 w-4" />
      Category bonus calculation — preview only
    </summary>
    <div className="space-y-3 border-t px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Proposed bonus by worker and category, using the category credits and
        one daily target allocation captured for the production date.
        The dollar rate is the version effective on that date.
        This preview cannot approve, pay, or post a bonus.
      </p>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Production date
        <Input type="date" aria-label="Bonus category preview date" className="w-[170px]"
          value={date} onChange={e=>setDate(e.target.value)} />
      </label>
      {!valid&&<p className="text-sm text-destructive" role="alert">Choose a valid date.</p>}
      {error&&<p className="text-sm text-destructive" role="alert">{(error as Error).message}</p>}
      {isLoading&&<p className="text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin"/> Calculating frozen category credits…
      </p>}
      {data&&<>
        <div className="flex flex-wrap gap-4 text-sm">
          <span><strong className="tabular-nums">{data.totalProposedBonusUsd} USD</strong> proposed</span>
          <span className="tabular-nums">{data.workers.length} workers</span>
          <span className={data.blockedWorkerCount?"text-destructive":"text-muted-foreground"}>
            {data.blockedWorkerCount} blocked
          </span>
        </div>
        {!data.evidenceVerified&&<p className="flex items-start gap-2 text-xs text-destructive" role="alert">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0"/>
          Frozen category evidence is incomplete. Proposed worker amounts are blocked until reconciled.
        </p>}
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2">Worker / category</th>
                <th className="px-3 py-2 text-right">Credited</th>
                <th className="px-3 py-2 text-right">Target</th>
                <th className="px-3 py-2 text-right">Extra</th>
                <th className="px-3 py-2 text-right">Rate / bale</th>
                <th className="px-3 py-2 text-right">Proposed USD</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map(worker=><Fragment key={worker.workerId}>
                <tr key={"worker:"+worker.workerId} className="border-t bg-muted/20">
                  <td className="px-3 py-2 font-medium">
                    {worker.workerName||"Worker #"+worker.workerId}
                    {worker.blocked&&<span className="ml-2 text-xs font-normal text-destructive">Blocked</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{worker.creditedBales}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{worker.targetBales??"—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{worker.extraBales}</td>
                  <td className="px-3 py-2 text-right">—</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {worker.proposedBonusUsd}
                  </td>
                </tr>
                {worker.lines.map(line=><tr key={worker.workerId+":"+line.categoryKey} className="border-t">
                  <td className="px-3 py-2 pl-6">{line.categoryLabel}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.creditedBales}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.targetBales}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.extraBales}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.ratePerExtraBaleUsd===null?"Not set":"$"+line.ratePerExtraBaleUsd}
                    {line.issue&&<span className="block text-xs text-destructive">{line.issue.replaceAll("_"," ")}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.unroundedBonusUsd}</td>
                </tr>)}
                {worker.reasons.length>0&&<tr key={"reason:"+worker.workerId} className="border-t">
                  <td colSpan={6} className="px-3 py-2 text-xs text-destructive" role="status">
                    Not payable: {worker.reasons.map(s=>s.replaceAll("_"," ")).join(", ")}.
                  </td>
                </tr>}
              </Fragment>)}
              {data.workers.length===0&&<tr>
                <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No finalized workers for this date.</td>
              </tr>}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Category amounts retain six decimals before worker/day total rounding to cents.
          An existing daily review blocks a second category-based proposal.
        </p>
      </>}
    </div>
  </details>;
}
