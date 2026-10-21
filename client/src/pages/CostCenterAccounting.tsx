/** Phase 12 — analytic accounting and budgets, ERP / Factory / Properties. */
import {useMemo,useState} from "react";
import {useLocation} from "wouter";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import {useToast} from "@/hooks/use-toast";
import {useCompany} from "@/contexts/CompanyContext";
import {apiRequest} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Card,CardHeader,CardTitle,CardContent} from "@/components/ui/card";

type Category="income"|"cost_of_sales"|"expense";
type Module="ERP"|"FACTORY"|"PROPERTIES"|"SHARED";
type Status={actualUsd:string;approvedBudgetUsd:string;draftBudgetUsd:string;
 favorableVarianceUsd:string;remainingBudgetUsd:string;utilizationPercent:string|null};
type Categories=Record<Category,Status>;
type Center={id:number;code:string;name:string;module:Module;
 parent_id:number|null;sort_order:number;active:boolean;note:string|null;
 direct:Categories;rolledUp:Categories;descendantCount:number};
type Report={fromDate:string;asOfDate:string;companyId:number;currency:"USD";
 centers:Center[];months:Array<{centerId:number;monthStart:string;categories:Categories}>;
 unallocated:Categories;totals:Categories;budgetCount:number;
 warnings:string[];semantics:Record<string,string>;certified:false};
type CenterBase=Pick<Center,"id"|"code"|"name"|"module"|"parent_id"|"sort_order"|"active"|"note">;
type CenterList={centers:CenterBase[]};
type Entry={id:number;voucherId:number;voucherNumber:string;bookedOn:string;
 accountCode:string;category:Category;bookedSignedUsd:string;assignedUsd:string;availableUsd:string};
type Entries={entries:Entry[]};
type Allocation={id:number;cost_center_id:number;voucher_entry_id:number;amount_usd:string;
 voucher_number:string;booked_on:string;source_active:boolean;note:string|null};
type Budget={id:number;cost_center_id:number;month_start:string;
 category:Category;planned_usd:string;state:"DRAFT"|"APPROVED"|"ARCHIVED";
 notes:string|null};
const KEYS:Category[]=["income","cost_of_sales","expense"];
const label=(s:string)=>s.replaceAll("_"," ").replace(/\b\w/g,k=>k.toUpperCase());
const money=(v:string)=>Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const defaultDate=()=>new Date().toISOString().slice(0,10);
function escapedCsv(rows:string[][]){
 const quoted=rows.map(row=>row.map(x=>{
  const str=String(x);
  const numeric=/^-?\d+(?:\.\d+)?$/.test(str);
  const safe=/^[=+@]/.test(str)||(str.startsWith("-")&&!numeric)?"'"+str:str;
  return '"'+safe.replaceAll('"','""')+'"';
 }).join(",")).join("\r\n");
 const url=URL.createObjectURL(new Blob(["\ufeff",quoted],{type:"text/csv;charset=utf-8"}));
 const a=document.createElement("a");a.href=url;a.download="cost-centers-budget-actual.csv";
 document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}
