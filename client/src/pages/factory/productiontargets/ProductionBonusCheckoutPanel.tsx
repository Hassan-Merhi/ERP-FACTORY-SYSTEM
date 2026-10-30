import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
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
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText, type ProductionBonusTranslationKey } from "@/i18n/factoryProductionBonusCheckoutTranslations";
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
  status: "pending" | "approved" | "paid" | "reversed" | "no_bonus" | "needs_setup" | "blocked" | "rejected";
  issue: string | null;
};
type Preview = { from: string; to: string; method: Method; currency: "USD"; offers: Offer[] };
type Account = { id: number; name: string; code: string; openingCurrency: string | null };
type PaymentRow = { reviewId: number; workerId: number; date: string; paymentId: number | null;
  paymentStatus: "POSTED" | "REVERSED" | null; cashAccountName: string | null; voucherId: number | null };
const endpoint="/api/factory/production-target-bonuses/checkout";
const isDate=(date:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const timestamp=Date.parse(date+"T12:00:00Z");
  return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===date;
};
const daysApart=(from:string,to:string)=>Math.round(
  (Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000);
const startOfRange=(date:string)=>{
  if(!isDate(date))return date;
  const d=new Date(date+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()-6);
  return d.toISOString().slice(0,10);
};
const payableStatus=(row:Offer)=>row.status==="pending"||row.status==="approved";
type WorkerGroup={workerId:number;workerName:string;days:Offer[];target:number;produced:number;
  extra:number;amount:number;readyDays:number;paidDays:number;needsSetup:number;blockedDays:number};
function summarizeByWorker(offers:Offer[]):WorkerGroup[]{
  const map=new Map<number,WorkerGroup>();
  for(const row of offers){
    let group=map.get(row.workerId);
    if(!group){
      group={workerId:row.workerId,workerName:row.workerName,days:[],target:0,
        produced:0,extra:0,amount:0,readyDays:0,paidDays:0,needsSetup:0,blockedDays:0};
      map.set(row.workerId,group);
    }
    group.days.push(row);
    group.target+=row.target;
    group.produced+=row.produced;
    group.extra+=row.extra;
    if(payableStatus(row)){
      group.readyDays++;
      group.amount+=Math.round(Number(row.amount)*100);
    }
    if(row.status==="paid")group.paidDays++;
    if(row.status==="needs_setup")group.needsSetup++;
    if(row.status==="blocked")group.blockedDays++;
  }
  return [...map.values()].map(g=>({...g,amount:g.amount/100,
    days:g.days.sort((a,b)=>a.date.localeCompare(b.date))}))
    .sort((a,b)=>a.workerName.localeCompare(b.workerName));
}
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
export function ProductionBonusCheckoutPanel({initialDate}: {initialDate:string}) {
  const {toast}=useToast();
  const [,navigate]=useLocation();
  const {language}=useApplicationLanguage();
  const t=(key:ProductionBonusTranslationKey)=>bonusText(key,language);
  const [from,setFrom]=useState(()=>startOfRange(initialDate));
  const [to,setTo]=useState(initialDate);
  const [method,setMethod]=useState<Method>("standard");
  const [selected,setSelected]=useState<number[]>([]);
  const [accountId,setAccountId]=useState("");
  const [paymentDate,setPaymentDate]=useState(()=>localDateStr(new Date()));
  const [confirmPay,setConfirmPay]=useState(false);
  const [editingRate,setEditingRate]=useState<Offer|null>(null);
  const [newRate,setNewRate]=useState("");
  const [reverse,setReverse]=useState<PaymentRow|null>(null);
  const [reverseReason,setReverseReason]=useState("");
  useEffect(()=>{setFrom(startOfRange(initialDate));setTo(initialDate);setSelected([]);},[initialDate]);
  const validRange=isDate(from)&&isDate(to)&&from<=to&&daysApart(from,to)<=31;
  const {data:access}=useQuery<{canDecide:boolean}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses",from,from],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses?"+
      new URLSearchParams({start:from,end:from})),
    enabled:validRange,
  });
  const canUse=access?.canDecide===true;
  const {data,error,isLoading}=useQuery<Preview>({
    queryKey:[endpoint,from,to,method],
    queryFn:()=>request("GET",endpoint+"?"+new URLSearchParams({from,to,method})),
    enabled:canUse&&validRange,
  });
  const {data:accounts}=useQuery<{accounts:Account[]}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses/payment-accounts"),
    enabled:canUse,
  });
  const {data:payments}=useQuery<{payments:PaymentRow[]}>({
    queryKey:["/api/factory/staff-tracking/production-bonuses/payments",from,to],
    queryFn:()=>request("GET","/api/factory/staff-tracking/production-bonuses/payments?"+
      new URLSearchParams({start:from,end:to})),
    enabled:canUse&&validRange,
  });
  const cashAccounts=(accounts?.accounts??[]).filter(a=>
    !a.openingCurrency||a.openingCurrency.toUpperCase()==="USD");
  const offers=data?.offers??[];
  const groups=useMemo(()=>summarizeByWorker(offers),[offers]);
  const payable=offers.filter(payableStatus);
  const chosen=useMemo(()=>offers.filter(row=>
    selected.includes(row.workerId)&&payableStatus(row)),
  [offers,selected]);
  const selectedGroups=groups.filter(group=>selected.includes(group.workerId)&&group.readyDays>0);
  const total=chosen.reduce((sum,row)=>sum+Math.round(Number(row.amount)*100),0)/100;
  const allSelected=payable.length>0&&groups.filter(group=>group.readyDays>0)
    .every(group=>selected.includes(group.workerId));
  const tooMany=chosen.length>100;
  const pay=useMutation({
    mutationFn:()=>request<{posted:number;replayed:number}>("POST",endpoint+"/pay",{ // data-no-translate: TypeScript generic, not user-visible JSX
      method,confirm:true,currency:"USD",paymentDate,cashAccountId:Number(accountId),
      selections:chosen.map(row=>({date:row.date,workerId:row.workerId,
        expectedAmount:row.amount,token:row.token})),
    }),
    onSuccess:result=>{
      setConfirmPay(false);setSelected([]);
      toast({title:t("paidToast"),
        description:result.posted+" "+t("paidDesc")+" "+result.replayed+" "+t("retryDesc")});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/staff-tracking/production-bonuses"]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/production-target-bonuses/report"]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/worker-bonuses"]});
    },
    onError:(error:Error)=>{
      setConfirmPay(false);toast({title:t("payFailed"),description:error.message,variant:"destructive"});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
    },
  });
  const saveRate=useMutation({
    mutationFn:()=>request("POST","/api/factory/staff-tracking/production-bonuses/rate",{
      workerId:editingRate!.workerId,effectiveFrom:editingRate!.date,ratePerBale:newRate,
    }),
    onSuccess:()=>{
      setEditingRate(null);toast({title:t("rateSaved")});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
    },
    onError:(error:Error)=>toast({title:t("rateFailed"),description:error.message,variant:"destructive"}),
  });
  const reverseMutation=useMutation({
    mutationFn:()=>request("POST",
      "/api/factory/staff-tracking/production-bonuses/payments/"+reverse!.paymentId+"/reverse",{
        confirm:true,reversalDate:paymentDate,reason:reverseReason,
      }),
    onSuccess:()=>{
      setReverse(null);setReverseReason("");toast({title:t("reversedToast")});
      void queryClient.invalidateQueries({queryKey:[endpoint]});
      void queryClient.invalidateQueries({queryKey:["/api/factory/staff-tracking/production-bonuses/payments"]});
    },
    onError:(error:Error)=>toast({title:t("reverseFailed"),description:error.message,variant:"destructive"}),
  });
  if(!canUse)return null;
  return <Card data-testid="production-bonus-checkout" className="overflow-hidden shadow-none">
    <CardHeader className="border-b bg-muted/20">
      <CardTitle className="flex items-center gap-2 text-lg"><Banknote className="h-5 w-5 text-primary"/>{t("title")}</CardTitle>
      <p className="text-sm text-muted-foreground">
        {t("intro")}
      </p>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">{t("fromDate")}
          <Input aria-label={t("fromDate")} type="date" value={from}
            onChange={event=>{setFrom(event.target.value);setSelected([]);}} className="w-[170px]"/>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">{t("toDate")}
          <Input aria-label={t("toDate")} type="date" value={to}
            onChange={event=>{setTo(event.target.value);setSelected([]);}} className="w-[170px]"/>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">{t("method")}
          <Select value={method} onValueChange={value=>{setMethod(value as Method);setSelected([]);}}>
            <SelectTrigger className="min-w-[220px]"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t("standard")}</SelectItem>
              <SelectItem value="category">{t("category")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">{t("paymentDate")}
          <Input aria-label={t("paymentDate")} type="date" value={paymentDate}
            onChange={event=>setPaymentDate(event.target.value)} className="w-[170px]"/>
        </label>
        <label className="min-w-[230px] flex-1 space-y-1 text-xs text-muted-foreground">{t("payFrom")}
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder={t("chooseAccount")}/></SelectTrigger>
            <SelectContent>
              {cashAccounts.map(account=><SelectItem key={account.id} value={String(account.id)}>
                {account.name} ({account.code})
              </SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>
      <details className="rounded-lg border bg-muted/10">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t("settings")}</summary>
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">{t("settingsHint")}</p>
          <ProductionBonusCategoryRatesPanel initialDate={from}/>
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-xs">{t("legacy")}</summary>
            <ProductionBonusWeeklyMethodPanel initialDate={to}/>
          </details>
        </div>
      </details>
      {!validRange&&<p role="alert" className="text-sm text-destructive">{t("invalidRange")}</p>}
      {error&&<p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
      <p className="text-xs text-muted-foreground">{t("rangeExplanation")}</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {([
          [t("workersExtra"),String(groups.filter(group=>group.extra>0).length)],
          [t("ready"),String(groups.filter(group=>group.readyDays>0).length)],
          [t("selected"),String(selectedGroups.length)],
          [t("totalPay"),usd(total)],
        ] as const).map(([label,value])=><div key={label} className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={!payable.length}
          onClick={()=>setSelected(allSelected?[]:groups.filter(group=>group.readyDays>0).map(group=>group.workerId))}>
          {allSelected?t("clear"):t("selectAll")}
        </Button>
        <span className="ml-auto text-sm font-semibold">{selectedGroups.length} {t("selected")} · {usd(total)}</span>
        <Button disabled={!chosen.length||!accountId||!paymentDate||!validRange||tooMany||pay.isPending}
          onClick={()=>setConfirmPay(true)}>
          <CheckCircle2 className="mr-2 h-4 w-4"/> {t("reviewPay")}
        </Button>
      </div>
      {tooMany&&<p role="alert" className="text-sm text-destructive">{t("max100")}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-12">{t("select")}</TableHead><TableHead>{t("workerCategory")}</TableHead>
            <TableHead className="text-right">{t("target")}</TableHead>
            <TableHead className="text-right">{t("made")}</TableHead>
            <TableHead className="text-right">{t("extra")}</TableHead>
            <TableHead className="text-right">{t("bonus")}</TableHead>
            <TableHead>{t("statusAction")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading&&<TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{t("loading")}
            </TableCell></TableRow>}
            {!isLoading&&!groups.length&&<TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
              {t("noRows")}
            </TableCell></TableRow>}
            {groups.map(group=>{
              const ready=group.readyDays>0;
              const label=ready?t("ready"):group.needsSetup>0?t("needsSetup"):
                group.blockedDays>0?t("needsReview"):group.paidDays>0?t("paidStatus"):t("noBonus");
              return <TableRow key={group.workerId} className="align-top">
                <TableCell><Checkbox aria-label={t("selectBonus")+" "+group.workerName}
                  checked={selected.includes(group.workerId)} disabled={!ready}
                  onCheckedChange={checked=>setSelected(previous=>checked?
                    [...new Set([...previous,group.workerId])]:
                    previous.filter(id=>id!==group.workerId))}/></TableCell>
                <TableCell>
                  <div className="font-medium">{group.workerName}</div>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      <Calculator className="mr-1 inline h-3 w-3"/>{t("dailyDetails")}
                    </summary>
                    <div className="mt-2 space-y-2 min-w-[290px]">
                      {group.days.map(day=>{
                        const payment=(payments?.payments??[]).find(p=>p.workerId===day.workerId&&p.date===day.date);
                        return <div key={day.date} className="rounded border p-2">
                          <div className="font-medium">{day.date}: {t("target")} {day.target}, {t("made")} {day.produced},
                            {" "}{t("extra")} {day.extra} · {usd(day.amount)}</div>
                          <div className="text-muted-foreground">{day.issue??(
                            day.status==="paid"?t("paidStatus"):day.status==="no_bonus"?t("noBonus"):day.status)}</div>
                          {day.lines.map(line=><div key={line.category} className="text-muted-foreground">
                            {line.category}: {line.produced} {t("lineMade")} · {line.extra} {t("lineExtra")}
                            {" "}× {usd(line.rate)} = {usd(line.bonus)}
                          </div>)}
                          {method==="standard" && day.extra>0 && day.status==="needs_setup" &&
                           day.issue?.includes("rate")&&<Button size="sm" variant="outline" className="mt-1 h-7"
                             onClick={()=>{setEditingRate(day);setNewRate(day.lines[0]?.rate??"");}}>
                              <Pencil className="mr-1 h-3 w-3"/>{t("editRate")}
                            </Button>}
                          {payment?.paymentStatus==="POSTED"&&<Button size="sm" variant="outline"
                            className="mt-1 h-7" onClick={()=>{setReverse(payment);setReverseReason("");}}>
                            <RotateCcw className="mr-1 h-3 w-3"/>{t("reverse")}
                          </Button>}
                        </div>;
                      })}
                    </div>
                  </details>
                </TableCell>
                <TableCell className="text-right tabular-nums">{group.target}</TableCell>
                <TableCell className="text-right tabular-nums">{group.produced}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{group.extra}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{usd(group.amount)}</TableCell>
                <TableCell>
                  <Badge variant={ready?"default":"secondary"}>{label}</Badge>
                  {group.needsSetup>0&&<p className="mt-1 text-xs text-amber-600">
                    {group.needsSetup} {t("daysNeedSetup")}</p>}
                  {group.blockedDays>0&&<p className="mt-1 text-xs text-destructive">
                    {group.blockedDays} {t("daysNeedReview")}</p>}
                  {group.needsSetup>0&&group.days.some(day=>day.issue?.startsWith("Save a positive"))&&
                    <Button variant="outline" size="sm" className="mt-1 h-7"
                      onClick={()=>navigate("/factory/stock-entry?tab=production-targets")}>
                      {t("editTargets")}
                    </Button>}
                  {ready&&<p className="mt-1 text-xs text-muted-foreground">
                    {group.readyDays} {t("payableDays")}</p>}
                </TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("historyHint")}
      </p>
    </CardContent>
    <Dialog open={confirmPay} onOpenChange={setConfirmPay}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>{t("confirmHint")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[300px] overflow-y-auto rounded-lg border">
          {chosen.map(row=><div key={row.date+":"+row.workerId} className="flex justify-between gap-2 border-b px-3 py-2 text-sm">
            <div><div className="font-medium">{row.workerName}</div>
              <div className="text-xs text-muted-foreground">{row.date} · {row.extra} {t("extraBales")} · {row.method==="category"?t("categoryRates"):t("standardRate")}</div>
            </div><strong className="tabular-nums">{usd(row.amount)}</strong>
          </div>)}
        </div>
        <div className="flex justify-between text-sm"><span>{t("payingFrom")}</span>
          <strong>{cashAccounts.find(a=>String(a.id)===accountId)?.name??t("notSelected")}</strong></div>
        <div className="flex justify-between text-base font-bold"><span>{t("total")}</span><span>{usd(total)}</span></div>
        <DialogFooter>
          <Button variant="outline" onClick={()=>setConfirmPay(false)}>{t("cancel")}</Button>
          <Button disabled={pay.isPending||!chosen.length||tooMany} onClick={()=>pay.mutate()}>
            {pay.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin"/>}{t("approvePay")} {usd(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(editingRate)} onOpenChange={open=>{if(!open)setEditingRate(null);}}>
      <DialogContent><DialogHeader><DialogTitle>{t("rateTitle")}</DialogTitle>
        <DialogDescription>{t("rateHint")} {editingRate?.workerName}.</DialogDescription>
      </DialogHeader>
      <label className="space-y-1 text-sm">{t("perExtra")}
        <Input type="number" min="0.0001" max="10000" step="0.0001" value={newRate}
          onChange={e=>setNewRate(e.target.value)}/>
      </label>
      <DialogFooter><Button variant="outline" onClick={()=>setEditingRate(null)}>{t("cancel")}</Button>
        <Button disabled={saveRate.isPending||!/^\d+(?:\.\d{1,4})?$/.test(newRate)||Number(newRate)<=0}
          onClick={()=>saveRate.mutate()}>{t("saveRate")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(reverse)} onOpenChange={open=>{if(!open)setReverse(null);}}>
      <DialogContent><DialogHeader><DialogTitle>{t("reverseTitle")}</DialogTitle>
        <DialogDescription>{t("reverseHint")}</DialogDescription>
      </DialogHeader>
      <label className="space-y-1 text-sm">{t("reason")}
        <Input value={reverseReason} onChange={event=>setReverseReason(event.target.value)}
          placeholder={t("reasonHint")}/></label>
      <DialogFooter><Button variant="outline" onClick={()=>setReverse(null)}>{t("cancel")}</Button>
        <Button variant="destructive" disabled={!reverseReason.trim()||reverseMutation.isPending}
          onClick={()=>reverseMutation.mutate()}>{t("confirmReverse")}</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
