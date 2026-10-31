import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, CheckCircle2, Loader2, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText, type ProductionBonusTranslationKey } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { localDateStr } from "../factoryProductionTargetsModel";
import { ProductionBonusCategoryRatesPanel } from "./ProductionBonusCategoryRatesPanel";
import { ProductionBonusWeeklyMethodPanel } from "./ProductionBonusWeeklyMethodPanel";
import { ProductionBonusWeeklySheet } from "./ProductionBonusWeeklySheet";
import { ProductionBonusManualPaymentPanel, type ManualBonusHistory } from "./ProductionBonusManualPaymentPanel";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { ProductionBonusWeeklyPreviewPanel } from "./ProductionBonusWeeklyPreviewPanel";
import { ProductionTargetWeeklyBonusPaymentsPanel } from "./ProductionTargetWeeklyBonusPaymentsPanel";
import { isProductionWorkday } from "@shared/productionTargetBonusWeeklyMethod";

type Method = "standard" | "category";
type Line = { category: string; produced: number; extra: number; rate: string; bonus: string };
type Offer = {
  date: string; workerId: number; workerName: string; linkGroupId: number | null; category: string; target: number; produced: number;
  extra: number; method: Method; lines: Line[]; amount: string; token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "no_bonus" | "needs_setup" | "blocked" | "rejected" | "weekly";
  issue: string | null;
  weeklyBonus?: { weekStart: string; amount: string; state: "projected" | "approved" };
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
  // The default checkout period follows the production week (Monday onward).
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
  return d.toISOString().slice(0,10);
};
const payableStatus=(row:Offer)=>row.status==="pending"||row.status==="approved";
type WorkerGroup={workerId:number;workerName:string;days:Offer[];target:number;produced:number;
  extra:number;amount:number;weeklyAmount:number;weeklyProjected:boolean;weeklyApproved:boolean;
  readyDays:number;paidDays:number;needsSetup:number;blockedDays:number;weeklyDays:number};
