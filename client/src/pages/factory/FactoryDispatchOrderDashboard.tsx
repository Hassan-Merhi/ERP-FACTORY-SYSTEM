/**
 * Phase 9 — responsive financial reporting surface on the existing dispatch
 * management page. Supervisor-only; factory workers retain physical dispatch
 * controls but never see sensitive receivables, rates or ledger accounts.
 */
import { useMemo,useState } from "react";
import { useInfiniteQuery,useQuery } from "@tanstack/react-query";
import {
  Activity,AlertTriangle,CheckCheck,ChevronDown,ClipboardList,Download,
  FileSpreadsheet,FileText,History,Loader2,Package,ReceiptText,RefreshCw,
  ShieldCheck,Truck,Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useDateFormat } from "@/contexts/DateFormatContext";

type Section="TRIPS"|"CHARGES"|"PO_FILES"|"HISTORY";
type Source="ALL"|"PHYSICAL"|"FINANCIAL"|"CLOSURE";
interface Trip {
  id:string;dispatchNumber:number;status:string;notes:string|null;
  closedAt:string|null;scannedBales:number;scannedWeightKg:string;
  financialStatus:string;postingRevision:number;postingId:string|null;
  goodsSubtotal:string|null;billableCharges:string|null;
  discounts:string|null;customerTotal:string|null;postedAt:string|null;
  exportedAt:string|null;poNumber:string|null;erpContainerNumber:string|null;
  supplierCode:string|null;erpImportStatus:"NOT_TRACKED_MANUAL"|"NOT_EXPORTED";
}
interface Charge {
  id:string;dispatchId:string|null;dispatchNumber:number|null;name:string;
  kind:"BILLABLE"|"DISCOUNT"|"INTERNAL"|"ORDER";amount:string;
  accountCode:string|null;accountName:string|null;
  offsetAccountCode:string|null;postedVoucherId:string|null;
  status:"POSTED"|"DRAFT"|"UNLINKED";
}
interface Overview {
  generatedAt:string;schemaReady:boolean;companyId:number;
  order:{id:number;status:string;containerNumber:string|null;
    customerName:string|null;invoiceNumber:string|null;grandTotal:string;deleted:boolean};
  summary:{tripCount:number;closedTrips:number;openTrips:number;
    originalLoadingBales:number;scannedBales:number;uniqueScannedBales:number;
    unshippedBales:number;unexpectedScannedBales:number;
    goodsSubtotal:string|null;billableCharges:string|null;discounts:string|null;
    tripCustomerTotal:string|null;originalOrderCharges:string|null;
    invoiceTotal:string|null;internalExpenses:string|null;generatedPoFiles:number;
    signed:boolean;finalized:boolean;invoiceConsistent:boolean};
  invoice:null|{status:string;invoiceNumber:string|null;
    signedAt:string|null;signedBy:string|null;finalizedAt:string|null;
    includedPostingIds:string[];finalizationVoucherIds:string[]};
  trips:Trip[];charges:Charge[];notices:string[];
}
interface ReleaseGate {
  reconciliation:{ready:boolean;missing:string[];checkedAt:string};
  invoice:{ready:boolean;missing:string[];checkedAt:string};
  integrity:null|{
    finalized:boolean;signedReconciliation:boolean;passed:boolean;verifiedAt:string;
    checks:Array<{code:string;state:"PASS"|"BLOCK"|"INFO"|"NOT_APPLICABLE";
      message:string;expected?:string;observed?:string}>;
  };
}
interface HistoryEntry {
  source:"PHYSICAL"|"FINANCIAL"|"CLOSURE";id:string;
  dispatchId:string|null;eventType:string;actorUsername:string;
  createdAt:string;reason:string|null;details:Record<string,unknown>;
}
interface HistoryPage {
  entries:HistoryEntry[];nextCursor:string|null;hasMore:boolean;
  financialSchemaInstalled:boolean;
}
interface Props {
  orderId:number;
  companyId:number|null|undefined;
  onOpenTrip:(dispatchId:number)=>void;
  onCompareAll:()=>void;
  onPhysicalReport:()=>void;
}
const fmtAmount=(v:string|null|undefined):string=>
  v===null||v===undefined?"—":Number(v).toLocaleString(undefined,{
    minimumFractionDigits:2,maximumFractionDigits:2,
  });