async function read<T>(url:string):Promise<T>{
 const r=await fetch(url,{credentials:"include"});
 const body=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(body.message??"Cost-center accounting not available");
 return body as T;
}
const root="/api/accounting/analytics";
export default function CostCenterAccounting(){
 const [path]=useLocation();
 const module:Module=path.startsWith("/factory/")?"FACTORY":
  path.startsWith("/properties/")?"PROPERTIES":"ERP";
 const {selectedCompany}=useCompany();
 const companyId=selectedCompany?.id;
 const {toast}=useToast(),client=useQueryClient();
 const [tab,setTab]=useState<"report"|"centers"|"assign"|"budgets"|"detail">("report");
 const [fromDate,setFromDate]=useState("");
 const [asOfDate,setAsOfDate]=useState("");
 const [selectedCenter,setSelectedCenter]=useState("");
 const [centerCode,setCenterCode]=useState("");
 const [centerName,setCenterName]=useState("");
 const [centerParent,setCenterParent]=useState("");
 const [centerModule,setCenterModule]=useState<Module>(module);
 const [centerOrder,setCenterOrder]=useState("0");
 const [centerNote,setCenterNote]=useState("");
 const [centerActive,setCenterActive]=useState(true);
 const [editingCenter,setEditingCenter]=useState<number|null>(null);
 const [entrySearch,setEntrySearch]=useState("");
 const [entryId,setEntryId]=useState("");
 const [allocationAmount,setAllocationAmount]=useState("");
 const [allocationNote,setAllocationNote]=useState("");
 const [allocationRequest,setAllocationRequest]=useState(()=>crypto.randomUUID());
 const [reason,setReason]=useState("");
 const [budgetMonth,setBudgetMonth]=useState(defaultDate().slice(0,7));
 const [budgetCategory,setBudgetCategory]=useState<Category>("expense");
 const [budgetAmount,setBudgetAmount]=useState("");
 const [budgetNote,setBudgetNote]=useState("");
 const [monthlyCenter,setMonthlyCenter]=useState("");
 const params=new URLSearchParams();
 if(fromDate)params.set("fromDate",fromDate);
 if(asOfDate)params.set("asOfDate",asOfDate);
 const report=useQuery<Report>({
  queryKey:[root+"/report",companyId,fromDate,asOfDate],
  queryFn:()=>read(root+"/report?"+params),
  enabled:!!companyId,retry:false
 });
 const centers=useQuery<CenterList>({
  queryKey:[root+"/centers",companyId],
  queryFn:()=>read(root+"/centers"),enabled:!!companyId,retry:false
 });
 const entries=useQuery<Entries>({
  queryKey:[root+"/entries",companyId,entrySearch],
  queryFn:()=>read(root+"/entries?search="+encodeURIComponent(entrySearch)),
  enabled:!!companyId&&tab==="assign",retry:false
 });
 const allocations=useQuery<{allocations:Allocation[]}>({
  queryKey:[root+"/allocations",companyId,selectedCenter],
  queryFn:()=>read(root+"/allocations"+(selectedCenter?"?centerId="+selectedCenter:"")),
  enabled:!!companyId&&tab==="assign",retry:false
 });
 const budgets=useQuery<{budgets:Budget[];truncated:boolean}>({
  queryKey:[root+"/budgets",companyId,fromDate,budgetMonth],
  queryFn:()=>read(root+"/budgets?"+new URLSearchParams({
   fromDate:fromDate||new Date().getFullYear()+"-01-01",
   asOfDate:budgetMonth+"-01"
  })),
  enabled:!!companyId&&tab==="budgets",retry:false
 });
 const ordered=useMemo(()=>centers.data?.centers??[],[centers.data]);
 const centerNameById=(id:number)=>ordered.find(c=>Number(c.id)===id)?.name??"Unknown center";
 const centerValue=Number(selectedCenter);
 const centerSelected=Number.isSafeInteger(centerValue)&&centerValue>0;
 const invalidRead=report.error as Error|null;
 const notifyError=(e:Error)=>toast({title:"Cost-center action refused",description:e.message,variant:"destructive"});
 const refresh=async()=>{
  await Promise.all([client.invalidateQueries({queryKey:[root+"/report"]}),
   client.invalidateQueries({queryKey:[root+"/centers"]}),
   client.invalidateQueries({queryKey:[root+"/allocations"]}),
   client.invalidateQueries({queryKey:[root+"/entries"]}),
   client.invalidateQueries({queryKey:[root+"/budgets"]})]);
 };
 const saveCenter=useMutation({
  mutationFn:async()=>{
   const body={code:centerCode,name:centerName,module:centerModule,
    parentId:centerParent?Number(centerParent):null,
    sortOrder:Number(centerOrder)||0,active:centerActive,note:centerNote||null};
   const r=await apiRequest(editingCenter?"PUT":"POST",
    root+"/centers"+(editingCenter?"/"+editingCenter:""),body);
   return r.json();
  },onSuccess:async()=>{
   toast({title:"Cost center saved"});
   setEditingCenter(null);setCenterCode("");setCenterName("");setCenterParent("");
   setCenterNote("");setCenterOrder("0");setCenterActive(true);
   await refresh();
  },onError:notifyError
 });
 const allocate=useMutation({
  mutationFn:async()=>{
   const r=await apiRequest("POST",root+"/allocations",{
    entryId:Number(entryId),centerId:centerValue,amountUsd:allocationAmount,
    clientRequestKey:allocationRequest,note:allocationNote||null
   });return r.json();
  },onSuccess:async()=>{
   toast({title:"Analytic allocation saved",description:"No accounting voucher was changed"});
   setEntryId("");setAllocationAmount("");setAllocationNote("");
   setAllocationRequest(crypto.randomUUID());await refresh();
  },onError:notifyError
 });
 const voidAllocation=useMutation({
  mutationFn:async(id:number)=>{
   const r=await apiRequest("POST",root+"/allocations/"+id+"/void",{reason});
   return r.json();
  },onSuccess:async()=>{
   toast({title:"Allocation voided",description:"Source voucher remains untouched"});
   setReason("");await refresh();
  },onError:notifyError
 });
 const saveBudget=useMutation({
  mutationFn:async()=>{
   const r=await apiRequest("POST",root+"/budgets",{
    centerId:centerValue,monthStart:budgetMonth+"-01",category:budgetCategory,
    plannedUsd:budgetAmount,notes:budgetNote||null
   });return r.json();
  },onSuccess:async()=>{
   toast({title:"Draft budget created"});
   setBudgetAmount("");setBudgetNote("");await refresh();
  },onError:notifyError
 });
 const changeBudget=useMutation({
  mutationFn:async({id,action}:{id:number;action:"approve"|"archive"})=>{
   const r=await apiRequest("POST",root+"/budgets/"+id+"/"+action,
    action==="archive"?{reason}:{});return r.json();
  },onSuccess:async()=>{
   toast({title:"Budget state updated"});setReason("");await refresh();
  },onError:notifyError
 });
 const chosenEntry=entries.data?.entries.find(x=>x.id===Number(entryId));
 const exportReport=()=>{
  if(!report.data)return;
  const rows:string[][]=[["PROVISIONAL COST-CENTER ANALYTIC BUDGET REPORT"],
   ["Company",String(report.data.companyId)],["From",report.data.fromDate],
   ["As of",report.data.asOfDate],["Currency","USD"],
   ["Center code","Center name","Level","Category","Actual","Approved budget","Draft budget","Favorable variance"]];
  for(const c of report.data.centers)for(const cat of KEYS)for(const level of ["direct","rolledUp"] as const){
   const x=c[level][cat];
   rows.push([c.code,c.name,level,cat,x.actualUsd,x.approvedBudgetUsd,
    x.draftBudgetUsd,x.favorableVarianceUsd]);
  }
  for(const cat of KEYS){
   const x=report.data.unallocated[cat];
   rows.push(["UNALLOCATED","Posted but not tagged","source",cat,x.actualUsd,"","",""]);
  }
  for(const cat of KEYS){
   const x=report.data.totals[cat];
   rows.push(["TOTAL","Unique source lines","company",cat,x.actualUsd,x.approvedBudgetUsd,
    x.draftBudgetUsd,x.favorableVarianceUsd]);
  }
  escapedCsv(rows);
 };
 const renderNumbers=(x:Status)=>(
  <><td className="p-2 text-right tabular-nums">{money(x.actualUsd)}</td>
   <td className="p-2 text-right tabular-nums">{money(x.approvedBudgetUsd)}</td>
   <td className="p-2 text-right tabular-nums">{money(x.draftBudgetUsd)}</td>
   <td className="p-2 text-right tabular-nums">{money(x.favorableVarianceUsd)}</td>
   <td className="p-2 text-right tabular-nums">{x.utilizationPercent??"—"}</td></>
 );
 return <div className="p-3 sm:p-5 space-y-5" data-testid="cost-center-accounting">
  <div><h1 className="text-2xl font-semibold">Cost Centers, Analytic Accounting & Budgets</h1>
   <p className="text-sm text-muted-foreground">
    {selectedCompany?.name??"Selected company"} · Posted voucher-line allocations only ·
    financial source records are not modified.</p></div>
  <Card><CardContent className="pt-5 space-y-3">
   <div className="grid gap-3 sm:grid-cols-3">
    <div><Label>From</Label><Input type="date" value={fromDate}
     onChange={e=>setFromDate(e.target.value)}/></div>
    <div><Label>As-of</Label><Input type="date" value={asOfDate}
     onChange={e=>setAsOfDate(e.target.value)}/></div>
    <div className="flex items-end gap-2">
     <Button variant="outline" onClick={()=>void refresh()}>Refresh</Button>
     <Button variant="outline" disabled={!report.data} onClick={exportReport}>Export CSV</Button>
    </div>
   </div>
   <p className="text-xs text-muted-foreground">Default: January 1 through company business date.
    Partial months compare booked activity with the whole-month approved budget.</p>
  </CardContent></Card>
  <div className="flex flex-wrap gap-2">
   {(["report","centers","assign","budgets","detail"] as const).map(k=>
    <Button key={k} size="sm" variant={tab===k?"default":"outline"} onClick={()=>setTab(k)}>
     {({report:"Budget vs actual",centers:"Cost centers",assign:"Attribute voucher lines",
       budgets:"Budgets",detail:"Monthly drill-down"} as const)[k]}
    </Button>)}
  </div>
  {invalidRead&&<p role="alert" className="text-destructive text-sm">{invalidRead.message}</p>}
  {report.isLoading&&<p className="text-sm text-muted-foreground">Loading analytic ledger values…</p>}
  {tab==="report"&&report.data&&<Card>
   <CardHeader><CardTitle>Posted actuals compared with approved budgets (USD)</CardTitle></CardHeader>
   <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">
     Parent roll-up rows include their descendants. Do not add parent and child
     rows together. Company totals count each direct allocation only once,
     plus source amounts not yet allocated.</p>
    <div className="max-h-[680px] overflow-auto">
     <table className="w-full text-sm">
      <thead><tr className="border-b text-left">
       <th className="p-2">Cost center</th><th className="p-2">Category</th>
       <th className="p-2 text-right">Actual</th><th className="p-2 text-right">Approved</th>
       <th className="p-2 text-right">Draft</th>
       <th className="p-2 text-right">Favorable variance</th>
       <th className="p-2 text-right">Used %</th></tr></thead>
      <tbody>{report.data.centers.map(c=>KEYS.map(cat=>
       <tr key={c.id+cat} className="border-b">
        <td className="p-2">{c.code} · {c.name}
         <div className="text-xs text-muted-foreground">{c.module} ·
          {c.descendantCount} descendants{!c.active?" · Inactive":""}</div></td>
        <td className="p-2">{label(cat)}<div className="text-xs text-muted-foreground">
         Rolled up</div></td>
        {renderNumbers(c.rolledUp[cat])}
       </tr>))}
       {KEYS.map(cat=><tr className="border-b bg-muted/20" key={"unallocated"+cat}>
        <td className="p-2 font-medium">Not allocated</td><td className="p-2">{label(cat)}</td>
        {renderNumbers(report.data!.unallocated[cat])}</tr>)}
       {KEYS.map(cat=><tr className="border-t font-semibold" key={"total"+cat}>
        <td className="p-2">Company total (no double-count)</td><td className="p-2">{label(cat)}</td>
        {renderNumbers(report.data!.totals[cat])}</tr>)}
      </tbody></table>
    </div>
    {report.data.warnings.map((msg,i)=><p className="text-sm text-muted-foreground" key={i}>{msg}</p>)}
    <p className="text-sm font-semibold">Report is a provisional analytic attribution,
     not a second general ledger or a certified financial statement.</p>
   </CardContent>
  </Card>}
  {tab==="centers"&&<Card><CardHeader><CardTitle>Manage company cost centers</CardTitle></CardHeader>
   <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">
     Use a stable code for a department, factory line, warehouse, rental property,
     location or project. A parent rolls up child centers without modifying existing vouchers.</p>
    <div className="grid gap-3 sm:grid-cols-3">
     <div><Label>Code</Label><Input value={centerCode} onChange={e=>setCenterCode(e.target.value)}/></div>
     <div><Label>Name</Label><Input value={centerName} onChange={e=>setCenterName(e.target.value)}/></div>
     <div><Label>Module</Label><select className="h-10 w-full border rounded-md bg-background px-2"
      value={centerModule} onChange={e=>setCenterModule(e.target.value as Module)}>
      {(["ERP","FACTORY","PROPERTIES","SHARED"] as Module[]).map(k=>
       <option value={k} key={k}>{k}</option>)}</select></div>
     <div><Label>Parent center</Label><select className="h-10 w-full border rounded-md bg-background px-2"
      value={centerParent} onChange={e=>setCenterParent(e.target.value)}>
      <option value="">Root center</option>{ordered.filter(c=>c.id!==editingCenter).map(c=>
       <option value={c.id} key={c.id}>{c.code} · {c.name}</option>)}</select></div>
     <div><Label>Sort order</Label><Input type="number" value={centerOrder}
       onChange={e=>setCenterOrder(e.target.value)}/></div>
     <div><Label>Notes</Label><Input value={centerNote}
       onChange={e=>setCenterNote(e.target.value)}/></div>
     <label className="flex gap-2 items-center text-sm"><input type="checkbox"
      checked={centerActive} onChange={e=>setCenterActive(e.target.checked)}/>
      Active</label>
    </div>
    <div className="flex flex-wrap gap-2">
     <Button disabled={!centerCode||!centerName||saveCenter.isPending}
      onClick={()=>saveCenter.mutate()}>{editingCenter?"Save changes":"Create center"}</Button>
     {editingCenter&&<Button variant="outline" onClick={()=>{
      setEditingCenter(null);setCenterCode("");setCenterName("");
      setCenterParent("");setCenterOrder("0");setCenterNote("");setCenterActive(true);
     }}>Cancel edit</Button>}
    </div>
    <div className="max-h-[500px] overflow-auto">
     <table className="w-full text-sm"><thead><tr className="border-b text-left">
      <th className="p-2">Code</th><th className="p-2">Center</th>
      <th className="p-2">Module</th><th className="p-2">Parent</th>
      <th className="p-2">Status</th><th className="p-2">Edit</th></tr></thead>
      <tbody>{ordered.map(c=><tr className="border-b" key={c.id}>
       <td className="p-2">{c.code}</td><td className="p-2">{c.name}</td>
       <td className="p-2">{c.module}</td>
       <td className="p-2">{c.parent_id?centerNameById(Number(c.parent_id)):"—"}</td>
       <td className="p-2">{c.active?"Active":"Inactive"}</td>
       <td className="p-2"><Button size="sm" variant="outline" onClick={()=>{
        setEditingCenter(c.id);setCenterCode(c.code);setCenterName(c.name);
        setCenterModule(c.module);setCenterParent(c.parent_id?String(c.parent_id):"");
        setCenterOrder(String(c.sort_order));setCenterNote(c.note??"");
        setCenterActive(c.active);
       }}>Edit</Button></td>
      </tr>)}</tbody></table>
    </div>
   </CardContent></Card>}
  {tab==="assign"&&<Card><CardHeader><CardTitle>Attribute existing booked voucher lines</CardTitle></CardHeader>
   <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">Select a posted income, cost-of-sales
     or expense entry. Split its original USD magnitude across several centers if
     needed. The sum cannot exceed the entry amount, and no new voucher is posted.</p>
    <div className="grid gap-3 sm:grid-cols-3">
     <div><Label>Cost center</Label><select className="w-full h-10 rounded-md border bg-background px-2"
      value={selectedCenter} onChange={e=>setSelectedCenter(e.target.value)}>
      <option value="">Select cost center</option>{ordered.filter(c=>c.active).map(c=>
       <option value={c.id} key={c.id}>{c.code} · {c.name}</option>)}</select></div>
     <div><Label>Search voucher / ledger</Label><Input value={entrySearch}
      onChange={e=>setEntrySearch(e.target.value)} placeholder="Voucher number or account"/></div>
     <div><Label>Posted voucher line</Label><select className="w-full h-10 rounded-md border bg-background px-2"
      value={entryId} onChange={e=>{
       setEntryId(e.target.value);setAllocationRequest(crypto.randomUUID());
      }}>
      <option value="">Select eligible line</option>{entries.data?.entries.map(e=>
       <option key={e.id} value={e.id}>
        {e.voucherNumber} · {e.accountCode} · {label(e.category)} · available {e.availableUsd} USD
       </option>)}</select></div>
     <div><Label>Amount in USD</Label><Input value={allocationAmount}
      onChange={e=>{setAllocationAmount(e.target.value);setAllocationRequest(crypto.randomUUID());}}
      placeholder="125.00"/></div>
     <div className="sm:col-span-2"><Label>Reason / notes</Label><Input value={allocationNote}
      onChange={e=>{setAllocationNote(e.target.value);setAllocationRequest(crypto.randomUUID());}}
      placeholder="Optional attribution note"/></div>
    </div>
    {chosenEntry&&<p className="text-sm">Source: {chosenEntry.voucherNumber} ·
     Date {chosenEntry.bookedOn} · Account {chosenEntry.accountCode} ·
     Available USD {money(chosenEntry.availableUsd)}.</p>}
    <Button disabled={!centerSelected||!entryId||!allocationAmount||allocate.isPending}
     onClick={()=>allocate.mutate()}>Allocate without posting</Button>
    <div className="space-y-2">
     <h3 className="font-semibold">Active cost-center assignments</h3>
     <div><Label>Required cancellation reason</Label><Input value={reason}
      onChange={e=>setReason(e.target.value)} placeholder="Explain why an assignment is cancelled"/></div>
     {allocations.data?.allocations.map(a=><div key={a.id}
      className="flex flex-wrap gap-3 border-b items-center py-2 text-sm">
      <span>{a.voucher_number} · {a.booked_on}</span>
      <span>{centerNameById(a.cost_center_id)}</span>
      <span className="tabular-nums">{money(a.amount_usd)} USD</span>
      {!a.source_active&&<span className="text-destructive">Source reversed/retired</span>}
      <Button variant="outline" size="sm" disabled={!reason.trim()||voidAllocation.isPending}
       onClick={()=>voidAllocation.mutate(a.id)}>Void assignment</Button>
     </div>)}
    </div>
   </CardContent></Card>}
  {tab==="budgets"&&<Card><CardHeader><CardTitle>Monthly cost-center budgets</CardTitle></CardHeader>
   <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">Draft budgets are planning only.
     Approval freezes that version; archive with a reason to replace it.
     Budgets never create accounting journal entries.</p>
    <div className="grid gap-3 sm:grid-cols-3">
     <div><Label>Cost center</Label><select className="w-full h-10 rounded-md border bg-background px-2"
      value={selectedCenter} onChange={e=>setSelectedCenter(e.target.value)}>
      <option value="">Select center</option>{ordered.filter(c=>c.active).map(c=>
       <option value={c.id} key={c.id}>{c.code} · {c.name}</option>)}</select></div>
     <div><Label>Budget month</Label><Input type="month" value={budgetMonth}
      onChange={e=>setBudgetMonth(e.target.value)}/></div>
     <div><Label>Financial category</Label>
      <select className="w-full h-10 rounded-md border bg-background px-2"
       value={budgetCategory} onChange={e=>setBudgetCategory(e.target.value as Category)}>
       {KEYS.map(k=><option value={k} key={k}>{label(k)}</option>)}
      </select></div>
     <div><Label>Budgeted USD</Label><Input value={budgetAmount}
      onChange={e=>setBudgetAmount(e.target.value)} placeholder="10000.00"/></div>
     <div className="sm:col-span-2"><Label>Budget assumptions</Label>
      <Input value={budgetNote} onChange={e=>setBudgetNote(e.target.value)}
       placeholder="Optional budget assumptions"/></div>
    </div>
    <Button disabled={!centerSelected||!budgetMonth||!budgetAmount||saveBudget.isPending}
     onClick={()=>saveBudget.mutate()}>Create draft monthly budget</Button>
    <div><Label>Reason required before archiving a budget</Label>
     <Input value={reason} onChange={e=>setReason(e.target.value)}
      placeholder="Document the reason for replacing this version"/></div>
    {budgets.isError&&<p className="text-destructive text-sm">{(budgets.error as Error).message}</p>}
    <div className="max-h-[520px] overflow-auto">
     <table className="w-full text-sm"><thead><tr className="border-b text-left">
      <th className="p-2">Month</th><th className="p-2">Center</th>
      <th className="p-2">Category</th><th className="p-2 text-right">Plan USD</th>
      <th className="p-2">State</th><th className="p-2">Approval / archive</th>
     </tr></thead><tbody>{budgets.data?.budgets.map(b=><tr className="border-b" key={b.id}>
      <td className="p-2">{b.month_start}</td>
      <td className="p-2">{centerNameById(Number(b.cost_center_id))}</td>
      <td className="p-2">{label(b.category)}</td>
      <td className="p-2 text-right tabular-nums">{money(b.planned_usd)}</td>
      <td className="p-2">{b.state}</td>
      <td className="p-2 space-x-2">
       {b.state==="DRAFT"&&<Button size="sm" variant="outline"
        disabled={changeBudget.isPending} onClick={()=>changeBudget.mutate({id:b.id,action:"approve"})}>Approve</Button>}
       {b.state!=="ARCHIVED"&&<Button size="sm" variant="outline"
        disabled={!reason.trim()||changeBudget.isPending}
        onClick={()=>changeBudget.mutate({id:b.id,action:"archive"})}>Archive</Button>}
      </td>
     </tr>)}</tbody></table>
    </div>
    {budgets.data?.truncated&&<p className="text-sm text-destructive">
     Budget list truncated at 2,000 entries.</p>}
   </CardContent></Card>}
  {tab==="detail"&&report.data&&<Card>
   <CardHeader><CardTitle>Monthly accounting drill-down</CardTitle></CardHeader>
   <CardContent className="space-y-3">
    <div><Label>Select center</Label><select
     className="h-10 w-full max-w-sm rounded-md border bg-background px-2"
     value={monthlyCenter} onChange={e=>setMonthlyCenter(e.target.value)}>
     <option value="">All direct centers</option>{ordered.map(c=>
      <option value={c.id} key={c.id}>{c.code} · {c.name}</option>)}</select></div>
    <p className="text-sm text-muted-foreground">Monthly drill-down shows
     directly tagged voucher amounts; parents are not automatically counted twice.
     The report above provides the hierarchy rollup.</p>
    <div className="max-h-[560px] overflow-auto"><table className="w-full text-sm">
     <thead><tr className="border-b text-left"><th className="p-2">Month</th>
      <th className="p-2">Cost center</th><th className="p-2">Category</th>
      <th className="p-2 text-right">Actual USD</th>
      <th className="p-2 text-right">Approved USD</th>
      <th className="p-2 text-right">Variance USD</th></tr></thead>
     <tbody>{report.data.months.filter(m=>!monthlyCenter||m.centerId===Number(monthlyCenter))
      .flatMap(m=>KEYS.map(cat=><tr key={m.centerId+m.monthStart+cat} className="border-b">
       <td className="p-2">{m.monthStart}</td>
       <td className="p-2">{centerNameById(m.centerId)}</td>
       <td className="p-2">{label(cat)}</td>
       <td className="p-2 text-right tabular-nums">{money(m.categories[cat].actualUsd)}</td>
       <td className="p-2 text-right tabular-nums">{money(m.categories[cat].approvedBudgetUsd)}</td>
       <td className="p-2 text-right tabular-nums">{money(m.categories[cat].favorableVarianceUsd)}</td>
      </tr>))}</tbody></table></div>
   </CardContent></Card>}
 </div>;
}
