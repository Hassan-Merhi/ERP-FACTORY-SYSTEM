import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, Calculator, CheckCircle2, Loader2, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { localDateStr } from "../factoryProductionTargetsModel";
import { ProductionBonusCategoryRatesPanel } from "./ProductionBonusCategoryRatesPanel";
import { ProductionBonusWeeklyMethodPanel } from "./ProductionBonusWeeklyMethodPanel";

type Method = "standard" | "category";
type Line = { category: string; produced: number; extra: number; rate: string; bonus: string };
type Offer = {
  date: string; workerId: number; workerName: string; target: number; produced: number;
  extra: number; method: Method; lines: Line[]; amount: string; token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "blocked" | "rejected";
  issue: string | null;
};
type Preview = { date: string; method: Method; currency: "USD"; offers: Offer[] };
type Account = { id: number; name: string; code: string; openingCurrency: string | null };
type PaymentRow = { reviewId: number; workerId: number; paymentId: number | null;
  paymentStatus: "POSTED" | "REVERSED" | null; cashAccountName: string | null; voucherId: number | null };
const endpoint="/api/factory/production-target-bonuses/checkout";
const usd=(amount:string|number)=>Number(amount).toLocaleString("en-US",{
  style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2
});
async function request<T>(method:"GET"|"POST",path:string,body?:unknown):Promise<T>{
  const response=await factoryApiRequest(method,path,body);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||"Bonus request failed");
  return data as T;
}
/** A single checkout: select workers, verify locked amounts, then approve and post. */
export function ProductionBonusCheckoutPanel({
  initialDate,productionCategories,
}: { initialDate:string;productionCategories:string[] }) {
  const {toast}=useToast();
  const [date,setDate]=useState(initialDate);
  const [method,setMethod]=useState<Method>("standard");
  const [selected,setSelected]=useState<number[]>([]);
  const [accountId,setAccountId]=useState("");
  const [paymentDate,setPaymentDate]=useState(()=>localDateStr(new Date()));
  const [confirmPay,setConfirmPay]=useState(false);
  const [editingRate,setEditingRate]=useState<Offer|null>(null);
  const [newRate,setNewRate]=useState("");
  const [reverse,setReverse]=useState<PaymentRow|null>(null);
  const [reverseReason,setReverseReason]=useState("");
  useEffect(()=>{setDate(initialDate);setSelected([]);},[initialDate]);
  const {data:access}=useQuery<{canDecide:boolean}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses",date,date],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses?"+
      new URLSearchParams({start:date,end:date})),
    enabled:canUse&&Boolean(date),
  });
  const canUse=access?.canDecide===true;
  const {data,error,isLoading}=useQuery<Preview>({
    queryKey:[endpoint,date,method],
    queryFn:()=>request("GET",endpoint+"?"+new URLSearchParams({date,method})),
    enabled:canUse&&Boolean(date),
  });
  const {data:accounts}=useQuery<{accounts:Account[]}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses/payment-accounts"),
    enabled:canUse,
  });
  const {data:payments}=useQuery<{payments:PaymentRow[]}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses/payments",date,date],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses/payments?"+
      new URLSearchParams({start:date,end:date})),
    enabled:Boolean(date),
  });
  const cashAccounts=(accounts?.accounts??[]).filter(a=>
    !a.openingCurrency||a.openingCurrency.toUpperCase()==="USD");
  const offers=data?.offers??[];
  const payable=offers.filter(row=>row.status==="pending"||row.status==="approved");
  const chosen=useMemo(()=>offers.filter(row=>
    selected.includes(row.workerId)&&(row.status==="pending"||row.status==="approved")),
  [offers,selected]);
  const total=chosen.reduce((sum,row)=>sum+Math.round(Number(row.amount)*100),0)/100;
  const allSelected=payable.length>0&&payable.every(row=>selected.includes(row.workerId));
  const pay=useMutation({
    mutationFn:()=>request<{posted:number;replayed:number}>("POST",endpoint+"/pay",{
      method,confirm:true,currency:"USD",paymentDate,cashAccountId:Number(accountId),
      selections:chosen.map(row=>({date:row.date,workerId:row.workerId,
        expectedAmount:row.amount,token:row.token})),
    }),
    onSuccess:result=>{
      setConfirmPay(false);setSelected([]);
      toast({title:"Production bonuses paid",
        description:result.posted+" payments posted; "+result.replayed+" safe retries. See Daybook."});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/staff-tracking/production-bonuses"]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/production-target-bonuses/report"]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/worker-bonuses"]});
    },
    onError:(error:Error)=>{
      setConfirmPay(false);toast({title:"Nothing was paid",description:error.message,variant:"destructive"});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
    },
  });
  const saveRate=useMutation({
    mutationFn:()=>request("POST","/api/factory/staff-tracking/production-bonuses/rate",{
      workerId:editingRate!.workerId,effectiveFrom:date,ratePerBale:newRate,
    }),
    onSuccess:()=>{
      setEditingRate(null);toast({title:"Standard per-bale rate saved"});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
    },
    onError:(error:Error)=>toast({title:"Rate not saved",description:error.message,variant:"destructive"}),
  });
  const reverseMutation=useMutation({
    mutationFn:()=>request("POST",
      "/api/factory/staff-tracking/production-bonuses/payments/"+reverse!.paymentId+"/reverse",{
        confirm:true,reversalDate:paymentDate,reason:reverseReason,
      }),
    onSuccess:()=>{
      setReverse(null);setReverseReason("");toast({title:"Payment reversed in Daybook"});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/staff-tracking/production-bonuses/payments"]});
    },
    onError:(error:Error)=>toast({title:"Reversal failed",description:error.message,variant:"destructive"}),
  });
  if(!canUse)return null;
  return <Card data-testid="production-bonus-checkout" className="overflow-hidden shadow-none">
    <CardHeader className="border-b bg-muted/20">
      <CardTitle className="flex items-center gap-2 text-lg"><Banknote className="h-5 w-5 text-primary"/>Production Bonus Payroll</CardTitle>
      <p className="text-sm text-muted-foreground">
        Select workers, verify the target and extra-bale calculation, then Pay. Approval and payment are one
        confirmed transaction. A saved open Production Targets day can be paid without End Production.
      </p>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">Production date
          <Input aria-label="Bonus production date" type="date" value={date}
            onChange={event=>{setDate(event.target.value);setSelected([]);}} className="w-[170px]"/>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Bonus calculation
          <Select value={method} onValueChange={value=>{setMethod(value as Method);setSelected([]);}}>
            <SelectTrigger className="min-w-[220px]"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">Standard · per extra bale</SelectItem>
              <SelectItem value="category">Category rate · per extra bale</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Payment date
          <Input aria-label="Bonus payment date" type="date" value={paymentDate}
            onChange={event=>setPaymentDate(event.target.value)} className="w-[170px]"/>
        </label>
        <label className="min-w-[230px] flex-1 space-y-1 text-xs text-muted-foreground">Pay from Cash / Bank (USD)
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Select paying account"/></SelectTrigger>
            <SelectContent>
              {cashAccounts.map(account=><SelectItem key={account.id} value={String(account.id)}>
                {account.name} ({account.code})
              </SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>
      <details className="rounded-lg border bg-muted/10">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Bonus rates and settings</summary>
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">Standard rates are editable per worker in the table.
            Category rates use only categories shown in Production Targets.</p>
          <ProductionBonusCategoryRatesPanel initialDate={date} productionCategories={productionCategories}/>
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-xs">Historical weekly-flat method configuration</summary>
            <ProductionBonusWeeklyMethodPanel initialDate={date}/>
          </details>
        </div>
      </details>
      {error&&<p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {([
          ["Workers with extra bales",String(offers.filter(row=>row.extra>0).length)],
          ["Ready to pay",String(payable.length)],
          ["Selected workers",String(chosen.length)],
          ["Total to pay",usd(total)],
        ] as const).map(([label,value])=><div key={label} className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={!payable.length}
          onClick={()=>setSelected(allSelected?[]:payable.map(row=>row.workerId))}>
          {allSelected?"Clear selection":"Select all payable"}
        </Button>
        <span className="ml-auto text-sm font-semibold">{chosen.length} selected · {usd(total)}</span>
        <Button disabled={!chosen.length||!accountId||!paymentDate||pay.isPending}
          onClick={()=>setConfirmPay(true)}>
          <CheckCircle2 className="mr-2 h-4 w-4"/> Review &amp; Pay
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-12">Select</TableHead><TableHead>Worker / Category</TableHead>
            <TableHead className="text-right">Target</TableHead>
            <TableHead className="text-right">Made</TableHead>
            <TableHead className="text-right">Extra</TableHead>
            <TableHead className="text-right">Bonus</TableHead>
            <TableHead>Status / Action</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading&&<TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>Calculating bonus…
            </TableCell></TableRow>}
            {!isLoading&&!offers.length&&<TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
              No saved Production Targets workers for this date. Save the targets to calculate bonuses.
            </TableCell></TableRow>}
            {offers.map(offer=>{
              const ready=offer.status==="pending"||offer.status==="approved";
              const payment=(payments?.payments??[]).find(p=>p.workerId===offer.workerId);
              return <TableRow key={offer.workerId} className="align-top">
                <TableCell><Checkbox aria-label={"Select bonus "+offer.workerName}
                  checked={selected.includes(offer.workerId)} disabled={!ready}
                  onCheckedChange={checked=>setSelected(previous=>checked?
                    [...new Set([...previous,offer.workerId])]:
                    previous.filter(id=>id!==offer.workerId))}/></TableCell>
                <TableCell>
                  <div className="font-medium">{offer.workerName}</div>
                  {offer.lines.length>0&&<details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      <Calculator className="mr-1 inline h-3 w-3"/>Show calculation
                    </summary>
                    <div className="mt-2 space-y-1 whitespace-nowrap">
                      {offer.lines.map(line=><div key={line.category}>
                        {line.category}: {line.produced} made · {line.extra} extra × {usd(line.rate)} = {usd(line.bonus)}
                      </div>)}
                    </div>
                  </details>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{offer.target}</TableCell>
                <TableCell className="text-right tabular-nums">{offer.produced}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{offer.extra}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{usd(offer.amount)}</TableCell>
                <TableCell>
                  <Badge variant={offer.status==="paid"?"default":"secondary"}>{offer.status}</Badge>
                  {offer.issue&&<p className="mt-1 max-w-[240px] text-xs text-destructive">{offer.issue}</p>}
                  {method==="standard"&&offer.status==="pending"&&
                    <Button size="sm" variant="ghost" className="mt-1 h-7" onClick={()=>{
                      setEditingRate(offer);setNewRate(offer.lines[0]?.rate??"");
                    }}><Pencil className="mr-1 h-3 w-3"/> Edit rate</Button>}
                  {payment?.paymentStatus==="POSTED"&&
                    <Button size="sm" variant="outline" className="mt-1 h-7" onClick={()=>{
                      setReverse(payment);setReverseReason("");
                    }}><RotateCcw className="mr-1 h-3 w-3"/> Reverse</Button>}
                  {payment?.voucherId&&<p className="mt-1 text-[11px] text-muted-foreground">
                    Voucher #{payment.voucherId} · {payment.cashAccountName}
                  </p>}
                </TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Posting debits Payroll Deposit Expense and credits the selected Cash/Bank account.
        A paid worker/date is locked against duplicate payment. Reversals create a compensating receipt,
        not a second bonus or a deletion of historical audit records.
      </p>
    </CardContent>
    <Dialog open={confirmPay} onOpenChange={setConfirmPay}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Verify and pay production bonuses</DialogTitle>
          <DialogDescription>Check the workers, calculations and paying account before posting.
            This action approves and pays together.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[300px] overflow-y-auto rounded-lg border">
          {chosen.map(row=><div key={row.workerId} className="flex justify-between gap-2 border-b px-3 py-2 text-sm">
            <div><div className="font-medium">{row.workerName}</div>
              <div className="text-xs text-muted-foreground">{row.extra} extra bales · {row.method==="category"?"Category rates":"Standard rate"}</div>
            </div><strong className="tabular-nums">{usd(row.amount)}</strong>
          </div>)}
        </div>
        <div className="flex justify-between text-sm"><span>Payment from</span>
          <strong>{cashAccounts.find(a=>String(a.id)===accountId)?.name??"Not selected"}</strong></div>
        <div className="flex justify-between text-base font-bold"><span>Total</span><span>{usd(total)}</span></div>
        <DialogFooter>
          <Button variant="outline" onClick={()=>setConfirmPay(false)}>Cancel</Button>
          <Button disabled={pay.isPending||!chosen.length} onClick={()=>pay.mutate()}>
            {pay.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin"/>Approve &amp; Pay {usd(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(editingRate)} onOpenChange={open=>{if(!open)setEditingRate(null);}}>
      <DialogContent><DialogHeader><DialogTitle>Set per-extra-bale rate</DialogTitle>
        <DialogDescription>Save the dated rate for {editingRate?.workerName}.</DialogDescription>
      </DialogHeader>
      <label className="space-y-1 text-sm">USD per extra bale
        <Input type="number" min="0.0001" max="10000" step="0.0001" value={newRate}
          onChange={e=>setNewRate(e.target.value)}/>
      </label>
      <DialogFooter><Button variant="outline" onClick={()=>setEditingRate(null)}>Cancel</Button>
        <Button disabled={saveRate.isPending||!/^\d+(?:\.\d{1,4})?$/.test(newRate)||Number(newRate)<=0}
          onClick={()=>saveRate.mutate()}>Save rate</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(reverse)} onOpenChange={open=>{if(!open)setReverse(null);}}>
      <DialogContent><DialogHeader><DialogTitle>Reverse bonus payment</DialogTitle>
        <DialogDescription>Post a reversing accounting voucher and Daybook entry. This does not erase the audit trail.</DialogDescription>
      </DialogHeader>
      <label className="space-y-1 text-sm">Reason
        <Input value={reverseReason} onChange={event=>setReverseReason(event.target.value)}
          placeholder="Reason for reversing this payment"/></label>
      <DialogFooter><Button variant="outline" onClick={()=>setReverse(null)}>Cancel</Button>
        <Button variant="destructive" disabled={!reverseReason.trim()||reverseMutation.isPending}
          onClick={()=>reverseMutation.mutate()}>Confirm reversal</Button>
      </DialogFooter>
    </Dialog>
  </Card>;
}
