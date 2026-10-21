/**
 * Phase 12 — cost center / analytical financial allocation.
 * Metadata overlays POSTED source expense, COGS and income lines. Never GL
 * posting, revaluation, payroll/production/inventory or bank modification.
 */
import Decimal from "decimal.js";
import {sql} from "drizzle-orm";
import type {DbTransaction} from "../../db";
import {resultRows} from "../../lib/queryResult";
import {writeAuditEvent} from "../audit";
import {assertTransactionCompanyScope} from "../security/transactionCompanyScope";
import {companyBusinessDate} from "./companyBusinessDate";
import {fxDay} from "./monetaryFxRates";
import {financialStatementCategory} from "./unifiedAccountingFoundation";

export type AnalyticCategory="income"|"cost_of_sales"|"expense";
export type AnalyticModule="ERP"|"FACTORY"|"PROPERTIES"|"SHARED";
export interface AnalyticActor {userId:string;username:string}
export class AnalyticError extends Error{
 constructor(public readonly code:string,message:string,public readonly status=409){
  super(message);this.name="AnalyticError";
 }
}
interface CenterRow extends Record<string,unknown>{
 id:number;company_id:number;code:string;name:string;module:AnalyticModule;
 parent_id:number|null;active:boolean;sort_order:number;note:string|null;
}
interface EntryRow extends Record<string,unknown>{
 id:number;voucher_id:number;voucher_number:string;booked_on:string;
 base_signed:string;code:string;account_type:string;sub_type:string|null;
 ledger_account_id:number;deleted_at:string|null;optional:boolean;
 reversed:boolean;allocated:string;
}
interface AllocationRow extends Record<string,unknown>{
 id:number;company_id:number;cost_center_id:number;voucher_entry_id:number;
 amount_usd:string;note:string|null;client_request_key:string;
 voided_at:string|null;
}
interface BudgetRow extends Record<string,unknown>{
 id:number;cost_center_id:number;month_start:string;category:AnalyticCategory;
 planned_usd:string;state:"DRAFT"|"APPROVED"|"ARCHIVED";notes:string|null;
}
const D=(v:unknown)=>new Decimal(String(v??"0"));
const six=(v:Decimal)=>v.toFixed(6);
const zero=new Decimal(0);
const validId=(v:number)=>Number.isSafeInteger(v)&&v>0;
function amount(value:string,allowZero=false){
 if(!/^\d+(?:\.\d{1,6})?$/.test(value))
  throw new AnalyticError("ANALYTIC_AMOUNT_INVALID","Use a USD amount with up to 6 decimal places",400);
 const d=D(value);
 if(!d.isFinite()||d.lt(0)||(!allowZero&&d.isZero())||d.gte("100000000000000"))
  throw new AnalyticError("ANALYTIC_AMOUNT_INVALID","Invalid positive USD amount",400);
 return d;
}
function category(row:Pick<EntryRow,"code"|"account_type"|"sub_type">):AnalyticCategory|null{
 const k=financialStatementCategory({
   code:row.code,accountType:row.account_type,subType:row.sub_type
 });
 return k==="income"||k==="expense"||k==="cost_of_sales"?k:null;
}
function idOrError(v:number,label:string){
 if(!validId(v))throw new AnalyticError("ANALYTIC_ID_INVALID","Invalid "+label,400);
 return v;
}
async function centersTx(tx:DbTransaction,companyId:number){
 await assertTransactionCompanyScope(tx,companyId);
 return resultRows<CenterRow>(await tx.execute(sql`
  SELECT id,company_id,code,name,module,parent_id,active,sort_order,note
  FROM accounting_cost_centers WHERE company_id=${companyId}
  ORDER BY sort_order,code,id LIMIT 2000
 `));
}
async function centerTx(tx:DbTransaction,companyId:number,id:number){
 idOrError(id,"cost center");
 const center=resultRows<CenterRow>(await tx.execute(sql`
  SELECT id,company_id,code,name,module,parent_id,active,sort_order,note
  FROM accounting_cost_centers WHERE company_id=${companyId} AND id=${id} FOR UPDATE
 `))[0];
 if(!center)throw new AnalyticError("ANALYTIC_CENTER_NOT_FOUND","Cost center not found in this company",404);
 return center;
}
async function log(tx:DbTransaction,companyId:number,actor:AnalyticActor,
 tableName:string,recordId:number,action:"create"|"update"|"void",changes:Record<string,{old?:unknown;new?:unknown}>){
 await writeAuditEvent({
  companyId,userId:actor.userId,username:actor.username,
  action,tableName,recordId,recordIdentifier:`${tableName}:${recordId}`,
  changes
 },tx);
}
async function openDayTx(tx:DbTransaction,companyId:number,day:string){
 await tx.execute(sql`SELECT erp_assert_accounting_date_open(${companyId},${day}::date)`);
}
export async function listAnalyticCentersTx(tx:DbTransaction,companyId:number){
 return {companyId,centers:await centersTx(tx,companyId),limit:2000};
}
export async function upsertAnalyticCenterTx(tx:DbTransaction,input:{
 companyId:number;id?:number;code:string;name:string;module:AnalyticModule;
 parentId?:number|null;sortOrder?:number;active?:boolean;note?:string|null;actor:AnalyticActor
}){
 const {companyId,actor}=input;
 await assertTransactionCompanyScope(tx,companyId);
 const code=input.code.trim().toUpperCase(),name=input.name.trim();
 if(!/^[A-Z0-9_.-]{1,40}$/.test(code)||!name||name.length>180||
  (input.note??"").length>1000||!Number.isSafeInteger(input.sortOrder??0))
  throw new AnalyticError("ANALYTIC_CENTER_INVALID","Invalid cost center name, code, order or note",400);
 if(!["ERP","FACTORY","PROPERTIES","SHARED"].includes(input.module))
  throw new AnalyticError("ANALYTIC_MODULE_INVALID","Invalid module",400);
 const today=await companyBusinessDate(companyId,tx);
 await openDayTx(tx,companyId,today);
 // Serialize hierarchy writes to make parent-chain checks stable under
 // simultaneous creation/reparenting.
 await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cost-center-tree:${companyId}`}))`);
 if(input.parentId){
  const parent=await centerTx(tx,companyId,input.parentId);
  if(!parent.active)throw new AnalyticError("ANALYTIC_PARENT_INACTIVE","Parent cost center is inactive");
 }
 if(input.id){
  const current=await centerTx(tx,companyId,input.id);
  if(input.parentId===input.id)throw new AnalyticError("ANALYTIC_CYCLE","Cost center cannot parent itself");
  if(input.parentId){
   const chain=resultRows<{id:number}&Record<string,unknown>>(await tx.execute(sql`
    WITH RECURSIVE ancestors AS(
      SELECT id,parent_id FROM accounting_cost_centers WHERE id=${input.parentId}
        AND company_id=${companyId}
      UNION ALL
      SELECT p.id,p.parent_id FROM accounting_cost_centers p
       JOIN ancestors a ON a.parent_id=p.id AND p.company_id=${companyId}
    ) SELECT id FROM ancestors WHERE id=${input.id} LIMIT 1
   `));
   if(chain.length)throw new AnalyticError("ANALYTIC_CYCLE","Parent would create a cost-center hierarchy cycle");
  }
  // Metadata edits are current business-time only; allocations stay on the
  // same center identity and will not be reposted.
  const row=resultRows<CenterRow>(await tx.execute(sql`
   UPDATE accounting_cost_centers SET code=${code},name=${name},module=${input.module},
     parent_id=${input.parentId??null},sort_order=${input.sortOrder??current.sort_order},
     active=${input.active??current.active},note=${input.note??null},
     updated_at=NOW(),updated_by=${actor.userId}
   WHERE id=${input.id} AND company_id=${companyId}
   RETURNING id,company_id,code,name,module,parent_id,active,sort_order,note
  `))[0];
  await log(tx,companyId,actor,"accounting_cost_centers",Number(row.id),"update",
   {before:{old:current},after:{new:row}});
  return row;
 }
 const result=resultRows<CenterRow>(await tx.execute(sql`
  INSERT INTO accounting_cost_centers
   (company_id,code,name,module,parent_id,sort_order,active,note,created_by)
  VALUES(${companyId},${code},${name},${input.module},
   ${input.parentId??null},${input.sortOrder??0},${input.active??true},
   ${input.note??null},${actor.userId})
  RETURNING id,company_id,code,name,module,parent_id,active,sort_order,note
 `))[0];
 await log(tx,companyId,actor,"accounting_cost_centers",Number(result.id),"create",
  {code:{new:code},name:{new:name},module:{new:input.module}});
 return result;
}
async function entryTx(tx:DbTransaction,companyId:number,entryId:number,lock=false){
 idOrError(entryId,"voucher entry");
 // Serialization is anchored on source voucher row after reading entry's ID.
 const info=resultRows<EntryRow>(await tx.execute(sql`
  SELECT e.id,e.voucher_id,v.voucher_number,
    COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
    (COALESCE(e.base_debit_amount,e.debit_amount,0)-
      COALESCE(e.base_credit_amount,e.credit_amount,0))::text AS base_signed,
    la.code,la.account_type,la.sub_type,e.ledger_account_id,
    v.deleted_at::text,v.optional,
    (v.reversal_of_voucher_id IS NOT NULL OR EXISTS(SELECT 1 FROM vouchers reversal
      WHERE reversal.reversal_of_voucher_id=v.id AND reversal.company_id=v.company_id
       AND reversal.deleted_at IS NULL AND reversal.optional=false)) AS reversed,
    (SELECT COALESCE(SUM(a.amount_usd),0)::text FROM accounting_cost_allocations a
     WHERE a.company_id=${companyId} AND a.voucher_entry_id=e.id
       AND a.voided_at IS NULL) AS allocated
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
  JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
  WHERE v.company_id=${companyId} AND e.id=${entryId}
  LIMIT 1
 `))[0];
 if(!info||info.deleted_at||info.optional||info.reversed||
    !category(info)||D(info.base_signed).isZero())
  throw new AnalyticError("ANALYTIC_ENTRY_NOT_ELIGIBLE",
    "Choose a live unreversed, nonzero, income/COGS/expense ledger line in this company",400);
 if(lock){
  await tx.execute(sql`SELECT id FROM vouchers WHERE id=${info.voucher_id}
   AND company_id=${companyId} FOR UPDATE`);
  // Re-read allocation capacity after acquiring the write lock: two
  // concurrent allocations may otherwise both see the previous sum.
  const refreshed=resultRows<{allocated:string;reversed:boolean;deleted_at:string|null;
   optional:boolean}&Record<string,unknown>>(await tx.execute(sql`
   SELECT (SELECT COALESCE(SUM(a.amount_usd),0)::text FROM accounting_cost_allocations a
      WHERE a.company_id=${companyId} AND a.voucher_entry_id=${entryId}
       AND a.voided_at IS NULL) AS allocated,
     v.deleted_at::text,v.optional,
     (v.reversal_of_voucher_id IS NOT NULL OR EXISTS(SELECT 1 FROM vouchers rv WHERE rv.reversal_of_voucher_id=v.id
      AND rv.company_id=v.company_id AND rv.deleted_at IS NULL AND rv.optional=false)) AS reversed
   FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.id=${entryId} AND v.company_id=${companyId}
   `))[0];
  if(!refreshed||refreshed.deleted_at||refreshed.optional||refreshed.reversed)
   throw new AnalyticError("ANALYTIC_ENTRY_RETIRED","Voucher is no longer eligible");
  info.allocated=refreshed.allocated;
 }
 return info;
}
export async function recentAnalyticEntriesTx(tx:DbTransaction,input:{
 companyId:number;search?:string;limit?:number
}){
 await assertTransactionCompanyScope(tx,input.companyId);
 const search=input.search?.trim()??"";
 if(search.length>100)throw new AnalyticError("ANALYTIC_SEARCH_INVALID","Search too long",400);
 const limit=Math.min(Math.max(input.limit??40,1),100);
 const rows=resultRows<EntryRow>(await tx.execute(sql`
 SELECT e.id,e.voucher_id,v.voucher_number,
   COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
   (COALESCE(e.base_debit_amount,e.debit_amount,0)-
    COALESCE(e.base_credit_amount,e.credit_amount,0))::text AS base_signed,
   la.code,la.account_type,la.sub_type,e.ledger_account_id,
   v.deleted_at::text,v.optional,
   FALSE AS reversed,
   COALESCE(a.allocated,0)::text AS allocated
 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
 JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
 LEFT JOIN LATERAL(
  SELECT SUM(x.amount_usd) AS allocated FROM accounting_cost_allocations x
   WHERE x.company_id=v.company_id AND x.voucher_entry_id=e.id AND x.voided_at IS NULL
 ) a ON true
 WHERE v.company_id=${input.companyId} AND v.deleted_at IS NULL AND v.optional=false
   AND v.reversal_of_voucher_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM vouchers r WHERE r.reversal_of_voucher_id=v.id
     AND r.company_id=v.company_id AND r.deleted_at IS NULL AND r.optional=false)
   AND (
    LOWER(TRIM(la.account_type)) IN
     ('income','revenue','indirect income','direct income','expense',
      'direct expense','indirect expense','government taxes','cogs')
    OR LOWER(TRIM(la.sub_type)) IN
     ('income','indirect income','direct income','expense','direct expense',
      'indirect expense','cogs'))
   AND ABS(COALESCE(e.base_debit_amount,e.debit_amount,0)-
      COALESCE(e.base_credit_amount,e.credit_amount,0))>COALESCE(a.allocated,0)
   AND (${search}='' OR v.voucher_number ILIKE '%'||${search}||'%'
       OR la.code ILIKE '%'||${search}||'%' OR la.name ILIKE '%'||${search}||'%')
 ORDER BY COALESCE(v.effective_date,v.voucher_date) DESC,e.id DESC
 LIMIT ${limit}
 `));
 return{companyId:input.companyId,entries:rows.filter(x=>category(x)).map(x=>({
  id:Number(x.id),voucherId:Number(x.voucher_id),voucherNumber:x.voucher_number,
  bookedOn:x.booked_on,accountCode:x.code,category:category(x),
  bookedSignedUsd:x.base_signed,assignedUsd:x.allocated,
  availableUsd:six(D(x.base_signed).abs().minus(x.allocated))
 }))};
}
export async function addAnalyticAllocationTx(tx:DbTransaction,input:{
 companyId:number;entryId:number;centerId:number;amountUsd:string;
 note?:string|null;clientRequestKey:string;actor:AnalyticActor
}){
 const {companyId,actor}=input;
 await assertTransactionCompanyScope(tx,companyId);
 if(!/^[A-Za-z0-9._:-]{8,128}$/.test(input.clientRequestKey))
  throw new AnalyticError("ANALYTIC_REQUEST_INVALID","A stable 8–128 character request key is required",400);
 if((input.note??"").length>1000)throw new AnalyticError("ANALYTIC_NOTE_INVALID","Note too long",400);
 const value=amount(input.amountUsd);
 const center=await centerTx(tx,companyId,input.centerId);
 if(!center.active)throw new AnalyticError("ANALYTIC_CENTER_INACTIVE","Cannot attribute to inactive cost center");
 // Lock one voucher across ALL cost centers so parallel writers cannot
 // overassign a source line. A durable request key prevents network retries
 // creating a second allocation.
 const entry=await entryTx(tx,companyId,input.entryId,true);
 const repeated=resultRows<AllocationRow>(await tx.execute(sql`
  SELECT id,company_id,cost_center_id,voucher_entry_id,amount_usd::text,note,
    client_request_key,voided_at::text FROM accounting_cost_allocations
  WHERE company_id=${companyId} AND client_request_key=${input.clientRequestKey}
 `))[0];
 if(repeated){
  if(repeated.voided_at||Number(repeated.voucher_entry_id)!==input.entryId||
    Number(repeated.cost_center_id)!==input.centerId||
    !D(repeated.amount_usd).eq(value)||(repeated.note??null)!==(input.note??null))
    throw new AnalyticError("ANALYTIC_REPLAY_CONFLICT","Request key belongs to a different/cancelled allocation");
  return{id:Number(repeated.id),replayed:true,amountUsd:six(value)};
 }
 const now=await companyBusinessDate(companyId,tx);
 if(entry.booked_on>now)throw new AnalyticError("ANALYTIC_FUTURE_ENTRY","Future-dated entry cannot be tagged",400);
 await openDayTx(tx,companyId,entry.booked_on);
 if(D(entry.allocated).plus(value).gt(D(entry.base_signed).abs()))
  throw new AnalyticError("ANALYTIC_OVERALLOCATED",
   "Allocation exceeds the unassigned original posted USD magnitude");
 const added=resultRows<{id:number}&Record<string,unknown>>(await tx.execute(sql`
  INSERT INTO accounting_cost_allocations
   (company_id,voucher_entry_id,cost_center_id,amount_usd,note,client_request_key,allocated_by)
  VALUES(${companyId},${input.entryId},${input.centerId},${six(value)},
   ${input.note??null},${input.clientRequestKey},${actor.userId})
  RETURNING id
 `))[0];
 await log(tx,companyId,actor,"accounting_cost_allocations",Number(added.id),"create",
  {entryId:{new:input.entryId},centerId:{new:input.centerId},amountUsd:{new:six(value)}});
 return{id:Number(added.id),replayed:false,amountUsd:six(value)};
}
export async function voidAnalyticAllocationTx(tx:DbTransaction,input:{
 companyId:number;allocationId:number;reason:string;actor:AnalyticActor
}){
 const {companyId,actor}=input;
 await assertTransactionCompanyScope(tx,companyId);
 const reason=input.reason.trim();
 if(!reason||reason.length>1000)throw new AnalyticError("ANALYTIC_REASON_INVALID","Reason required (up to 1,000 characters)",400);
 idOrError(input.allocationId,"allocation");
 const row=resultRows<AllocationRow & {voucher_date:string}>(await tx.execute(sql`
  SELECT a.id,a.company_id,a.cost_center_id,a.voucher_entry_id,
   a.amount_usd::text,a.note,a.client_request_key,a.voided_at::text,
   COALESCE(v.effective_date,v.voucher_date)::text AS voucher_date
  FROM accounting_cost_allocations a JOIN voucher_entries e ON e.id=a.voucher_entry_id
  JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=a.company_id
  WHERE a.company_id=${companyId} AND a.id=${input.allocationId} FOR UPDATE OF a
 `))[0];
 if(!row)throw new AnalyticError("ANALYTIC_ALLOCATION_NOT_FOUND","Allocation not found",404);
 if(row.voided_at)throw new AnalyticError("ANALYTIC_ALREADY_VOID","Allocation already cancelled");
 await openDayTx(tx,companyId,row.voucher_date);
 await tx.execute(sql`
  UPDATE accounting_cost_allocations SET voided_at=NOW(),voided_by=${actor.userId},
   void_reason=${reason} WHERE id=${input.allocationId} AND company_id=${companyId}
 `);
 await log(tx,companyId,actor,"accounting_cost_allocations",input.allocationId,"void",
  {voided:{new:true},reason:{new:reason}});
 return{voided:true,id:input.allocationId};
}
export async function listAnalyticAllocationsTx(tx:DbTransaction,input:{
 companyId:number;centerId?:number
}){
 await assertTransactionCompanyScope(tx,input.companyId);
 return resultRows<Record<string,unknown>>(await tx.execute(sql`
 SELECT a.id,a.cost_center_id,a.voucher_entry_id,a.amount_usd::text,a.note,
  a.allocated_at::text,a.client_request_key,a.voided_at::text,
  v.voucher_number,COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
  (v.deleted_at IS NULL AND v.optional=false AND v.reversal_of_voucher_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM vouchers rv WHERE rv.reversal_of_voucher_id=v.id
      AND rv.company_id=v.company_id AND rv.deleted_at IS NULL AND rv.optional=false)) AS source_active
 FROM accounting_cost_allocations a JOIN voucher_entries e ON e.id=a.voucher_entry_id
 JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=a.company_id
 WHERE a.company_id=${input.companyId} AND a.voided_at IS NULL
   AND (${input.centerId??null}::bigint IS NULL OR a.cost_center_id=${input.centerId??null})
 ORDER BY a.id DESC LIMIT 500
 `));
}
export async function createAnalyticBudgetTx(tx:DbTransaction,input:{
 companyId:number;centerId:number;monthStart:string;category:AnalyticCategory;
 plannedUsd:string;notes?:string|null;actor:AnalyticActor
}){
 const {companyId,actor}=input;
 await assertTransactionCompanyScope(tx,companyId);
 const center=await centerTx(tx,companyId,input.centerId);
 if(!center.active)throw new AnalyticError("ANALYTIC_CENTER_INACTIVE","Cannot budget an inactive center");
 const month=fxDay(input.monthStart);
 if(!month.endsWith("-01"))throw new AnalyticError("ANALYTIC_MONTH_INVALID","Use the first calendar day of the month",400);
 if(!["income","cost_of_sales","expense"].includes(input.category))
  throw new AnalyticError("ANALYTIC_CATEGORY_INVALID","Invalid financial category",400);
 const value=amount(input.plannedUsd,true);
 if((input.notes??"").length>1000)throw new AnalyticError("ANALYTIC_NOTE_INVALID","Notes too long",400);
 const now=await companyBusinessDate(companyId,tx);
 if(month<now.slice(0,7)+"-01")throw new AnalyticError("ANALYTIC_BUDGET_PAST",
  "New budgets cannot be retroactively created for a past month",400);
 await openDayTx(tx,companyId,now);
 const row=resultRows<{id:number}&Record<string,unknown>>(await tx.execute(sql`
 INSERT INTO accounting_cost_budgets
 (company_id,cost_center_id,month_start,category,planned_usd,state,notes,created_by)
 VALUES(${companyId},${input.centerId},${month}::date,${input.category},
  ${six(value)},'DRAFT',${input.notes??null},${actor.userId}) RETURNING id
 `))[0];
 await log(tx,companyId,actor,"accounting_cost_budgets",Number(row.id),"create",
  {centerId:{new:input.centerId},month:{new:month},
   category:{new:input.category},plannedUsd:{new:six(value)}});
 return{id:Number(row.id),state:"DRAFT"};
}
export async function changeAnalyticBudgetTx(tx:DbTransaction,input:{
 companyId:number;budgetId:number;operation:"APPROVE"|"ARCHIVE";
 reason?:string;actor:AnalyticActor
}){
 const {companyId,actor}=input;
 await assertTransactionCompanyScope(tx,companyId);
 idOrError(input.budgetId,"budget");
 const row=resultRows<BudgetRow>(await tx.execute(sql`
  SELECT id,cost_center_id,month_start::text,category,planned_usd::text,state,notes
  FROM accounting_cost_budgets WHERE company_id=${companyId} AND id=${input.budgetId}
   FOR UPDATE
 `))[0];
 if(!row)throw new AnalyticError("ANALYTIC_BUDGET_NOT_FOUND","Budget not found",404);
 if(row.state==="ARCHIVED")throw new AnalyticError("ANALYTIC_BUDGET_ARCHIVED","Budget is archived");
 const now=await companyBusinessDate(companyId,tx);
 await openDayTx(tx,companyId,now);
 if(input.operation==="APPROVE"){
  if(row.state!=="DRAFT")throw new AnalyticError("ANALYTIC_ALREADY_APPROVED","Only a draft can be approved");
  if(row.month_start<now.slice(0,7)+"-01")
   throw new AnalyticError("ANALYTIC_BUDGET_PAST","Cannot approve a prior-month budget");
  await tx.execute(sql`UPDATE accounting_cost_budgets SET state='APPROVED',
     approved_by=${actor.userId},approved_at=NOW()
    WHERE id=${input.budgetId} AND company_id=${companyId}`);
 }else{
  const reason=(input.reason??"").trim();
  if(!reason||reason.length>1000)throw new AnalyticError("ANALYTIC_REASON_INVALID","Archive reason required",400);
  await tx.execute(sql`UPDATE accounting_cost_budgets SET state='ARCHIVED',
   archived_by=${actor.userId},archived_at=NOW(),archive_reason=${reason}
   WHERE id=${input.budgetId} AND company_id=${companyId}`);
 }
 await log(tx,companyId,actor,"accounting_cost_budgets",input.budgetId,"update",
  {state:{old:row.state,new:input.operation==="APPROVE"?"APPROVED":"ARCHIVED"},
   reason:{new:input.reason??null}});
 return{id:input.budgetId,state:input.operation==="APPROVE"?"APPROVED":"ARCHIVED"};
}