const fmtCount=(v:number)=>v.toLocaleString();
async function json<T>(url:string):Promise<T>{
  const result=await fetch(url,{
    credentials:"include",cache:"no-store",
    headers:{Accept:"application/json","Cache-Control":"no-cache"},
  });
  const type=(result.headers.get("content-type")??"").toLowerCase();
  if(!type.includes("application/json")){
    throw new Error("The dispatch reporting API did not return JSON. Confirm the correct backend is deployed.");
  }
  const data=await result.json();
  if(!result.ok)throw new Error(data.message||"Dispatch reporting failed");
  return data as T;
}
const headerButton=(active:boolean)=>(
  active?"bg-blue-600 text-white shadow-sm hover:bg-blue-700":
    "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
);
export default function FactoryDispatchOrderDashboard({
  orderId,companyId,onOpenTrip,onCompareAll,onPhysicalReport,
}:Props){
  const {formatDisplayDateTime}=useDateFormat();
  const [section,setSection]=useState<Section>("TRIPS");
  const [source,setSource]=useState<Source>("ALL");
  const [filterTrip,setFilterTrip]=useState("ALL");
  const [search,setSearch]=useState("");
  const [expanded,setExpanded]=useState<string|null>(null);
  const base="/api/factory/customer-orders/"+orderId+"/loading-dispatches/order-overview";
  const scopeKey=companyQueryKey(base,companyId);
  const info=useQuery<Overview>({
    queryKey:scopeKey,
    queryFn:()=>json<Overview>(base),
    enabled:Boolean(companyId)&&Number.isSafeInteger(orderId)&&orderId>0,
    refetchInterval:20000,
  });
  const gate=useQuery<ReleaseGate>({
    queryKey:companyQueryKey(base.replace("/order-overview","/release-readiness"),companyId),
    queryFn:()=>json<ReleaseGate>(base.replace("/order-overview","/release-readiness")),
    enabled:Boolean(companyId) && Number.isSafeInteger(orderId) && orderId>0,
    // Run automatically and refresh after the order-level evidence changes.
    staleTime:0,refetchInterval:20000,refetchOnWindowFocus:true,
  });
  const value=info.data;
  const history=useInfiniteQuery<HistoryPage,Error>({
    queryKey:[...scopeKey,"history",source,filterTrip],
    queryFn:({pageParam})=>{
      const params=new URLSearchParams({source,limit:"25"});
      if(pageParam)params.set("cursor",String(pageParam));
      if(filterTrip!=="ALL")params.set("dispatchId",filterTrip);
      return json<HistoryPage>(base+"/history?"+params.toString());
    },
    initialPageParam:null as string|null,
    getNextPageParam:last=>last.nextCursor??undefined,
    enabled:Boolean(companyId)&&section==="HISTORY",
  });
  const historyRows=useMemo(()=>history.data?.pages.flatMap(page=>page.entries)??[],[history.data]);
  const filteredTrips=useMemo(()=>{
    const q=search.trim().toLowerCase();
    return (value?.trips??[]).filter(t=>!q ||
      [String(t.dispatchNumber),t.status,t.financialStatus,t.notes,t.poNumber,t.supplierCode]
        .some(v=>String(v??"").toLowerCase().includes(q)));
  },[value?.trips,search]);
  const date=(s:string|null|undefined)=>s?formatDisplayDateTime(s):"—";
  const label=(s:string)=>s.replaceAll("_"," ").toLowerCase().replace(/(^|\s)\S/g,v=>v.toUpperCase());
  const sectionItems:Array<{id:Section;title:string;count?:number;icon:typeof Truck}>=[
    {id:"TRIPS",title:"Trucks",count:value?.trips.length,icon:Truck},
    {id:"CHARGES",title:"Charges",count:value?.charges.length,icon:ReceiptText},
    {id:"PO_FILES",title:"ERP PO files",count:value?.summary.generatedPoFiles,icon:FileSpreadsheet},
    {id:"HISTORY",title:"History",icon:History},
  ];
  return (
    <Card className="overflow-hidden border-slate-200 bg-background shadow-sm dark:border-blue-500/20"
      data-testid="factory-dispatch-order-financial-dashboard">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-blue-600/10 p-2.5 text-blue-700 dark:text-blue-300">
              <ClipboardList className="h-5 w-5"/>
            </div>
            <div>
              <h2 className="font-bold text-base sm:text-lg">Order-wide dispatch dashboard</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Financial truck postings, original loading charges and one final invoice
                all stay under Loading #{orderId}.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={()=>void info.refetch()}
              disabled={info.isFetching} data-testid="button-refresh-dispatch-overview">
              <RefreshCw className={"mr-1.5 h-4 w-4 "+(info.isFetching?"animate-spin":"")}/> Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={onPhysicalReport}>
              <FileText className="mr-1.5 h-4 w-4"/> Physical report
            </Button>
            <Button size="sm" variant="outline" onClick={onCompareAll}>
              <CheckCheck className="mr-1.5 h-4 w-4"/> Verify all trips
            </Button>
            <Button size="sm" onClick={()=>{
              // Standard GET download keeps the browser's existing session.
              // It only exports evidence; never posts an ERP import or voucher.
              window.location.assign(base+"/report.xlsx");
            }} data-testid="button-export-dispatch-order-excel">
              <Download className="mr-1.5 h-4 w-4"/> Excel
            </Button>
          </div>
        </div>
        {info.isPending&&<p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin"/> Loading order-level financial evidence…
        </p>}
        {info.isError&&<div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200">
          <AlertTriangle className="mr-1.5 inline h-4 w-4"/>{info.error instanceof Error?info.error.message:"Unable to load order report"}
        </div>}
        {value&&<>
          <div className="flex flex-wrap gap-2 text-xs">
            {value.order.customerName&&<Badge variant="outline">{value.order.customerName}</Badge>}
            <Badge variant="outline">{value.order.containerNumber??"No container number"}</Badge>
            <Badge variant="secondary">{label(value.order.status)}</Badge>
            {value.summary.signed&&<Badge variant="outline">Signed reconciliation</Badge>}
            {value.summary.finalized&&<Badge variant="outline">
              Invoice {value.invoice?.invoiceNumber??value.order.invoiceNumber}
            </Badge>}
          </div>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {([
              ["Trucks closed",fmtCount(value.summary.closedTrips)+" / "+fmtCount(value.summary.tripCount),Truck],
              ["Physically scanned",fmtCount(value.summary.uniqueScannedBales)+" bales",Package],
              ["Posted trip receivable",value.schemaReady?"$ "+fmtAmount(value.summary.tripCustomerTotal):"Not installed",Wallet],
              ["One final invoice",value.summary.finalized?"$ "+fmtAmount(value.summary.invoiceTotal):"Not finalized",FileText],
            ] as const).map(([heading,number,Icon])=>(
              <div key={heading} className="flex min-w-0 gap-2 rounded-xl border border-border bg-muted/30 p-3">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300"/>
                <div className="min-w-0"><p className="text-[11px] text-muted-foreground">{heading}</p>
                  <p className="mt-1 break-words font-mono text-sm font-semibold">{number}</p></div>
              </div>
            ))}
          </div>
          {/* Accounting integrity is checked automatically in the background.
              Healthy/pending checks are not a user task or an operational card. */}
          {(gate.isError ||
            (gate.data && (!gate.data.reconciliation.ready || !gate.data.invoice.ready ||
              gate.data.integrity?.passed===false)))&&(
            <div className="rounded-xl border border-amber-400/50 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200"
              data-testid="factory-dispatch-accounting-attention">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/>
                <div className="space-y-1">
                  <p className="font-semibold">Accounting attention required</p>
                  {gate.isError&&<p>Automatic accounting verification is temporarily unavailable. Posting and invoice guards remain active.</p>}
                  {gate.data && (!gate.data.reconciliation.ready || !gate.data.invoice.ready) &&
                    <p>Required database accounting protections are not installed. Financial approval remains restricted until the administrator applies the missing migration.</p>}
                  {gate.data?.integrity && !gate.data.integrity.passed && (
                    <details>
                      <summary className="cursor-pointer font-medium">
                        {gate.data.integrity.checks.filter(check=>check.state==="BLOCK").length} accounting discrepancy(s) detected automatically
                      </summary>
                      <div className="mt-2 max-h-48 space-y-1 overflow-auto">
                        {gate.data.integrity.checks.filter(check=>check.state==="BLOCK").map(check=>(
                          <p key={check.code}>
                            {check.message}
                            {check.expected!==undefined?" · Expected: "+check.expected:""}
                            {check.observed!==undefined?" · Observed: "+check.observed:""}
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              Loaded now: {value.summary.originalLoadingBales} · scanned events: {value.summary.scannedBales} ·
              unshipped: {value.summary.unshippedBales} · unexpected: {value.summary.unexpectedScannedBales}
            </span>
            <span className="font-medium">{value.summary.generatedPoFiles} ERP PO file(s) generated</span>
          </div>
          {value.notices.map(note=>(
            <p key={note} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-950 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"/>{note}
            </p>
          ))}
          {value.invoice&&(
            <div className="flex flex-wrap justify-between gap-3 rounded-xl border border-border bg-muted/20 p-3 text-xs"
              data-testid="dispatch-combined-invoice-evidence">
              <div className="space-y-1">
                <p className="font-semibold">
                  {value.summary.finalized?"Final consolidated invoice":"Order-wide reconciliation"}
                  {value.invoice.invoiceNumber?" · "+value.invoice.invoiceNumber:""}
                </p>
                <p className="text-muted-foreground">
                  Signed: {date(value.invoice.signedAt)}
                  {value.invoice.signedBy?" · User "+value.invoice.signedBy:""}
                </p>
                <p className="text-muted-foreground">
                  Finalized: {date(value.invoice.finalizedAt)} ·
                  Original truck postings: {value.invoice.includedPostingIds.length}
                  {" "}· Final invoice vouchers: {value.invoice.finalizationVoucherIds.length}
                </p>
              </div>
              <Badge variant="outline" className="h-fit">
                {value.summary.finalized?"One invoice finalized":value.summary.signed?"Signed, awaiting invoice":"Not yet signed"}
              </Badge>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Dispatch order financial reports">
            {sectionItems.map(item=>(
              <button type="button" key={item.id} role="tab" aria-selected={section===item.id}
                onClick={()=>setSection(item.id)} className={"inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors "+headerButton(section===item.id)}
                data-testid={"dispatch-dashboard-tab-"+item.id.toLowerCase()}>
                <item.icon className="h-4 w-4"/>{item.title}
                {item.count!==undefined&&<span className="opacity-75">({item.count})</span>}
              </button>
            ))}
          </div>
          {section==="TRIPS"&&(
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">One row per physical trip, with separate live POST accounting evidence.</p>
                <Input className="h-9 w-full sm:w-60" value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder="Search trip, PO or status…" aria-label="Search financial trip reports"/>
              </div>
              {!filteredTrips.length&&<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No matching trips.</p>}
              <div className="space-y-2">
                {filteredTrips.map(t=>(
                  <div key={t.id} className="rounded-xl border border-border bg-card p-3" data-testid={"dispatch-overview-trip-"+t.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Truck className="h-4 w-4 text-blue-600"/>
                        <span className="font-semibold text-sm">Trip #{String(t.dispatchNumber).padStart(3,"0")}</span>
                        <Badge variant="outline">{label(t.status)}</Badge>
                        <Badge variant="secondary">{label(t.financialStatus)}</Badge>
                      </div>
                      <Button size="sm" variant="outline" onClick={()=>onOpenTrip(Number(t.id))}>
                        Open trip
                      </Button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs md:grid-cols-4">
                      <div><span className="text-muted-foreground">Scanned</span>
                        <p className="font-mono font-medium">{t.scannedBales} bales · {fmtAmount(t.scannedWeightKg)} kg</p></div>
                      <div><span className="text-muted-foreground">Posted goods</span>
                        <p className="font-mono font-medium">$ {fmtAmount(t.goodsSubtotal)}</p></div>
                      <div><span className="text-muted-foreground">Customer charges / discounts</span>
                        <p className="font-mono font-medium">+ {fmtAmount(t.billableCharges)} / − {fmtAmount(t.discounts)}</p></div>
                      <div><span className="text-muted-foreground">Previously posted receivable</span>
                        <p className="font-mono font-semibold">$ {fmtAmount(t.customerTotal)}</p></div>
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                      <span>Closed: {date(t.closedAt)} · POST ID: {t.postingId??"Not posted"}</span>
                      <span>PO Excel: {t.exportedAt?"Generated — import not confirmed":"Not generated"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {section==="CHARGES"&&(
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Billable trip charges and discounts are included in posted trip totals;
                original loading charges are separate. Internal costs do not increase the customer invoice.
              </p>
              {!value.charges.length&&<p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No charges recorded.</p>}
              {value.charges.map(c=>(
                <div key={c.kind+"-"+c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{c.name}</p>
                      <Badge variant="outline">{c.kind==="ORDER"?"Original order":label(c.kind)}</Badge>
                      <Badge variant="secondary">{label(c.status)}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {c.dispatchNumber===null?"Parent loading":"Trip #"+c.dispatchNumber} ·
                      {c.accountCode?" "+c.accountCode+" — "+(c.accountName??""):" Ledger account missing"}
                      {c.offsetAccountCode?" · Offset "+c.offsetAccountCode:""}
                      {c.postedVoucherId?" · Voucher #"+c.postedVoucherId:""}
                    </p>
                  </div>
                  <strong className="font-mono text-sm">
                    {c.kind==="DISCOUNT"?"− ":""}$ {fmtAmount(c.amount)}
                  </strong>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-4">
                <div><p className="text-muted-foreground">Trip billable</p><strong>$ {fmtAmount(value.summary.billableCharges)}</strong></div>
                <div><p className="text-muted-foreground">Trip discounts</p><strong>$ {fmtAmount(value.summary.discounts)}</strong></div>
                <div><p className="text-muted-foreground">Original order charges</p><strong>$ {fmtAmount(value.summary.originalOrderCharges)}</strong></div>
                <div><p className="text-muted-foreground">Posted internal expenses</p><strong>$ {fmtAmount(value.summary.internalExpenses)}</strong></div>
              </div>
            </div>
          )}
          {section==="PO_FILES"&&(
            <div className="space-y-2">
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100">
                <AlertTriangle className="mr-1.5 inline h-4 w-4"/>
                Downloading a Factory PO Excel does not import it. Supplier balances are created
                only when you manually validate and import it in Normal ERP.
              </div>
              {value.trips.map(t=>(
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0 space-y-1 text-xs">
                    <p className="font-semibold">Trip #{t.dispatchNumber} · {t.exportedAt?"File generated":"File not generated"}</p>
                    <p className="text-muted-foreground">ERP PO: {t.poNumber??"—"} · Supplier: {t.supplierCode??"—"}</p>
                    <p className="text-muted-foreground">ERP Container: {t.erpContainerNumber??"—"} · Generated: {date(t.exportedAt)}</p>
                    <p className="text-amber-700 dark:text-amber-300">
                      Import status: {t.exportedAt?"Not confirmed by Factory":"Not exported"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={()=>onOpenTrip(Number(t.id))}>
                    <FileSpreadsheet className="mr-1.5 h-4 w-4"/> Open PO export
                  </Button>
                </div>
              ))}
            </div>
          )}
          {section==="HISTORY"&&(
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <select aria-label="Activity history source" value={source}
                  onChange={e=>{setSource(e.target.value as Source);setExpanded(null);}}
                  className="h-9 rounded-md border border-input bg-background px-2.5 text-xs text-foreground">
                  <option value="ALL">All activity</option>
                  <option value="PHYSICAL">Physical scans & dispatch</option>
                  <option value="FINANCIAL">Financial & invoice</option>
                  <option value="CLOSURE">Signed truck closures</option>
                </select>
                <select aria-label="Activity history dispatch" value={filterTrip}
                  onChange={e=>{setFilterTrip(e.target.value);setExpanded(null);}}
                  className="h-9 rounded-md border border-input bg-background px-2.5 text-xs text-foreground">
                  <option value="ALL">All trucks</option>
                  {value.trips.map(t=><option key={t.id} value={t.id}>Trip #{t.dispatchNumber}</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={()=>void history.refetch()} disabled={history.isFetching}>
                  <RefreshCw className={"mr-1.5 h-4 w-4 "+(history.isFetching?"animate-spin":"")}/> Refresh history
                </Button>
              </div>
              {history.isPending&&<p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin"/> Loading signed audit history…
              </p>}
              {history.isError&&<p className="rounded-lg border border-red-300 p-3 text-xs text-destructive">
                {history.error instanceof Error?history.error.message:"Unable to read activity history"}
              </p>}
              {!history.isPending&&!historyRows.length&&<p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No history events match this filter.</p>}
              <div className="space-y-2">
                {historyRows.map(evt=>{
                  const key=evt.source+":"+evt.id;
                  return <div key={key} className="rounded-lg border border-border p-3 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-blue-600"/>
                        <span className="font-semibold">{label(evt.eventType)}</span>
                        <Badge variant="outline">{label(evt.source)}</Badge>
                      </div>
                      <span className="text-muted-foreground">{date(evt.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {evt.dispatchId?"Trip ID #"+evt.dispatchId+" · ":"Order-wide · "}
                      {evt.actorUsername}
                      {evt.reason?" · Reason: "+evt.reason:""}
                    </div>
                    <button type="button" onClick={()=>setExpanded(expanded===key?null:key)}
                      className="mt-2 inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300"
                      aria-expanded={expanded===key}>
                      <ChevronDown className="h-3.5 w-3.5"/> Original event details
                    </button>
                    {expanded===key&&(
                      <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-relaxed">
                        {JSON.stringify(evt.details,null,2)}
                      </pre>
                    )}
                  </div>;
                })}
              </div>
              {history.hasNextPage&&(
                <Button variant="outline" size="sm" onClick={()=>void history.fetchNextPage()}
                  disabled={history.isFetchingNextPage} className="w-full">
                  {history.isFetchingNextPage&&<Loader2 className="mr-1.5 h-4 w-4 animate-spin"/>}
                  Load older events
                </Button>
              )}
              <p className="text-[11px] text-muted-foreground">
                Activity is paginated, with original audit events preserved. Excel exports include
                up to the latest 1,000 events and disclose if older history exists.
              </p>
            </div>
          )}
          <p className="flex items-start gap-1.5 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0"/>
            Read-only financial reporting. This page does not finalize trucks, add charges, move
            inventory, bill customers or automatically import purchase orders into ERP.
          </p>
        </>}
      </CardContent>
    </Card>
  );
}
