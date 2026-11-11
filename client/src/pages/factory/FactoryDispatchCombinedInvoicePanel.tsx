/**
 * Phase 8 — manually finalize ONE Factory invoice after signed Phase 7 approval.
 * Never uses legacy /finalize or creates an ERP PO import button.
 */
import { useState } from "react";
import { useMutation,useQuery } from "@tanstack/react-query";
import { AlertTriangle,CheckCircle2,FileCheck2,FileText,Loader2,ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { apiRequest,queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";

type OriginalCharge={id:number;name:string;amount:string;alreadyPosted:boolean};
interface InvoicePreview {
  finalized:boolean;ready:boolean;blockingReasons:string[];
  fingerprint:string;invoiceNumber:string|null;
  tripCount?:number;goodsSubtotal?:string;tripBillableCharges?:string;
  tripDiscounts?:string;tripCustomerTotal?:string;originalOrderCharges?:string;
  finalInvoiceTotal?:string;physicalBales?:number;totalCost?:string;postCOGS?:boolean;
  originalCharges?:OriginalCharge[];
  finalization?:{
    finalInvoiceTotal?:string;tripCount?:number;voucherIds?:number[];
    goodsSubtotal?:string;includedPostingIds?:string[];
    shippedBales?:number;customerReceivableReposted?:boolean;
  }|null;
  orderConsistent?:boolean;
}
interface Props {
  orderId:number;
  companyId:number|null|undefined;
  signedFingerprint:string;
  isSupervisor:boolean;
  onFinalized:()=>void;
}
const money=(v:string|undefined)=>Number(v??0).toLocaleString(undefined,{
  minimumFractionDigits:2,maximumFractionDigits:2,
});
const errorText=(e:unknown)=>e instanceof Error?e.message:"Unable to finalize combined invoice";
export default function FactoryDispatchCombinedInvoicePanel({
  orderId,companyId,signedFingerprint,isSupervisor,onFinalized,
}:Props) {
  const {toast}=useToast();
  const [dialog,setDialog]=useState(false);
  const [reason,setReason]=useState("");
  const [checkCharges,setCheckCharges]=useState(false);
  const [checkNoDouble,setCheckNoDouble]=useState(false);
  const base="/api/factory/customer-orders/"+orderId+"/loading-dispatches/combined-invoice";
  const preview=useQuery<InvoicePreview>({
    queryKey:companyQueryKey(base+"/preview",companyId),
    queryFn:async()=>{
      const r=await fetch(base+"/preview",{credentials:"include",cache:"no-store"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.message||"Cannot load final combined invoice preview");
      return d as InvoicePreview;
    },
    enabled:Boolean(companyId)&&Boolean(signedFingerprint),
    staleTime:10000,refetchOnWindowFocus:false,
  });
  const value=preview.data;
  const canFinalize=Boolean(isSupervisor&&!value?.finalized&&value?.ready &&
    value.fingerprint===signedFingerprint);
  const mutation=useMutation({
    mutationFn:async()=>{
      if(!canFinalize || !checkCharges || !checkNoDouble ||
         reason.trim().length<10 || reason.trim().length>1000) {
        throw new Error("Review and confirm the exact final invoice first");
      }
      const result=await apiRequest("POST",base+"/finalize",{
        expectedFingerprint:signedFingerprint,reason:reason.trim(),confirm:true,
        confirmNoDuplicateReceivable:true,confirmTripChargesReviewed:true,
      });
      return result.json() as Promise<{
        invoiceNumber:string;invoiceTotal:string;tripCount:number;replayed:boolean;
        canonicalDocumentFrozen:boolean;message:string;
      }>;
    },
    onSuccess:result=>{
      setDialog(false);setReason("");setCheckCharges(false);setCheckNoDouble(false);
      void queryClient.invalidateQueries({queryKey:companyQueryKey(base+"/preview",companyId)});
      void queryClient.invalidateQueries({queryKey:companyQueryKey(
        "/api/factory/customer-orders/"+orderId+"/loading-dispatches/order-reconciliation",companyId)});
      void queryClient.invalidateQueries({queryKey:companyQueryKey("/api/factory/customer-orders/"+orderId,companyId)});
      onFinalized();
      toast({
        title:"One combined invoice finalized — "+result.invoiceNumber,
        description:result.message,
      });
    },
    onError:error=>{
      void preview.refetch();
      toast({title:"Combined invoice not finalized",description:errorText(error),variant:"destructive"});
    },
  });
  return (
    <>
      <Card className="border-indigo-200 dark:border-indigo-800/50" data-testid="combined-dispatch-invoice-panel">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-5 w-5 text-indigo-600"/>
              <div>
                <h3 className="text-sm font-bold">One combined customer invoice</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Consolidate every signed truck without charging the customer twice.
                </p>
              </div>
            </div>
            <Badge variant="outline">{value?.finalized?"Finalized":"Awaiting final invoice"}</Badge>
          </div>
          {preview.isPending&&<p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin"/> Loading approved invoice totals…
          </p>}
          {preview.isError&&<p className="rounded-lg border border-amber-300 p-3 text-xs text-amber-700">
            <AlertTriangle className="mr-1 inline h-4 w-4"/>{errorText(preview.error)}
          </p>}
          {value?.finalized&&(
            <div className="space-y-2 rounded-lg bg-emerald-50 p-3 text-xs dark:bg-emerald-950/20">
              <p className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4 text-emerald-600"/>
                Invoice {value.invoiceNumber} finalized
              </p>
              <p className="font-mono text-base font-bold">
                $ {money(value.finalization?.finalInvoiceTotal)}
              </p>
              <p>{value.finalization?.tripCount??0} trips · {value.finalization?.shippedBales??0} shipped bales</p>
              <p className="text-muted-foreground">
                Already-posted truck receivables were not debited again. The invoice can be viewed/exported
                through the existing Factory invoice workflow.
              </p>
              {value.orderConsistent===false&&<p className="text-destructive">
                Warning: Invoice record does not match the consolidated posting. Accounting review required.
              </p>}
            </div>
          )}
          {value&&!value.finalized&&(
            <>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="text-muted-foreground">Combined trips</p>
                  <p className="mt-1 font-semibold">{value.tripCount??"—"}</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="text-muted-foreground">Actually shipped bales</p>
                  <p className="mt-1 font-semibold">{value.physicalBales??"—"}</p>
                </div>
              </div>
              <div className="space-y-1 rounded-lg border p-3 text-xs">
                <div className="flex justify-between"><span>Already-posted trip customer totals</span>
                  <strong className="font-mono">$ {money(value.tripCustomerTotal)}</strong></div>
                <div className="flex justify-between"><span>Original order charges (not in trips)</span>
                  <strong className="font-mono">$ {money(value.originalOrderCharges)}</strong></div>
                <div className="flex justify-between border-t pt-2"><span className="font-bold">One final invoice</span>
                  <strong className="font-mono">$ {money(value.finalInvoiceTotal)}</strong></div>
                <p className="text-[11px] text-muted-foreground">
                  Posted truck fees and discounts are already included in trip totals.
                  Clearing-to-sales is a reclassification, not another customer receivable.
                </p>
              </div>
              {Boolean(value.originalCharges?.length)&&(
                <div className="space-y-1 text-xs">
                  <p className="font-semibold">Original loading charges (counted once)</p>
                  {value.originalCharges?.map(c=>(
                    <div className="flex justify-between gap-2" key={c.id}>
                      <span>{c.name}{c.alreadyPosted?" (already posted)":""}</span>
                      <span className="font-mono">$ {money(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              {Boolean(value.blockingReasons?.length)&&(
                <div className="rounded-lg border border-amber-300 p-3 text-xs text-amber-700">
                  <p className="font-semibold">Cannot finalize yet</p>
                  {value.blockingReasons.map(r=><p key={r}>• {r}</p>)}
                </div>
              )}
              {isSupervisor&&(
                <Button type="button" className="w-full"
                  onClick={()=>{setDialog(true);setCheckCharges(false);setCheckNoDouble(false);}}
                  disabled={!canFinalize||mutation.isPending}
                  data-testid="button-finalize-combined-factory-invoice">
                  <FileCheck2 className="mr-2 h-4 w-4"/> Finalize one combined invoice
                </Button>
              )}
              <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-4 w-4 shrink-0"/>
                Finalization marks only signed shipped bales SOLD, posts goods clearing to sales,
                and posts inventory cost only when perpetual inventory is active.
                No automatic ERP PO import occurs.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialog} onOpenChange={open=>{if(!mutation.isPending)setDialog(open);}}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Finalize one customer invoice for all trucks?</DialogTitle>
            <DialogDescription>
              This action is final. It uses the signed reconciliation and cannot be reverted through
              the ordinary invoice unfinalize button.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="combined-factory-invoice-reason">Finalization reason</Label>
            <Textarea id="combined-factory-invoice-reason" rows={3}
              maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}
              placeholder="All truck totals, shipped bales and original charges checked…"/>
            <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
              <Checkbox checked={checkCharges} onCheckedChange={v=>setCheckCharges(v===true)}/>
              <span>I reviewed all previously posted truck charges, discounts and original order
                charges and approve the final total shown above.</span>
            </label>
            <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
              <Checkbox checked={checkNoDouble} onCheckedChange={v=>setCheckNoDouble(v===true)}/>
              <span>I understand the customer receivables for each truck are already posted:
                this action creates only the missing accounting classifications and one invoice.</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={()=>setDialog(false)}>Cancel</Button>
            <Button disabled={!canFinalize||mutation.isPending||!checkCharges||!checkNoDouble||
              reason.trim().length<10||reason.trim().length>1000}
              onClick={()=>mutation.mutate()} data-testid="button-confirm-combined-invoice">
              {mutation.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin"/>}
              Confirm final invoice
            </Button>
          </DialogFooter>
          {mutation.isError&&<p className="text-xs text-destructive">{errorText(mutation.error)}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