function summarizeByWorker(offers:Offer[]):WorkerGroup[]{
  const map=new Map<number,WorkerGroup>();
  for(const row of offers){
    let group=map.get(row.workerId);
    if(!group){
      group={workerId:row.workerId,workerName:row.workerName,days:[],target:0,
        produced:0,extra:0,amount:0,weeklyAmount:0,weeklyProjected:false,weeklyApproved:false,
        readyDays:0,paidDays:0,needsSetup:0,blockedDays:0,weeklyDays:0};
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
    if(row.status==="weekly")group.weeklyDays++;
    if(row.weeklyBonus){
      group.weeklyAmount+=Math.round(Number(row.weeklyBonus.amount)*100);
      if(row.weeklyBonus.state==="projected")group.weeklyProjected=true;
      if(row.weeklyBonus.state==="approved")group.weeklyApproved=true;
    }
  }
  return [...map.values()].map(g=>({...g,amount:g.amount/100,weeklyAmount:g.weeklyAmount/100,
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
  const {language}=useApplicationLanguage();
  const t=(key:ProductionBonusTranslationKey)=>bonusText(key,language);
  const [from,setFrom]=useState(()=>startOfRange(initialDate));
  const [to,setTo]=useState(initialDate);
  const [method,setMethod]=useState<Method>("standard");
  const [selected,setSelected]=useState<number[]>([]);
  const [manualMode,setManualMode]=useState(true);
  const [manualSelected,setManualSelected]=useState<number[]>([]);
  const [manualAmounts,setManualAmounts]=useState<Record<number,string>>({});
  const [showAll,setShowAll]=useState(true);
  const [search,setSearch]=useState("");
  const [accountId,setAccountId]=useState("");
  const [paymentDate,setPaymentDate]=useState(()=>localDateStr(new Date()));
  const [confirmPay,setConfirmPay]=useState(false);
  const [editingRate,setEditingRate]=useState<Offer|null>(null);
  const [newRate,setNewRate]=useState("");
  const [reverse,setReverse]=useState<PaymentRow|null>(null);
  const [reverseReason,setReverseReason]=useState("");
  useEffect(()=>{setFrom(startOfRange(initialDate));setTo(initialDate);setSelected([]);setManualSelected([]);setManualAmounts({});setSearch("");setShowAll(true);},[initialDate]);
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
  const manualWeekStart=mondayOfProductionBonusWeek(to)??"";
  const {data:manualHistory}=useQuery<ManualBonusHistory>({
    queryKey:["/api/factory/production-target-bonuses/checkout/manual-payments",manualWeekStart],
    queryFn:()=>request("GET","/api/factory/production-target-bonuses/checkout/manual-payments?"+
      new URLSearchParams({weekStart:manualWeekStart})),
    enabled:canUse&&Boolean(manualWeekStart),
  });
  const manuallyPaidIds=(manualHistory?.payments??[]).filter(row=>row.status==="POSTED")
    .map(row=>row.workerId);
  const cashAccounts=(accounts?.accounts??[]).filter(a=>
    !a.openingCurrency||a.openingCurrency.toUpperCase()==="USD");
  // Sunday is a factory holiday; stale cached API data must never enable Sunday payout.
  const offers=(data?.offers??[]).filter(row=>isProductionWorkday(row.date));
  const groups=useMemo(()=>summarizeByWorker(offers),[offers]);
  const chosen=useMemo(()=>offers.filter(row=>
    selected.includes(row.workerId)&&payableStatus(row)),
  [offers,selected]);
  const selectedGroups=groups.filter(group=>selected.includes(group.workerId)&&group.readyDays>0);
  const total=chosen.reduce((sum,row)=>sum+Math.round(Number(row.amount)*100),0)/100;
  const payableGroups=groups.filter(group=>group.readyDays>0);
  const includesWeeklyBonuses=groups.some(group=>group.weeklyDays>0);
  const projectedWeeklyWorkers=groups.filter(group=>group.weeklyProjected).length;
  const searchTerm=search.trim().toLocaleLowerCase();
  const matchingGroups=groups.filter(group=>
    group.workerName.toLocaleLowerCase().includes(searchTerm));
  const matchingLinkIds=new Set(matchingGroups.flatMap(group=>
    group.days.map(day=>day.linkGroupId).filter((id):id is number=>id!=null)));
  // A name search retains linked teammates so the relationship stays visible.
  const visibleGroups=groups.filter(group=>
    (manualMode||showAll||group.readyDays>0)&&
    (group.workerName.toLocaleLowerCase().includes(searchTerm)||
      (searchTerm!==""&&group.days.some(day=>
        day.linkGroupId!=null&&matchingLinkIds.has(day.linkGroupId)))));
  const visiblePayableGroups=visibleGroups.filter(group=>group.readyDays>0);
  const manualSelectableGroups=visibleGroups.filter(group=>!manuallyPaidIds.includes(group.workerId));
  const selectableGroups=manualMode?manualSelectableGroups:visiblePayableGroups;
  const activeSelection=manualMode?manualSelected:selected;
  const allSelected=selectableGroups.length>0&&
    selectableGroups.every(group=>activeSelection.includes(group.workerId));
  const tooMany=chosen.length>100;
  const pay=useMutation({
    mutationFn:()=>request<{posted:number;replayed:number}>("POST",endpoint+"/pay",{ // data-no-translate: TypeScript generic, not user-visible JSX
      method,rosterDate:to,confirm:true,currency:"USD",paymentDate,cashAccountId:Number(accountId),
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
      workerId:editingRate!.workerId,effectiveFrom:localDateStr(new Date()),ratePerBale:newRate,
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
  return <Card data-testid="production-bonus-checkout" className="overflow-hidden border-border/70 shadow-xs">
    <CardContent className="space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Banknote className="h-5 w-5"/>
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t("payWorkers")}</h2>
          <p className="text-sm text-muted-foreground">{t("payIntro")}</p>
        </div>

      </div>

      <div className="grid gap-3 rounded-xl border border-border/70 bg-card/60 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">{t("fromDate")}
          <Input aria-label={t("fromDate")} type="date" value={from}
            onChange={event=>{setFrom(event.target.value);setSelected([]);}} className="h-10"/>
        </label>
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">{t("toDate")}
          <Input aria-label={t("toDate")} type="date" value={to}
            onChange={event=>{setTo(event.target.value);setSelected([]);}} className="h-10"/>
        </label>
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">{t("method")}
          <Select value={method} onValueChange={value=>{setMethod(value as Method);setSelected([]);}}>
            <SelectTrigger className="h-10"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t("standard")}</SelectItem>
              <SelectItem value="category">{t("category")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>

      {!validRange&&<p role="alert" className="text-sm text-destructive">{t("invalidRange")}</p>}
      {error&&<p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-medium">{payableGroups.length} {t("ready")}</span>
        <span className="text-sm text-muted-foreground">{groups.length} {t("totalWorkers")}</span>
        {includesWeeklyBonuses && <span className="rounded-full border border-indigo-500/25 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
          {projectedWeeklyWorkers} weekly bonuses projected · select after weekly approval below
        </span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
        <span className="mr-2 text-sm font-semibold">Payment type</span>
        <Button type="button" size="sm" variant={manualMode?"default":"outline"}
          onClick={()=>{setManualMode(true);setShowAll(true);}}>
          Enter amount to pay
        </Button>
        <Button type="button" size="sm" variant={!manualMode?"default":"outline"}
          onClick={()=>setManualMode(false)}>
          Calculated daily bonus
        </Button>
        <span className="text-xs text-muted-foreground">
          {manualMode?"Select anyone in the sheet and enter a USD amount.":"Only approved/eligible calculated daily bonuses can be selected."}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 lg:flex-row lg:items-center lg:justify-between">
        <Input value={search} onChange={event=>setSearch(event.target.value)}
          aria-label={t("searchWorkers")} placeholder={t("searchWorkers")}
          className="h-10 w-full lg:max-w-xs"/>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
            {!manualMode&&<Button type="button" size="sm" variant={!showAll?"secondary":"ghost"} className="h-8"
              onClick={()=>setShowAll(false)}>{t("showPayable")}</Button>}
            <Button type="button" size="sm" variant={showAll?"secondary":"ghost"} className="h-8"
              onClick={()=>setShowAll(true)}>{t("showEveryone")}</Button>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={!selectableGroups.length}
            onClick={()=>{
              const ids=selectableGroups.map(group=>group.workerId);
              if(manualMode)setManualSelected(previous=>allSelected?
                previous.filter(id=>!ids.includes(id)):[...new Set([...previous,...ids])]);
              else setSelected(previous=>allSelected?
                previous.filter(id=>!ids.includes(id)):[...new Set([...previous,...ids])]);
            }}>
            {allSelected?t("clear"):t("selectAll")}
          </Button>
        </div>
      </div>

      {!manualMode && !isLoading && groups.length > 0 && payableGroups.length === 0 && <div role="status"
        className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-sm text-foreground">
        <strong>No payable daily bonuses in this date range.</strong>{" "}
        {includesWeeklyBonuses
          ? "The amounts marked Bonus projected are weekly-flat estimates, not payable daily bonuses. Complete and approve the week, then use Weekly Bonus Review & Pay below to select workers."
          : "Only bonuses with positive, approved or pending extra-bale amounts can be selected. Check rates, targets, and approval status."}
      </div>}
      <ProductionBonusWeeklySheet from={from} to={to}
        workers={visibleGroups} loading={isLoading} selected={activeSelection}
        manualMode={manualMode} manualAmounts={manualAmounts} manuallyPaidIds={manuallyPaidIds}
        onAmountChange={(workerId,amount)=>setManualAmounts(previous=>({...previous,[workerId]:amount}))}
        onToggle={(workerId,checked)=>{
          const update=(previous:number[])=>checked?
            [...new Set([...previous,workerId])]:previous.filter(id=>id!==workerId);
          if(manualMode)setManualSelected(update);
          else setSelected(update);
        }}
        renderDayActions={(workerId,date)=>{
          const day=offers.find(row=>row.workerId===workerId&&row.date===date);
          if(!day)return null;
          const payment=(payments?.payments??[]).find(row=>
            row.workerId===workerId&&row.date===date);
          const canEditRate=method==="standard"&&day.extra>0&&(
            day.status==="pending"||day.status==="approved"||
            (day.status==="needs_setup"&&day.issue?.includes("rate")));
          if(!canEditRate&&payment?.paymentStatus!=="POSTED")return null;
          return <div className="mt-1 flex flex-wrap justify-center gap-1">
            {canEditRate&&<Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
              onClick={()=>{setEditingRate(day);setNewRate(day.lines[0]?.rate??"");}}>
              <Pencil className="mr-1 h-3 w-3"/>{t("editRate")}
            </Button>}
            {payment?.paymentStatus==="POSTED"&&<Button type="button" size="sm" variant="outline"
              className="h-7 px-2 text-xs" onClick={()=>{setReverse(payment);setReverseReason("");}}>
              <RotateCcw className="mr-1 h-3 w-3"/>{t("reverse")}
            </Button>}
          </div>;
        }}/>

      {manualMode&&<ProductionBonusManualPaymentPanel rosterDate={to} workers={groups}
        selected={manualSelected} amounts={manualAmounts}
        onReset={()=>{setManualSelected([]);setManualAmounts({});}}/>}
      {includesWeeklyBonuses && <details className="overflow-hidden rounded-xl border border-indigo-500/25 bg-card"
        data-testid="production-bonus-weekly-pay-section">
        <summary className="cursor-pointer bg-indigo-500/[0.07] px-4 py-3 text-sm font-semibold text-foreground">
          Weekly Bonus Review & Pay — approve, select workers, and post approved amounts
        </summary>
        <div className="space-y-4 border-t border-indigo-500/20 p-3 sm:p-4">
          <p className="text-sm text-muted-foreground">
            Weekly bonuses shown in the sheet cannot be paid through daily checkout.
            First approve a completed week below, then tick individual approved workers in
            Weekly Flat Bonus Payments. The calculated amount is locked for accounting;
            change the configured weekly bonus rate before approval if needed.
          </p>
          <ProductionBonusWeeklyMethodPanel initialDate={to}/>
          <ProductionBonusWeeklyPreviewPanel initialDate={to}/>
          <ProductionTargetWeeklyBonusPaymentsPanel initialDate={to}/>
        </div>
      </details>}
      {!manualMode&&<div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-medium">{selectedGroups.length} {t("selected")}</div>
          <div className="text-2xl font-bold tabular-nums">{usd(total)}</div>
          <div className="text-xs text-muted-foreground">
            Daily total is calculated, not freely editable. Use Edit Rate on an eligible day to update an unpaid per-bale bonus.
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            {t("payFrom")}
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="h-10 w-[230px]" aria-label={t("payFrom")}>
                <SelectValue placeholder={t("chooseAccount")}/>
              </SelectTrigger>
              <SelectContent>{cashAccounts.map(account=>
                <SelectItem key={account.id} value={String(account.id)}>
                  {account.name} ({account.code})
                </SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            {t("paymentDate")}
            <Input type="date" aria-label={t("paymentDate")}
              className="h-10 w-[165px]" value={paymentDate}
              onChange={event=>setPaymentDate(event.target.value)}/>
          </label>
          <Button className="h-10 sm:min-w-[170px]"
            disabled={!chosen.length||!validRange||tooMany||pay.isPending}
            onClick={()=>setConfirmPay(true)}>
            <CheckCircle2 className="mr-2 h-4 w-4"/>{t("reviewPay")}
          </Button>
        </div>
      </div>}
      {!manualMode&&tooMany&&<p role="alert" className="text-sm text-destructive">{t("max100")}</p>}

      <details className="rounded-lg border border-border/70">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t("settings")}</summary>
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">{t("settingsHint")}</p>
          <ProductionBonusCategoryRatesPanel initialDate={from}/>
          {!includesWeeklyBonuses && <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-xs">{t("legacy")}</summary>
            <ProductionBonusWeeklyMethodPanel initialDate={to}/>
          </details>}
        </div>
      </details>
    </CardContent>

    <Dialog open={confirmPay} onOpenChange={setConfirmPay}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>{t("confirmHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">{t("payFrom")}
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger><SelectValue placeholder={t("chooseAccount")}/></SelectTrigger>
              <SelectContent>
                {cashAccounts.map(account=><SelectItem key={account.id} value={String(account.id)}>
                  {account.name} ({account.code})
                </SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1.5 text-sm">{t("paymentDate")}
            <Input aria-label={t("paymentDate")} type="date" value={paymentDate}
              onChange={event=>setPaymentDate(event.target.value)}/>
          </label>
        </div>
        <div className="max-h-[250px] overflow-y-auto rounded-lg border">
          {chosen.map(row=><div key={row.date+":"+row.workerId} className="flex justify-between gap-2 border-b px-3 py-2 text-sm">
            <div><div className="font-medium">{row.workerName}</div>
              <div className="text-xs text-muted-foreground">{row.date} · {row.extra} {t("extraBales")}</div>
            </div><strong className="tabular-nums">{usd(row.amount)}</strong>
          </div>)}
        </div>
        <div className="flex justify-between text-base font-bold">
          <span>{t("total")}</span><span>{usd(total)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={()=>setConfirmPay(false)}>{t("cancel")}</Button>
          <Button disabled={pay.isPending||!chosen.length||!accountId||!isDate(paymentDate)||tooMany}
            onClick={()=>pay.mutate()}>
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
