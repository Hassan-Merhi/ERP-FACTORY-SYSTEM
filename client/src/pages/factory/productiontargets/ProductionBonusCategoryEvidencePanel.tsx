import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardList, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";

interface CategoryCredit {
  categoryKey: string; categoryLabel: string; creditedBales: number;
  firstFinalizedAt: string | null; lastFinalizedAt: string | null;
}
interface WorkerEvidence {
  workerId: number; workerName?: string; dailyTargetBales: number | null; savedProducedBales: number;
  creditedBales: number; categories: CategoryCredit[]; issues: string[];
}
interface EvidenceResponse {
  productionDate: string; finalized: boolean; captured: boolean;
  sourceBales: number; creditedBales: number; readyForTargetAllocation: boolean;
  workers: WorkerEvidence[]; issues: string[];
  allocations: Array<{
    workerId: number; categoryKey: string; categoryLabel: string;
    creditedBales: number; targetBales: number; allocatedAt: string;
  }>;
}
const evidenceEndpoint = "/api/factory/production-target-bonuses/category-evidence";
const splitEndpoint = "/api/factory/production-target-bonuses/category-targets";
async function request<T>(method: "GET"|"POST", url: string, body?: unknown):Promise<T> {
  const response = await factoryApiRequest(method,url,body);
  if (!response.ok) {
    const payload=await response.json().catch(()=>({}));
    throw new Error(payload.message ?? "Category evidence request failed");
  }
  return response.json() as Promise<T>;
}

/** Category attribution is based on finalized bale snapshots, not the
 * worker's single day-end display category or currently editable stock. */
