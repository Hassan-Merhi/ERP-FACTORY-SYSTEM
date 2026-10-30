import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Calculator, Loader2, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
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

interface CategoryReviewRecord {
  id: number;
  workerId: number;
  status: "approved" | "rejected";
  amount: string;
  snapshot: unknown;
  snapshotHash: string;
  reviewedAt: string;
  reviewedBy: string;
  note: string | null;
}
interface CategoryReviewsResponse {
  date: string;
  reviews: CategoryReviewRecord[];
  approvalDoesNotPost: true;
}
async function fetchCategoryReviews(date: string): Promise<CategoryReviewsResponse> {
  const response = await factoryApiRequest(
    "GET", "/api/factory/production-target-bonuses/category-reviews?" +
      new URLSearchParams({date}).toString(),
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Could not load category review history");
  }
  return response.json() as Promise<CategoryReviewsResponse>;
}

/** Phase 10 proposal with Phase 11 immutable category review confirmation.
 * A category decision remains audit-only; Phase 12+ must validate payment.
 */
export function ProductionBonusCategoryPreviewPanel({initialDate}: {initialDate:string}) {
  const [date,setDate]=useState(initialDate);
  const [decision,setDecision]=useState<{workerId:number;status:"approved"|"rejected"}|null>(null);
  const [reviewNote,setReviewNote]=useState("");
  const {toast}=useToast();
  useEffect(()=>{setDate(initialDate);setDecision(null);},[initialDate]);
  const valid=isBonusCategoryDate(date);
  const {data,isLoading,error}=useQuery<CategoryBonusDayProposal>({
    queryKey:["/api/factory/production-target-bonuses/category-preview",date],
    enabled:valid,
    queryFn:()=>fetchProposal(date),
  });
  const {data:existingReviews,error:reviewsError}=useQuery<CategoryReviewsResponse>({
    queryKey:["/api/factory/production-target-bonuses/category-reviews",date],
    enabled:valid,
    queryFn:()=>fetchCategoryReviews(date),
  });
  const reviewByWorker=new Map((existingReviews?.reviews??[]).map(row=>[row.workerId,row]));
  const selectedWorker=data?.workers.find(item=>item.workerId===decision?.workerId);
  const mutation=useMutation({
    mutationFn:async()=>{
      if(!decision || !selectedWorker || !selectedWorker.reviewToken)
        throw new Error("Refresh the calculation before deciding");
      const response=await factoryApiRequest(
        "POST","/api/factory/production-target-bonuses/category-reviews/decide",{
          date,workerId:selectedWorker.workerId,decision:decision.status,
          expectedAmount:selectedWorker.proposedBonusUsd,
          reviewToken:selectedWorker.reviewToken,confirm:true,note:reviewNote,
        },
      );
      if(!response.ok){
        const body=await response.json().catch(()=>({}));
        throw new Error(body.message||"Could not save category review");
      }
      return response.json() as Promise<{replayed:boolean}>;
    },
    onSuccess:(saved)=>{
      toast({title:saved.replayed?"Category review already saved":"Category review recorded",
        description:"Immutable decision recorded. No payment or accounting posting occurred."});
      setDecision(null);setReviewNote("");
      void queryClient.invalidateQueries({queryKey:["/api/factory/production-target-bonuses/category-reviews",date]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/production-target-bonuses/category-preview",date]});
    },
    onError:(error:Error)=>toast({title:"Category review was not saved",
      description:error.message,variant:"destructive"}),
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
          value={date} onChange={e=>{setDate(e.target.value);setDecision(null);}} />
      </label>
      {!valid&&<p className="text-sm text-destructive" role="alert">Choose a valid date.</p>}
      {error&&<p className="text-sm text-destructive" role="alert">{(error as Error).message}</p>}
      {reviewsError&&<p className="text-sm text-destructive" role="alert">{(reviewsError as Error).message}</p>}
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
                <th className="px-3 py-2 text-right">Review</th>
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
                  <td className="px-3 py-2 text-right">
                    {reviewByWorker.has(worker.workerId)
                      ? <span className="text-xs font-medium">
                          {reviewByWorker.get(worker.workerId)?.status === "approved"
                            ? "Approved · not paid" : "Rejected"}
                        </span>
                      : !worker.blocked && worker.reviewToken && !reviewsError
                        ? <div className="flex justify-end gap-1">
                            <Button type="button" size="sm" variant="outline"
                              onClick={()=>{setReviewNote("");setDecision({workerId:worker.workerId,status:"rejected"});}}>
                              Reject
                            </Button>
                            <Button type="button" size="sm"
                              onClick={()=>{setReviewNote("");setDecision({workerId:worker.workerId,status:"approved"});}}>
                              Approve
                            </Button>
                          </div>
                        : <span className="text-xs text-muted-foreground">Unavailable</span>}
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
                  <td className="px-3 py-2 text-right">—</td>
                </tr>)}
                {worker.reasons.length>0&&<tr key={"reason:"+worker.workerId} className="border-t">
                  <td colSpan={7} className="px-3 py-2 text-xs text-destructive" role="status">
                    Not payable: {worker.reasons.map(s=>s.replaceAll("_"," ")).join(", ")}.
                  </td>
                </tr>}
              </Fragment>)}
              {data.workers.length===0&&<tr>
                <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">No finalized workers for this date.</td>
              </tr>}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Category amounts retain six decimals before worker/day total rounding to cents.
          Category approvals are audit records only and cannot post a payment.
        </p>
      </>}
      <AlertDialog open={decision!==null} onOpenChange={open=>{if(!open&&!mutation.isPending)setDecision(null);}}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm category bonus {decision?.status==="approved"?"approval":"rejection"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedWorker?.workerName||"Selected worker"} · {date} ·
              {" $"}{selectedWorker?.proposedBonusUsd||"0.00"} USD.
              This permanently records the reviewed category breakdown and rate
              versions. It does not create a voucher or pay the worker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="space-y-1 text-sm">Review note (optional)
            <Input aria-label="Category bonus review note" maxLength={500}
              value={reviewNote} onChange={e=>setReviewNote(e.target.value)} />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending||!selectedWorker?.reviewToken}
              onClick={event=>{event.preventDefault();mutation.mutate();}}>
              {mutation.isPending?"Saving decision…":"Confirm decision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  </details>;
}
