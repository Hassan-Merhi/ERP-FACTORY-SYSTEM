/**
 * Phase 7 — order-wide, supervisor-signed reconciliation.
 * Mounted on the EXISTING All Trips comparison page (not a separate menu).
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileCheck2, Loader2, ShieldCheck, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import FactoryDispatchCombinedInvoicePanel from "./FactoryDispatchCombinedInvoicePanel";

export interface DispatchOrderReconciliation {
  orderId: number;
  loadingStatus: string;
  fingerprint: string;
  ready: boolean;
  blockingReasons: string[];
  summary: {
    originalLoadedBales: number;
    physicallyScannedBales: number;
    signedFinancialBales: number;
    unshippedBales: number;
    unexpectedScans: number;
    duplicateScans: number;
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    customerTotal: string;
    existingOrderChargeTotal: string;
    tripCount: number;
    postedTrips: number;
    openTrips: number;
  };
  trips: Array<{
    dispatchId: string;
    dispatchNumber: number;
    physicalStatus: string;
    financialStatus: string;
    physicallyScannedBales: number;
    postedBales: number;
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    customerTotal: string;
    postingId: string | null;
    erpPoFileStatus: "GENERATED_NOT_CONFIRMED_IMPORTED" | "NOT_GENERATED";
    exportedPoNumber: string | null;
  }>;
  includedPostingIds: string[];
  warnings: string[];
  approval: null | {
    fingerprint: string;
    approvedAt: string;
    approvedByUserId: string;
    reason: string;
    includedPostingIds: string[];
    customerTotal: string;
  };
  approvalCurrent: boolean;
  canApprove: boolean;
}
interface Props {
  value: DispatchOrderReconciliation | null;
  loading: boolean;
  error: string | null;
  orderId: number;
  companyId: number | null | undefined;
  isSupervisor: boolean;
  onRefresh: () => void;
}
const currency = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString(undefined,{
    minimumFractionDigits:2,maximumFractionDigits:2,
  }) : "—";
};
const errText=(e:unknown)=>e instanceof Error?e.message:"Could not approve order reconciliation";
export default function FactoryDispatchOrderFinancialReview({
  value,loading,error,orderId,companyId,isSupervisor,onRefresh,
}:Props){
  const {toast}=useToast();
  const [open,setOpen]=useState(false);
  const [reason,setReason]=useState("");
  const [checked,setChecked]=useState(false);
  const mutation=useMutation({
    mutationFn:async()=>{
      if(!value || !value.ready || !value.canApprove || !checked || reason.trim().length<10){
        throw new Error("Refresh and review all trip postings before signing.");
      }
      const res=await apiRequest("POST",
        "/api/factory/customer-orders/"+orderId+"/loading-dispatches/order-reconciliation/approve",{
          expectedFingerprint:value.fingerprint,reason:reason.trim(),confirm:true,
        });
      return res.json() as Promise<{approved:boolean;replayed:boolean}>;
    },
    onSuccess:()=>{
      setOpen(false);setReason("");setChecked(false);
      onRefresh();
      toast({title:"All-truck reconciliation approved",
        description:"A signed order-wide snapshot is now ready for the Phase 8 combined invoice."});
    },
    onError:e=>{onRefresh();toast({title:"Approval refused",description:errText(e),variant:"destructive"});},
  });
  return (
    <>
      <Card className="border-blue-200 bg-white dark:border-blue-700/40 dark:bg-[#101c34]" data-testid="all-truck-financial-reconciliation">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ClipboardCheck className="mt-0.5 h-5 w-5 text-blue-600" />
              <div>
                <h2 className="text-base font-bold">Combined order reconciliation</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  One original loading, all physical truck scans and their posted financial totals.
                  This approval is separate from the final customer invoice.
                </p>
              </div>
            </div>
            {value?.approval ? (
              <Badge variant="outline">{value.approvalCurrent?"Signed & locked":"Signed — source changed"}</Badge>
            ) : <Badge variant="outline">{value?.ready?"Ready for approval":"Review required"}</Badge>}
          </div>
          {loading && <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Comparing posted financial evidence…
          </p>}
          {error && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <AlertTriangle className="mr-1.5 inline h-4 w-4" />{error}
          </p>}
          {value && (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {([
                  ["Trips finalized",value.summary.postedTrips+" / "+value.summary.tripCount],
                  ["Pending Loading bales",String(value.summary.originalLoadedBales)],
                  ["Verified truck scans",String(value.summary.physicallyScannedBales)],
                  ["Unshipped remaining",String(value.summary.unshippedBales)],
                ] as const).map(([label,number])=>(
                  <div key={label} className="rounded-lg bg-muted/50 p-3">
                    <p className="text-[11px] text-muted-foreground">{label}</p>
                    <p className="mt-1 font-mono text-sm font-bold">{number}</p>
                  </div>
                ))}
              </div>
              <div className="space-y-1 rounded-lg border p-3 text-xs">
                <div className="flex justify-between gap-2"><span>All shipped goods</span><span className="font-mono">$ {currency(value.summary.goodsSubtotal)}</span></div>
                <div className="flex justify-between gap-2"><span>Trip customer-billable charges</span><span className="font-mono">+ $ {currency(value.summary.billableChargesTotal)}</span></div>
                <div className="flex justify-between gap-2"><span>Trip customer discounts</span><span className="font-mono">− $ {currency(value.summary.discountTotal)}</span></div>
                <div className="flex justify-between gap-2 border-t pt-2 font-semibold">
                  <span>Combined posted customer receivable</span>
                  <span className="font-mono">$ {currency(value.summary.customerTotal)}</span>
                </div>
                {Number(value.summary.existingOrderChargeTotal)>0 && (
                  <p className="pt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    Separate original loading charges: $ {currency(value.summary.existingOrderChargeTotal)}
                    {" "}— not counted in trip totals; review once when building the final invoice.
                  </p>
                )}
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {value.trips.map(t=>(
                  <div key={t.dispatchId} className="rounded-lg border p-3 text-xs" data-testid={"order-reconciliation-trip-"+t.dispatchId}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-semibold"><Truck className="h-4 w-4" />
                        Dispatch #{String(t.dispatchNumber).padStart(3,"0")}
                      </span>
                      <Badge variant="outline">{t.financialStatus}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 text-muted-foreground">
                      <span>Scanned / billed: {t.physicallyScannedBales} / {t.postedBales} bales</span>
                      <span>Customer: $ {currency(t.customerTotal)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Physical: {t.physicalStatus} · Post #{t.postingId??"Not posted"} ·
                      ERP PO: {t.erpPoFileStatus==="GENERATED_NOT_CONFIRMED_IMPORTED"
                        ? "Excel generated (ERP import unconfirmed)" : "Not yet exported"}
                    </p>
                  </div>
                ))}
              </div>
              {value.blockingReasons.length>0 && (
                <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200">
                  <p className="font-semibold">Resolve before signing</p>
                  {value.blockingReasons.map(message=><p key={message}>• {message}</p>)}
                </div>
              )}
              {value.warnings.map(msg=>(
                <p key={msg} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />{msg}
                </p>
              ))}
              {value.approval && (
                <FactoryDispatchCombinedInvoicePanel
                  orderId={orderId}
                  companyId={companyId}
                  signedFingerprint={value.approval.fingerprint}
                  isSupervisor={isSupervisor}
                  onFinalized={onRefresh}
                />
              )}
              {value.approval && (
                <div className={"rounded-lg border p-3 text-xs "+(value.approvalCurrent?
                  "border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20":
                  "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/20")}>
                  <p className="flex items-center gap-2 font-semibold">
                    {value.approvalCurrent?<CheckCircle2 className="h-4 w-4 text-emerald-600" />:
                      <AlertTriangle className="h-4 w-4 text-red-600" />}
                    {value.approvalCurrent?"Reconciliation signed":"Signed evidence is no longer current"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Approved {new Date(value.approval.approvedAt).toLocaleString()} · {value.approval.reason}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground break-all">
                    Fingerprint: {value.approval.fingerprint}
                  </p>
                </div>
              )}
              {isSupervisor && !value.approval && (
                <Button type="button" className="w-full"
                  disabled={!value.canApprove || mutation.isPending}
                  onClick={()=>{setOpen(true);setChecked(false);}}
                  data-testid="button-sign-dispatch-order-reconciliation">
                  <FileCheck2 className="mr-2 h-4 w-4" />
                  Approve all-truck reconciliation
                </Button>
              )}
              {!value.approval && value.ready && !isSupervisor && (
                <p className="text-xs text-muted-foreground">Admin, Owner or Developer approval is required.</p>
              )}
              <p className="flex items-start gap-2 border-t pt-3 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-4 w-4 shrink-0" />
                Signing freezes the matched order/trip evidence for one combined invoice.
                It does not debit the customer again, create an invoice, or import an ERP PO file.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={v=>{if(!mutation.isPending)setOpen(v);}}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve all truck trips as one order?</DialogTitle>
            <DialogDescription>
              Every physical scan, financially posted bale, trip charge and posting ID must reconcile.
              After signing, ordinary trip edits and bale removals will be locked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reconciliation-signoff-reason">Approval notes (required)</Label>
            <Textarea id="reconciliation-signoff-reason" rows={3} maxLength={1000}
              value={reason} onChange={e=>setReason(e.target.value)}
              placeholder="All trucks checked against original loading and approved for one invoice…" />
          </div>
          <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
            <Checkbox checked={checked} onCheckedChange={v=>setChecked(v===true)} />
            <span>I checked the matched bales, each posted trip, customer charges and all differences,
              and approve this exact order-wide financial snapshot.</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending}
              onClick={()=>setOpen(false)}>Cancel</Button>
            <Button type="button" disabled={mutation.isPending || !checked ||
              reason.trim().length<10 || reason.trim().length>1000 || !value?.canApprove}
              onClick={()=>mutation.mutate()}>
              {mutation.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign reconciliation
            </Button>
          </DialogFooter>
          {mutation.isError&&<p className="text-xs text-destructive">{errText(mutation.error)}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
