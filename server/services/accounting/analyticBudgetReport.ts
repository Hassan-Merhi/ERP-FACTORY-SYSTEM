/**
 * Phase 12: booked USD analytic budget/actual workpaper.
 * A cost center exists ONLY as a tag on existing source voucher entries.
 * Total source journal activity = allocated to centers + unallocated,
 * with no second GL posting. Child centers roll into parents for display;
 * group totals never sum parent+child twice.
 */
import Decimal from "decimal.js";
import {sql} from "drizzle-orm";
import type {DbTransaction} from "../../db";
import {resultRows} from "../../lib/queryResult";
import {assertTransactionCompanyScope} from "../security/transactionCompanyScope";
import {fxDay} from "./monetaryFxRates";
import {companyBusinessDate} from "./companyBusinessDate";
import {financialStatementCategory} from "./unifiedAccountingFoundation";
import {notFiscalClosingVoucher} from "./balances/periodReportRules";
import {listAnalyticCentersTx,type AnalyticCategory} from "./analyticAccountingService";

interface ActualRow extends Record<string,unknown>{
 account_id:number;code:string;account_type:string;sub_type:string|null;
 month_start:string;cost_center_id:number|null;value_signed:string;
}
interface BudgetReportRow extends Record<string,unknown>{
 id:number;cost_center_id:number;month_start:string;category:AnalyticCategory;
 planned_usd:string;state:"DRAFT"|"APPROVED"|"ARCHIVED";
 notes:string|null;created_at:string;approved_at:string|null;
}
type MonthNumbers={actual:Decimal;approved:Decimal;draft:Decimal};
type TotalsByCategory=Record<AnalyticCategory,MonthNumbers>;
const categories:AnalyticCategory[]=["income","cost_of_sales","expense"];
const Z=()=>new Decimal(0),N=(v:unknown)=>new Decimal(String(v??"0"));
const str=(d:Decimal)=>d.toDecimalPlaces(2,Decimal.ROUND_HALF_UP).toFixed(2);
function empty():TotalsByCategory{
 return{income:{actual:Z(),approved:Z(),draft:Z()},
  cost_of_sales:{actual:Z(),approved:Z(),draft:Z()},
  expense:{actual:Z(),approved:Z(),draft:Z()}};
}
function copy(t:TotalsByCategory):TotalsByCategory{
 const next=empty();
 for(const k of categories)next[k]={actual:t[k].actual,approved:t[k].approved,draft:t[k].draft};
 return next;
}
function add(dst:TotalsByCategory,src:TotalsByCategory){
 for(const k of categories){
  dst[k].actual=dst[k].actual.plus(src[k].actual);
  dst[k].approved=dst[k].approved.plus(src[k].approved);
  dst[k].draft=dst[k].draft.plus(src[k].draft);
 }
}
function final(t:TotalsByCategory){
 return Object.fromEntries(categories.map(k=>{
  const x=t[k];
  return[k,{
   actualUsd:str(x.actual),approvedBudgetUsd:str(x.approved),
   draftBudgetUsd:str(x.draft),
   favorableVarianceUsd:str(k==="income"?x.actual.minus(x.approved):x.approved.minus(x.actual)),
   remainingBudgetUsd:str(k==="income"?x.actual.minus(x.approved):x.approved.minus(x.actual)),
   utilizationPercent:x.approved.gt(0)?x.actual.div(x.approved).times(100)
    .toDecimalPlaces(2).toFixed(2):null
  }];
 })) as Record<AnalyticCategory,{
  actualUsd:string;approvedBudgetUsd:string;draftBudgetUsd:string;
  favorableVarianceUsd:string;remainingBudgetUsd:string;utilizationPercent:string|null
 }>;
}
export async function listAnalyticBudgetsTx(tx:DbTransaction,input:{
 companyId:number;fromDate:string;asOfDate:string;includeArchived?:boolean
}){
 await assertTransactionCompanyScope(tx,input.companyId);
 const from=fxDay(input.fromDate),to=fxDay(input.asOfDate);
 if(from>to)throw new Error("ANALYTIC_PERIOD_INVALID");
 const rows=resultRows<BudgetReportRow>(await tx.execute(sql`
 SELECT id,cost_center_id,month_start::text,category,planned_usd::text,
   state,notes,created_at::text,approved_at::text
 FROM accounting_cost_budgets WHERE company_id=${input.companyId}
   AND month_start>=DATE_TRUNC('month',${from}::date)::date
   AND month_start<=DATE_TRUNC('month',${to}::date)::date
   AND (${input.includeArchived??false} OR state<>'ARCHIVED')
 ORDER BY month_start DESC,cost_center_id,category,id DESC
 LIMIT 2000
 `));
 return{companyId:input.companyId,budgets:rows,truncated:rows.length===2000};
}
export async function analyticBudgetActualTx(tx:DbTransaction,input:{
 companyId:number;fromDate:string;asOfDate:string
}){
 const {companyId}=input;
 await assertTransactionCompanyScope(tx,companyId);
 const from=fxDay(input.fromDate),to=fxDay(input.asOfDate);
 if(from>to)throw new Error("ANALYTIC_PERIOD_INVALID");
 const now=await companyBusinessDate(companyId,tx);
 if(to>now)throw new Error("ANALYTIC_FUTURE_DATE");
 const {centers}=await listAnalyticCentersTx(tx,companyId);
 const ids=new Set(centers.map(c=>Number(c.id)));
 const map=new Map(centers.map(c=>[Number(c.id),c]));
 // Detect stale, cross-company or cyclic parent relationships: do not
 // double count or invent a roll-up when the hierarchy is inconsistent.
 const warnings:string[]=[
  "Analytics uses the historical booked USD amount of posted voucher entries. Tagging is metadata only, not extra revenue/cost in the GL.",
  "Unallocated posted source lines are visible separately. Do not treat zero allocated actual as zero company expense.",
  "Budgets are whole-month plans. A custom partial-month period compares only its posted days with the FULL approved calendar-month plan.",
  "Current center hierarchy, voucher descriptions and budget approval state are not immutable historical snapshots.",
  "Reversed source voucher pairs are excluded from eligible analytic attribution after their reversal effective date; original GL remains untouched."
 ];
 const ancestorPaths=new Map<number,number[]>();
 for(const c of centers){
  const path:number[]=[],seen=new Set<number>();
  let parent=c.parent_id===null?null:Number(c.parent_id);
  while(parent!==null){
   if(seen.has(parent)||parent===Number(c.id)){
    throw new Error("ANALYTIC_HIERARCHY_CYCLE");
   }
   seen.add(parent);
   if(!ids.has(parent))throw new Error("ANALYTIC_PARENT_CROSS_COMPANY");
   path.push(parent);
   const parentRow=map.get(parent);
   parent=parentRow?.parent_id===null||parentRow?.parent_id===undefined?
     null:Number(parentRow.parent_id);
  }
  ancestorPaths.set(Number(c.id),path);
 }
 // A voucher can have multiple profit/loss lines and multiple center tags,
 // but eligibility and unallocated value are calculated per ENTRY first.
 // Undo/cancelled source journals are excluded from budget performance
 // only when the reversal is effective no later than this report's as-of.
 const eligibleCte=sql`
 eligible AS(
 SELECT e.id AS entry_id,e.ledger_account_id AS account_id,
  la.code,la.account_type,la.sub_type,v.company_id,
  DATE_TRUNC('month',COALESCE(v.effective_date,v.voucher_date))::date AS month_start,
  (COALESCE(e.base_debit_amount,e.debit_amount,0)-
   COALESCE(e.base_credit_amount,e.credit_amount,0)) AS signed
 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
 JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
 WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
   AND COALESCE(v.effective_date,v.voucher_date)>=${from}::date
   AND COALESCE(v.effective_date,v.voucher_date)<=${to}::date
   AND v.reversal_of_voucher_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM vouchers rv WHERE rv.company_id=v.company_id
     AND rv.reversal_of_voucher_id=v.id AND rv.deleted_at IS NULL AND rv.optional=false
     AND COALESCE(rv.effective_date,rv.voucher_date)<=${to}::date)
   AND ${notFiscalClosingVoucher("v")}
   AND (
     LOWER(TRIM(la.account_type)) IN
      ('income','revenue','direct income','indirect income','expense',
       'direct expense','indirect expense','government taxes','cogs')
     OR LOWER(TRIM(COALESCE(la.sub_type,''))) IN
      ('income','direct income','indirect income','expense','direct expense',
       'indirect expense','cogs'))
   )
 )
 `;
 const assigned=resultRows<ActualRow>(await tx.execute(sql`
 WITH ${eligibleCte}
 SELECT q.account_id,q.code,q.account_type,q.sub_type,
  q.month_start::text AS month_start,a.cost_center_id,
  COALESCE(SUM(a.amount_usd * CASE WHEN q.signed>=0 THEN 1 ELSE -1 END),0)::text
    AS value_signed
 FROM eligible q JOIN accounting_cost_allocations a
   ON a.voucher_entry_id=q.entry_id AND a.company_id=q.company_id
   AND a.voided_at IS NULL
 JOIN LATERAL (
   SELECT COALESCE(SUM(t.amount_usd),0) AS assigned
   FROM accounting_cost_allocations t
   WHERE t.company_id=q.company_id AND t.voucher_entry_id=q.entry_id
     AND t.voided_at IS NULL
 ) capacity ON capacity.assigned<=ABS(q.signed)
 GROUP BY q.account_id,q.code,q.account_type,q.sub_type,q.month_start,a.cost_center_id
 `));
 const unassigned=resultRows<ActualRow>(await tx.execute(sql`
 WITH ${eligibleCte}, lines AS(
  SELECT q.account_id,q.code,q.account_type,q.sub_type,q.month_start,
   q.signed,COALESCE(a.assigned,0) AS assigned
  FROM eligible q
  LEFT JOIN LATERAL (
   SELECT SUM(x.amount_usd) AS assigned FROM accounting_cost_allocations x
   WHERE x.company_id=q.company_id AND x.voucher_entry_id=q.entry_id
     AND x.voided_at IS NULL
  ) a ON true
 )
 SELECT account_id,code,account_type,sub_type,month_start::text AS month_start,
  NULL::bigint AS cost_center_id,
  COALESCE(SUM(CASE WHEN signed>=0 THEN 1 ELSE -1 END *
    CASE WHEN assigned>ABS(signed) THEN ABS(signed)
      ELSE GREATEST(ABS(signed)-assigned,0) END),0)::text AS value_signed
 FROM lines GROUP BY account_id,code,account_type,sub_type,month_start
 `));
 const drift=resultRows<{overallocated:string;unpriced:string}&Record<string,unknown>>(await tx.execute(sql`
 WITH ${eligibleCte}
 SELECT COUNT(*) FILTER(WHERE a.assigned>ABS(q.signed))::text AS overallocated,
  COUNT(*) FILTER(WHERE ABS(q.signed)=0 AND a.assigned>0)::text AS unpriced
 FROM eligible q JOIN LATERAL(
   SELECT COALESCE(SUM(x.amount_usd),0) AS assigned
   FROM accounting_cost_allocations x
   WHERE x.company_id=q.company_id AND x.voucher_entry_id=q.entry_id
    AND x.voided_at IS NULL
 ) a ON true
 `))[0];
 const stale=resultRows<{count:string}&Record<string,unknown>>(await tx.execute(sql`
 SELECT COUNT(*)::text AS count
 FROM accounting_cost_allocations a
 JOIN voucher_entries e ON e.id=a.voucher_entry_id
 JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=a.company_id
 WHERE a.company_id=${companyId} AND a.voided_at IS NULL AND
   (v.deleted_at IS NOT NULL OR v.optional=true
    OR v.reversal_of_voucher_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM vouchers rv WHERE rv.reversal_of_voucher_id=v.id
      AND rv.company_id=v.company_id AND rv.deleted_at IS NULL AND rv.optional=false))
 `))[0];
 const driftCount=Number(drift?.overallocated??0);
 const staleCount=Number(stale?.count??0);
 if(driftCount)warnings.push(
  `${driftCount} source entry or entries have analytic tags exceeding their current booked USD amount; their entire source amount is reported as unallocated until repaired. No false actual is allocated to a cost center.`);
 if(staleCount)warnings.push(
  `${staleCount} active analytic allocation(s) refer to reversed/retired voucher source. They are excluded from current eligible actuals; review and void the stale tags.`);
 const approvedBudgets=resultRows<BudgetReportRow>(await tx.execute(sql`
 SELECT id,cost_center_id,month_start::text,category,planned_usd::text,state,
   notes,created_at::text,approved_at::text FROM accounting_cost_budgets
 WHERE company_id=${companyId}
  AND month_start>=DATE_TRUNC('month',${from}::date)::date
  AND month_start<=DATE_TRUNC('month',${to}::date)::date AND state<>'ARCHIVED'
 ORDER BY cost_center_id,month_start,category
 `));
 const direct=new Map<number,TotalsByCategory>();
 const monthly=new Map<string,TotalsByCategory>();
 const pending=empty();
 const companyTotals=empty();
 const monthlyKey=(id:number,month:string)=>`${id}:${month}`;
 const directRow=(id:number)=>{let x=direct.get(id);if(!x){x=empty();direct.set(id,x)}return x;};
 const monthlyRow=(id:number,month:string)=>{
  const key=monthlyKey(id,month);
  let x=monthly.get(key);if(!x){x=empty();monthly.set(key,x)}return x;
 };
 const classify=(row:ActualRow)=>{
  const cat=financialStatementCategory({code:row.code,
   accountType:row.account_type,subType:row.sub_type});
  return(cat==="income"||cat==="cost_of_sales"||cat==="expense")?cat:null;
 };
 const source=(row:ActualRow)=>{
  const cat=classify(row);
  if(!cat)return;
  const raw=N(row.value_signed);
  const effective=cat==="income"?raw.negated():raw;
  const centerId=row.cost_center_id===null?null:Number(row.cost_center_id);
  if(centerId!==null&&ids.has(centerId)){
   directRow(centerId)[cat].actual=directRow(centerId)[cat].actual.plus(effective);
   monthlyRow(centerId,row.month_start)[cat].actual=
    monthlyRow(centerId,row.month_start)[cat].actual.plus(effective);
  }else if(centerId===null){
   pending[cat].actual=pending[cat].actual.plus(effective);
  }else{
   warnings.push("An analytic allocation refers to a missing cost center; its booked value is excluded from rolled-up figures.");
  }
  companyTotals[cat].actual=companyTotals[cat].actual.plus(effective);
 };
 assigned.forEach(source);unassigned.forEach(source);
 for(const budget of approvedBudgets){
  const id=Number(budget.cost_center_id);
  if(!ids.has(id))continue;
  const amount=N(budget.planned_usd);
  const field=budget.state==="APPROVED"?"approved":"draft";
  directRow(id)[budget.category][field]=directRow(id)[budget.category][field].plus(amount);
  monthlyRow(id,budget.month_start)[budget.category][field]=
   monthlyRow(id,budget.month_start)[budget.category][field].plus(amount);
  companyTotals[budget.category][field]=companyTotals[budget.category][field].plus(amount);
 }
 const rollup=new Map<number,TotalsByCategory>();
 for(const c of centers)rollup.set(Number(c.id),copy(direct.get(Number(c.id))??empty()));
 for(const c of centers){
  const child=direct.get(Number(c.id));
  if(!child)continue;
  for(const parentId of ancestorPaths.get(Number(c.id))??[]){
   add(rollup.get(parentId)!,child);
  }
 }
 const monthList=Array.from(monthly.entries()).map(([key,value])=>{
  const split=key.lastIndexOf(":");
  return{centerId:Number(key.slice(0,split)),monthStart:key.slice(split+1),
   categories:final(value)};
 }).sort((a,b)=>a.monthStart.localeCompare(b.monthStart)||a.centerId-b.centerId);
 return{
  companyId,fromDate:from,asOfDate:to,currency:"USD" as const,
  centers:centers.map(c=>({
   ...c,direct:final(direct.get(Number(c.id))??empty()),
   rolledUp:final(rollup.get(Number(c.id))??empty()),
   descendantCount:Array.from(ancestorPaths.values()).filter(p=>p.includes(Number(c.id))).length
  })),
  months:monthList,
  unallocated:final(pending),totals:final(companyTotals),
  budgetCount:approvedBudgets.length,
  quality:{overallocatedSourceEntries:driftCount,staleAllocations:staleCount},
  warnings,
  semantics:{
   actual:"Actual = signed historical booked USD from eligible posted income/COGS/expense voucher ENTRY allocations. Income uses credit positive, expenses use debit positive.",
   variance:"Income favorable = actual − approved. Cost/COGS favorable = approved − actual. No budget approval => zero plan, not proof of overspending.",
   budget:"Only approved monthly budgets count as formal plan; draft amounts remain separate. Archived plans excluded. Parent roll-ups aggregate descendants once.",
   unallocated:"Unallocated includes all eligible posted journal-line cost/revenue not explicitly assigned. Company total = direct allocations across unique centers + unallocated.",
   history:"Cost-center ownership, budget approval and allocations are metadata recorded after source vouchers may have posted. This is a retrospective budget report, not a certified system-time accounting snapshot.",
   scope:"One company only. Shared company expenses and intercompany transfers are not automatically allocated among subsidiaries; manual verified allocations never change posted vouchers.",
   reversed:"Reversed voucher pairs are omitted from analytic eligible actual only after their reversal effective date. Missing source/mismatched historic voucher data requires accounting review."
  },
  certified:false as const
 };
}