export function ProductionBonusCategoryEvidencePanel({ initialDate }: {initialDate:string}) {
  const {toast}=useToast();
  const [date,setDate]=useState(initialDate);
  const [worker,setWorker]=useState<WorkerEvidence|null>(null);
  const [targets,setTargets]=useState<Record<string,string>>({});
  useEffect(()=>{setDate(initialDate);setWorker(null);},[initialDate]);
  const validDate=isBonusCategoryDate(date);
  const {data,isLoading,error}=useQuery<EvidenceResponse>({
    queryKey:[evidenceEndpoint,date],enabled:validDate,
    queryFn:()=>request("GET",evidenceEndpoint+"?"+new URLSearchParams({date})),
  });
  const begin=(item:WorkerEvidence)=>{
    setWorker(item);
    setTargets(Object.fromEntries(item.categories.map(cat=>[cat.categoryKey,"0"])));
  };
  const saving=useMutation({
    mutationFn:()=>request("POST",splitEndpoint,{
      date,workerId:worker!.workerId,confirm:true,
      allocations:worker!.categories.map(cat=>({
        categoryKey:cat.categoryKey,targetBales:Number(targets[cat.categoryKey]??"0"),
      })),
    }),
    onSuccess:()=>{
      toast({title:"Category target allocation saved",description:"Historical allocation locked. No bonus or payment posted."});
      setWorker(null);
      void queryClient.invalidateQueries({queryKey:[evidenceEndpoint,date]});
    },
    onError:(e:Error)=>toast({title:"Allocation not saved",description:e.message,variant:"destructive"}),
  });
  const total=worker?.categories.reduce((sum,cat)=>sum+Number(targets[cat.categoryKey]??"0"),0)??0;
  const validTargets=worker!=null && worker.categories.length>0 &&
    worker.categories.every(cat=>{
      const raw=targets[cat.categoryKey]??"";
      const n=Number(raw);
      return raw.trim()!=="" && Number.isFinite(n) && n>=0 && Math.abs(Math.round(n*100)-n*100)<0.000001;
    }) && Math.round(total*100)===Math.round((worker.dailyTargetBales??-1)*100);
  return (
    <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-category-evidence">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <ClipboardList className="mr-2 inline h-4 w-4" />
        Category production evidence and target allocation
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs text-muted-foreground">
          Physical bales are captured when daily Production Targets are finalized.
          One worker can have Bags, Toys and Shoes on the same day.
          Assign portions of the ONE saved daily target to the categories actually produced.
          This does not approve or post a bonus.
        </p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Finalized production date
          <Input aria-label="Category evidence date" className="w-[175px]" type="date"
            value={date} onChange={e=>{setDate(e.target.value);setWorker(null);}} />
        </label>
        {!validDate&&<p role="alert" className="text-sm text-destructive">Select a valid date.</p>}
        {error&&<p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {isLoading&&<p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading frozen bale evidence…
        </p>}
        {data&&<div className="flex flex-wrap items-center gap-3 text-xs">
          <span>{data.sourceBales} frozen physical bales</span>
          <span>{data.creditedBales} credited bales</span>
          {data.readyForTargetAllocation
            ? <span className="inline-flex items-center text-emerald-700"><CheckCircle2 className="mr-1 h-3.5 w-3.5"/> Evidence reconciled</span>
            : <span className="inline-flex items-center text-destructive"><ShieldAlert className="mr-1 h-3.5 w-3.5"/> Not ready for category targets</span>}
        </div>}
        {data&&!data.captured&&<p role="alert" className="text-xs text-muted-foreground">
          No frozen category capture exists for this day. Earlier finalized days cannot be
          reconstructed from current stock without a verified historical source.
        </p>}
        {data?.issues.length ? <p role="alert" className="text-xs text-destructive">
          Reconciliation issues: {data.issues.join(", ")}.
        </p> : null}
        {data&&data.workers.length>0&&(
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left"><tr>
                <th className="px-3 py-2">Worker</th>
                <th className="px-3 py-2">Saved daily target</th>
                <th className="px-3 py-2">Category counts (credited)</th>
                <th className="px-3 py-2">Target assignment</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr></thead>
              <tbody>
                {data.workers.map(item=>{
                  const saved=data.allocations.filter(a=>a.workerId===item.workerId);
                  const locked=saved.length>0;
                  return <tr key={item.workerId} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{item.workerName??("Worker #"+item.workerId)}</td>
                    <td className="px-3 py-2 tabular-nums">{item.dailyTargetBales??"Not set"}</td>
                    <td className="px-3 py-2">
                      {item.categories.length ? item.categories.map(cat=>
                        <div key={cat.categoryKey}>{cat.categoryLabel}: <strong>{cat.creditedBales}</strong></div>)
                        : "No attributed categories"}
                      {item.issues.length>0&&<p className="text-xs text-destructive">{item.issues.join(", ")}</p>}
                    </td>
                    <td className="px-3 py-2">
                      {locked ? saved.map(cat=><div key={cat.categoryKey}>{cat.categoryLabel}: {cat.targetBales}</div>)
                        : <span className="text-muted-foreground">Not allocated</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {locked ? <span className="text-xs text-muted-foreground">Locked</span> :
                        <Button size="sm" variant="outline" disabled={!data.readyForTargetAllocation ||
                          item.categories.length===0 || item.dailyTargetBales==null || item.issues.length>0}
                          onClick={()=>begin(item)}>Allocate</Button>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        <Dialog open={worker!==null} onOpenChange={open=>{if(!open)setWorker(null);}}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Allocate one worker's daily target</DialogTitle>
              <DialogDescription>
                {worker?.workerName??("Worker #"+worker?.workerId)} · {date} · daily target {worker?.dailyTargetBales??0}.
                Allocate targets by the categories credited to this worker. Save is permanent.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-72 space-y-3 overflow-y-auto">
              {worker?.categories.map(cat=><label className="block space-y-1 text-sm" key={cat.categoryKey}>
                {cat.categoryLabel} — {cat.creditedBales} credited bales
                <Input type="number" min="0" max="100000" step="0.01"
                  aria-label={"Target for "+cat.categoryLabel}
                  value={targets[cat.categoryKey]??"0"}
                  onChange={e=>setTargets(previous=>({...previous,[cat.categoryKey]:e.target.value}))} />
              </label>)}
            </div>
            <p className="text-sm tabular-nums">
              Assigned: {Number(total.toFixed(2))} / {worker?.dailyTargetBales??0} bales
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={()=>setWorker(null)}>Cancel</Button>
              <Button disabled={!validTargets||saving.isPending} onClick={()=>saving.mutate()}>
                {saving.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin"/>}
                Confirm and lock allocation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </details>
  );
}
