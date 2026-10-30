import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, Download, Loader2, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { localDateStr } from "../factoryProductionTargetsModel";
import { exportWeeklyBonusPaymentsExcel,
  type WeeklyBonusPaymentExportRow } from "./weeklyBonusPaymentsExcel";

type WeeklyRow = WeeklyBonusPaymentExportRow & {
  paymentStatus: "POSTED" | "REVERSED" | null;
  paymentId: number | string | null;
  cashAccountId: number | null;
};
type WeeklyHistory = { start:string; end:string; currency:"USD"; payments:WeeklyRow[] };
type Account = { id:number; name:string; code:string; accountType:string; openingCurrency:string|null };
type Accounts = { accounts:Account[] };
type PostResult = { posted:number; replayed:number };
const base="/api/factory/production-target-bonuses/weekly-payments";
async function api<T>(method:"GET"|"POST",url:string,body?:unknown):Promise<T>{
  const response=await factoryApiRequest(method,url,body);
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(result?.message||"Weekly bonus payment request failed");
  return result as T;
}
const usd=(v:string|number)=>Number(v).toLocaleString("en-US",{style:"currency",currency:"USD"});

/** Phase 15 financial surface: one immutable approved worker/week per cash payment. */
export function ProductionTargetWeeklyBonusPaymentsPanel({initialDate}:{initialDate:string}){
  const {toast}=useToast();
  const monday=mondayOfProductionBonusWeek(initialDate)??initialDate;
  const [start,setStart]=useState(monday);
  const [end,setEnd]=useState(monday);
  const [selected,setSelected]=useState<number[]>([]);
  const [accountId,setAccountId]=useState("");
  const [paymentDate,setPaymentDate]=useState(()=>localDateStr(new Date()));
  const [confirmOpen,setConfirmOpen]=useState(false);
  const [reverseRow,setReverseRow]=useState<WeeklyRow|null>(null);
  const [reversalDate,setReversalDate]=useState(()=>localDateStr(new Date()));
  const [reason,setReason]=useState("");
  const [exporting,setExporting]=useState(false);
  useEffect(()=>{
    const day=mondayOfProductionBonusWeek(initialDate)??initialDate;
    setStart(day);setEnd(day);setSelected([]);
  },[initialDate]);
  const valid=Boolean(mondayOfProductionBonusWeek(start)===start &&
    mondayOfProductionBonusWeek(end)===end && start<=end &&
    (Date.parse(end)-Date.parse(start))/86400000<=366);
  const {data,error,isLoading}=useQuery<WeeklyHistory>({
    queryKey:[base,start,end],
    enabled:valid,
    queryFn:()=>api("GET",base+"?"+new URLSearchParams({start,end}).toString()),
  });
  const {data:accountData,error:accountError}=useQuery<Accounts>({
    queryKey:["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn:()=>api("GET","/api/factory/staff-tracking/production-bonuses/payment-accounts"),
  });
  const cashAccounts=(accountData?.accounts??[]).filter(a=>
    !a.openingCurrency||a.openingCurrency.toUpperCase()==="USD");
  const rows=data?.payments??[];
  const payable=rows.filter(r=>r.decisionStatus==="approved"&&!r.paymentStatus &&
    Number(r.approvedAmount)>0);
  const chosen=useMemo(()=>rows.filter(r=>selected.includes(Number(r.reviewId))&&
    r.decisionStatus==="approved"&&!r.paymentStatus&&Number(r.approvedAmount)>0),
  [rows,selected]);
  const allSelected=payable.length>0&&payable.every(r=>selected.includes(Number(r.reviewId)));
  const total=chosen.reduce((sum,r)=>sum+Number(r.approvedAmount),0);
  const canPay=chosen.length>0&&Boolean(accountId)&&Boolean(paymentDate)&&!isLoading;
  const payment=useMutation({
    mutationFn:()=>api<PostResult>("POST",base+"/post",{
      confirm:true,currency:"USD",paymentDate,cashAccountId:Number(accountId),
      selections:chosen.map(r=>({
        weekStart:r.weekStart,workerId:Number(r.workerId),
        expectedAmount:String(r.approvedAmount),
      })),
    }),
    onSuccess:result=>{
      toast({title:"Weekly flat bonus payments posted",
        description:result.posted+" new vouchers; "+result.replayed+" exact retries. Check Daybook."});
      setSelected([]);setConfirmOpen(false);
      void queryClient.invalidateQueries({queryKey:[base]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/production-target-bonuses/weekly-reviews"]});
    },
    onError:(error:Error)=>{
      setConfirmOpen(false);
      toast({title:"No weekly bonus payment posted",description:error.message,variant:"destructive"});
    },
  });
  const reversal=useMutation({
    mutationFn:()=>api("POST",base+"/"+reverseRow!.paymentId+"/reverse",{
      confirm:true,reversalDate,reason:reason.trim(),
    }),
    onSuccess:()=>{
      toast({title:"Weekly bonus payment reversed",
        description:"A reversing Receipt voucher was created; the worker/week cannot be paid twice."});
      setReverseRow(null);setReason("");
      void queryClient.invalidateQueries({queryKey:[base]});
    },
    onError:(error:Error)=>toast({title:"Reversal not posted",description:error.message,variant:"destructive"}),
  });
  async function download(){
    if(!data||!rows.length)return;
    setExporting(true);
    try{
      await exportWeeklyBonusPaymentsExcel(rows,start,end);
      toast({title:"Weekly bonus Excel exported"});
    }catch(error){
      toast({title:"Excel export failed",description:(error as Error).message,variant:"destructive"});
    }finally{setExporting(false);}
  }
  return <Card className="overflow-hidden shadow-none" data-testid="production-weekly-bonus-payments">
    <CardHeader className="border-b bg-muted/20">
      <CardTitle className="flex items-center gap-2 text-lg">
        <Banknote className="h-5 w-5 text-primary"/> Weekly Flat Bonus Payments
      </CardTitle>
      <p className="text-sm text-muted-foreground">
        Pay approved weekly flat bonuses from an active USD Cash or Bank account.
        Every payment debits Payroll Deposit Expense, credits the selected account,
        and creates a Payment voucher plus Factory Daybook entry. Reversed bonuses stay locked.
      </p>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          From week (Monday)
          <Input type="date" aria-label="Weekly bonus from Monday" className="w-[168px]"
            value={start} onChange={e=>{setStart(e.target.value);setSelected([]);}} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To week (Monday)
          <Input type="date" aria-label="Weekly bonus to Monday" className="w-[168px]"
            value={end} onChange={e=>{setEnd(e.target.value);setSelected([]);}} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Payment date
          <Input type="date" aria-label="Weekly bonus payment date" className="w-[168px]"
            value={paymentDate} onChange={e=>setPaymentDate(e.target.value)}/>
        </label>
        <label className="min-w-[220px] flex-1 space-y-1 text-xs text-muted-foreground">
          Pay from Cash / Bank (USD)
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger aria-label="Weekly bonus paying account">
              <SelectValue placeholder="Select Cash / Bank account" />
            </SelectTrigger>
            <SelectContent>
              {cashAccounts.map(a=><SelectItem key={a.id} value={String(a.id)}>
                {a.name} ({a.code})
              </SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>
      {!valid&&<p role="alert" className="text-sm text-destructive">
        Choose Monday start/end weeks, up to one year apart.
      </p>}
      {error&&<p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
      {accountError&&<p role="alert" className="text-xs text-destructive">{(accountError as Error).message}</p>}
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
        <Button type="button" variant="outline" size="sm" disabled={!payable.length}
          onClick={()=>setSelected(allSelected?[]:payable.map(r=>Number(r.reviewId)))}>
          {allSelected?"Clear selection":"Select all approved / unpaid"}
        </Button>
        <strong className="ml-auto tabular-nums">{chosen.length} selected · {usd(total)}</strong>
        <Button type="button" size="sm" variant="outline"
          disabled={!data||!rows.length||exporting} onClick={()=>{void download();}}>
          <Download className="mr-1 h-4 w-4"/> {exporting?"Exporting…":"Export Excel"}
        </Button>
        <Button type="button" disabled={!canPay||payment.isPending}
          onClick={()=>setConfirmOpen(true)}>
          Review and Post
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Select</th>
              <th className="px-3 py-2">Worker / Week</th>
              <th className="px-3 py-2 text-right">Target / Credited</th>
              <th className="px-3 py-2 text-right">Approved USD</th>
              <th className="px-3 py-2">Review / Payment</th>
              <th className="px-3 py-2">Account / Voucher</th>
              <th className="px-3 py-2 text-right">Correction</th>
            </tr>
          </thead>
          <tbody>
            {isLoading&&<tr><td colSpan={7} className="px-3 py-5 text-center">
              <Loader2 className="inline h-4 w-4 animate-spin"/> Loading weekly approvals…
            </td></tr>}
            {!isLoading&&!rows.length&&<tr><td colSpan={7}
              className="px-3 py-5 text-center text-muted-foreground">
              No reviewed weekly bonuses in this date range.
            </td></tr>}
            {rows.map(r=>{
              const unpaid=r.decisionStatus==="approved"&&!r.paymentStatus&&Number(r.approvedAmount)>0;
              return <tr key={String(r.reviewId)} className="border-t align-top">
                <td className="px-3 py-2">
                  <Checkbox disabled={!unpaid} checked={selected.includes(Number(r.reviewId))}
                    aria-label={"Select weekly payment for "+r.workerName}
                    onCheckedChange={checked=>setSelected(prior=>checked?
                      [...new Set([...prior,Number(r.reviewId)])]:
                      prior.filter(id=>id!==Number(r.reviewId)))} />
                </td>
                <td className="px-3 py-2">
                  <p className="font-medium">{r.workerName}</p>
                  <p className="text-xs text-muted-foreground">{r.weekStart} – {r.weekEnd}</p>
                  <p className="text-xs text-muted-foreground">
                    {(r.snapshot?.categories??[]).map(c=>c.categoryLabel+" "+c.creditedBales).join(" · ")}
                  </p>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.targetBales} / {r.creditedBales}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {usd(r.approvedAmount)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={r.paymentStatus==="POSTED"?"default":"secondary"}>
                    {r.paymentStatus==="POSTED"?"Paid":r.paymentStatus==="REVERSED"?
                      "Reversed · locked":r.decisionStatus==="rejected"?"Rejected":"Approved · unpaid"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.paymentDate?r.paymentDate+" · "+(r.cashAccountName??""):"Not posted"}
                  {r.voucherId&&<p>Voucher #{r.voucherId}</p>}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.paymentStatus==="POSTED"&&<Button type="button" size="sm" variant="outline"
                    onClick={()=>{setReverseRow(r);setReversalDate(localDateStr(new Date()));setReason("");}}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5"/> Reverse
                  </Button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Payment is a separate financial confirmation after immutable weekly approval.
        A reversed worker/week can never be automatically paid again.
      </p>
    </CardContent>
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm weekly flat bonus payment</AlertDialogTitle>
          <AlertDialogDescription>
            Pay {chosen.length} approved worker/week bonuses totaling {usd(total)} from
            {" "}{cashAccounts.find(a=>String(a.id)===accountId)?.name??"selected account"}
            {" "}on {paymentDate}. Each payment creates a balanced voucher:
            Debit Payroll Deposit Expense / Credit selected Cash or Bank.
            These payments are permanent claims; a reversal will not allow another automatic payout.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={payment.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!canPay||payment.isPending}
            onClick={e=>{e.preventDefault();payment.mutate();}}>
            {payment.isPending?"Posting…":"Confirm and Post"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={reverseRow!==null} onOpenChange={open=>{if(!open)setReverseRow(null);}}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse weekly bonus payment</DialogTitle>
          <DialogDescription>
            Creates a reversing Receipt voucher; the original claim remains locked.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">{reverseRow?.workerName} · {reverseRow?.weekStart} ·
          {" "}{usd(reverseRow?.approvedAmount??"0")}</p>
        <label className="space-y-1 text-sm">
          Reversal date
          <Input type="date" value={reversalDate} onChange={e=>setReversalDate(e.target.value)}/>
        </label>
        <label className="space-y-1 text-sm">
          Reason (required)
          <Input value={reason} onChange={e=>setReason(e.target.value)}
            placeholder="Explain the correction" maxLength={400}/>
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={reversal.isPending}
            onClick={()=>setReverseRow(null)}>Cancel</Button>
          <Button type="button" variant="destructive"
            disabled={reversal.isPending||!reason.trim()||!reversalDate}
            onClick={()=>reversal.mutate()}>
            {reversal.isPending?"Reversing…":"Confirm Reversal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
