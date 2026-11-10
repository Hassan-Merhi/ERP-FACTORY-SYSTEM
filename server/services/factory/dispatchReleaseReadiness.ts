/**
 * Phase 10 — fail-closed DDL/runtime release preflight.
 *
 * Verifies the exact *manual* TablePlus safeguards before approving an order
 * or writing a combined invoice. It never runs DDL, changes data, performs
 * a DB migration or reaches into Normal ERP's separate company scope.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

export type DispatchReleaseStage="RECONCILIATION"|"FINAL_INVOICE";
export interface DispatchReleaseReadiness {
  ready:boolean;stage:DispatchReleaseStage;
  checkedAt:string;
  missing:string[];
  verified:string[];
  applicationActionsAllowed:boolean;
}
export class DispatchReleaseNotReadyError extends Error {
  readonly status=503;
  readonly code="FACTORY_DISPATCH_TABLEPLUS_GUARDS_PENDING";
  constructor(readonly report:DispatchReleaseReadiness){
    super("Factory Dispatch "+report.stage.toLowerCase().replace("_"," ")+
      " is disabled until required manual TablePlus safeguards are installed: "+
      report.missing.join(", "));
  }
}
const requiredTables=[
  "factory_dispatch_trip_financials","factory_dispatch_trip_financial_bales",
  "factory_dispatch_trip_charges","factory_dispatch_trip_postings",
  "factory_dispatch_trip_exports","factory_dispatch_order_consolidations",
  "factory_dispatch_financial_events",
];
const commonTriggers=[
  ["factory_dispatch_order_bale_financial_guard","customer_order_bales"],
  ["factory_dispatch_physical_posted_guard","factory_loading_dispatches"],
  ["factory_dispatch_physical_scan_posted_guard","factory_loading_dispatch_scans"],
  ["factory_dispatch_closure_posted_guard","factory_loading_dispatch_closure_history"],
  ["factory_dispatch_source_voucher_guard","vouchers"],
  ["factory_dispatch_source_voucher_entries_guard","voucher_entries"],
  ["factory_dispatch_source_posting_identity_guard","accounting_posting_requests"],
  ["factory_dispatch_signed_consolidation_guard","factory_dispatch_order_consolidations"],
  ["factory_dispatch_signed_trip_guard","factory_loading_dispatches"],
  ["factory_dispatch_signed_scan_guard","factory_loading_dispatch_scans"],
  ["factory_dispatch_signed_closure_guard","factory_loading_dispatch_closure_history"],
  ["factory_dispatch_signed_order_bale_guard","customer_order_bales"],
  ["factory_dispatch_signed_order_charge_guard","customer_order_charges"],
  ["factory_dispatch_signed_financial_guard","factory_dispatch_trip_financials"],
];
const finalTriggers=[["factory_dispatch_final_invoice_guard","factory_dispatch_order_consolidations"]];
const signedColumns=[
  ["factory_dispatch_order_consolidations","reconciled_at"],
  ["factory_dispatch_order_consolidations","reconciliation_snapshot"],
  ["factory_dispatch_order_consolidations","reconciled_by_user_id"],
  ["factory_dispatch_order_consolidations","reconciliation_reason"],
];
const finalColumns=[["factory_dispatch_order_consolidations","finalization_details"]];
const signedConstraints=[
  "factory_dispatch_order_consolidations_signoff_ck",
  "factory_dispatch_order_consolidations_total_math_ck",
];
const finalConstraints=["factory_dispatch_order_consolidations_final_invoice_ck"];
const mustExist=(r:Record<string,unknown>)=>r.present===true;
const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export async function factoryDispatchReleaseReadinessTx(
  tx:DbTransaction,stage:DispatchReleaseStage
):Promise<DispatchReleaseReadiness>{
  const missing:string[]=[];
  const verified:string[]=[];
  const checks=stage==="FINAL_INVOICE";
  // All input identifiers below are in source-controlled static lists, not
  // user inputs. SQL VALUES is built with Drizzle bound strings throughout.
  const tableRows=resultRows(await tx.execute(sql`
    SELECT k.name,
      to_regclass('public.'||k.name) IS NOT NULL AS present
    FROM (VALUES ${sql.join(requiredTables.map(t=>sql`(${t}::text)`),sql`,`)})
     AS k(name)
  `));
  for(const r of tableRows){
    const name=String(r.name);
    (mustExist(r)?verified:missing).push("table:"+name);
  }
  const triggerDefs=[...commonTriggers,...(checks?finalTriggers:[])];
  const triggerRows=resultRows(await tx.execute(sql`
    SELECT check_list.name,check_list.table_name,
       EXISTS (
         SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid=to_regclass('public.'||check_list.table_name)
           AND t.tgname=check_list.name
           AND t.tgenabled<>'D'
       ) AS present
    FROM (VALUES ${sql.join(triggerDefs.map(([name,table])=>sql`(${name}::text,${table}::text)`),sql`,`)})
       AS check_list(name,table_name)
  `));
  for(const r of triggerRows){
    (mustExist(r)?verified:missing).push("trigger:"+String(r.name));
  }
  const columns=[...signedColumns,...(checks?finalColumns:[])];
  const columnRows=resultRows(await tx.execute(sql`
    SELECT c.table_name,c.column_name,EXISTS (
      SELECT 1 FROM information_schema.columns i
      WHERE i.table_schema='public' AND i.table_name=c.table_name
        AND i.column_name=c.column_name
    ) AS present
    FROM (VALUES ${sql.join(columns.map(([table,column])=>sql`(${table}::text,${column}::text)`),sql`,`)})
      AS c(table_name,column_name)
  `));
  for(const r of columnRows){
    (mustExist(r)?verified:missing).push("column:"+String(r.table_name)+"."+String(r.column_name));
  }
  const constraints=[...signedConstraints,...(checks?finalConstraints:[])];
  const constraintRows=resultRows(await tx.execute(sql`
    SELECT k.name,EXISTS(
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid=to_regclass('public.factory_dispatch_order_consolidations')
        AND c.conname=k.name AND c.convalidated
    ) AS present
    FROM (VALUES ${sql.join(constraints.map(t=>sql`(${t}::text)`),sql`,`)})
     AS k(name)
  `));
  for(const r of constraintRows){
    (mustExist(r)?verified:missing).push("constraint:"+String(r.name));
  }
  const policies=resultRows(await tx.execute(sql`
    SELECT k.name,
      COALESCE(c.relrowsecurity,FALSE) AND COALESCE(c.relforcerowsecurity,FALSE) AS present
    FROM (VALUES
      ('factory_dispatch_trip_financials'::text),
      ('factory_dispatch_trip_postings'::text),
      ('factory_dispatch_order_consolidations'::text),
      ('factory_dispatch_financial_events'::text)
    ) AS k(name)
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||k.name)
  `));
  for(const r of policies){
    (mustExist(r)?verified:missing).push("forced_company_rls:"+String(r.name));
  }
  if(checks){
    const [unique]=resultRows(await tx.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_index i
        JOIN pg_class index_relation ON index_relation.oid=i.indexrelid
        WHERE i.indrelid=to_regclass('public.factory_dispatch_order_consolidations')
          AND i.indisunique AND i.indisvalid AND i.indisready
          AND index_relation.relname='factory_dispatch_final_invoice_number_uq'
      ) AS present
    `));
    (unique?.present===true?verified:missing).push("unique_index:factory_dispatch_final_invoice_number_uq");
  }
  return {
    ready:missing.length===0,stage,missing,verified,
    checkedAt:new Date().toISOString(),
    applicationActionsAllowed:missing.length===0,
  };
}
export async function assertFactoryDispatchReleaseReadyTx(
  tx:DbTransaction,stage:DispatchReleaseStage
):Promise<void>{
  const result=await factoryDispatchReleaseReadinessTx(tx,stage);
  if(!result.ready)throw new DispatchReleaseNotReadyError(result);
}
