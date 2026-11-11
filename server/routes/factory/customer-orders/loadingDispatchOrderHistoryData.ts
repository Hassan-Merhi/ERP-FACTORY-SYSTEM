/**
 * Phase 9 — paginated, immutable Factory dispatch activity timeline.
 * Includes both existing physical events and Phase 4-8 financial events,
 * plus signed closure revisions; never rewrites or summarizes raw audit events.
 * Cursor is composite (timestamp, ID, source) and scoped to ONE company/order.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

export type DispatchHistorySource="ALL"|"PHYSICAL"|"FINANCIAL"|"CLOSURE";
export interface DispatchHistoryEntry {
  source:"PHYSICAL"|"FINANCIAL"|"CLOSURE";
  id:string;dispatchId:string|null;eventType:string;
  actorUsername:string;createdAt:string;
  reason:string|null;details:Record<string,unknown>;
}
export interface DispatchHistoryPage {
  entries:DispatchHistoryEntry[];
  nextCursor:string|null;
  hasMore:boolean;
  sourceFilter:DispatchHistorySource;
  pageSize:number;
  financialSchemaInstalled:boolean;
}
interface Cursor{at:string;id:string;source:"P"|"F"|"C";}
function readCursor(value:string|null):Cursor|null{
  if(!value)return null;
  if(value.length>256)throw new Error("HISTORY_CURSOR_INVALID");
  let raw:unknown;
  try{raw=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));}catch{throw new Error("HISTORY_CURSOR_INVALID");}
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw new Error("HISTORY_CURSOR_INVALID");
  const c=raw as Record<string,unknown>;
  if(c.version!==1 || typeof c.at!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(c.at) ||
     Number.isNaN(Date.parse(c.at)) || typeof c.id!=="string" ||
     !/^[1-9]\d{0,18}$/.test(c.id) ||
     !["P","F","C"].includes(String(c.source))){
    throw new Error("HISTORY_CURSOR_INVALID");
  }
  return {at:c.at,id:c.id,source:c.source as Cursor["source"]};
}
function cursorFor(r:Record<string,unknown>):string{
  return Buffer.from(JSON.stringify({version:1,at:new Date(String(r.createdAt)).toISOString(),
    id:String(r.id),source:String(r.source)}),"utf8").toString("base64url");
}
export async function loadDispatchOrderHistoryPageTx(tx:DbTransaction,args:{
  companyId:number;orderId:number;source:DispatchHistorySource;
  dispatchId?:number;cursor?:string|null;limit:number;
}):Promise<DispatchHistoryPage>{
  if(!Number.isInteger(args.limit) || args.limit<1 || args.limit>100){
    throw new Error("HISTORY_LIMIT_INVALID");
  }
  const cursor=readCursor(args.cursor??null);
  const [schema]=resultRows(await tx.execute(sql`
    SELECT to_regclass('public.factory_dispatch_financial_events') IS NOT NULL AS ready
  `));
  const financeInstalled=schema?.ready===true;
  const financialUnion=financeInstalled ? sql`
    UNION ALL
    SELECT 'F'::text AS source,f.id::bigint AS id,
      f.dispatch_id::text AS "dispatchId",f.event_type AS "eventType",
      f.actor_username AS "actorUsername",f.created_at::timestamptz AS "createdAt",
      f.reason AS reason,f.details AS details
    FROM factory_dispatch_financial_events f
    WHERE f.company_id=${args.companyId} AND f.order_id=${args.orderId}
      ${args.dispatchId ? sql`AND f.dispatch_id=${args.dispatchId}` : sql``}
  ` : sql``;
  const all=await tx.execute(sql`
    SELECT * FROM (
      SELECT 'P'::text AS source,e.id::bigint AS id,
        e.dispatch_id::text AS "dispatchId",e.event_type AS "eventType",
        e.actor_username AS "actorUsername",e.created_at::timestamptz AS "createdAt",
        NULL::text AS reason,e.event_data AS details
      FROM factory_loading_dispatch_events e
      WHERE e.company_id=${args.companyId} AND e.order_id=${args.orderId}
        ${args.dispatchId ? sql`AND e.dispatch_id=${args.dispatchId}`:sql``}
      UNION ALL
      SELECT 'C'::text AS source,h.id::bigint AS id,
        h.dispatch_id::text AS "dispatchId",
        'TRIP_CLOSURE_REVISION'::text AS "eventType",
        h.closed_by_username AS "actorUsername",
        h.closed_at::timestamptz AS "createdAt",
        h.discrepancy_reason AS reason,
        jsonb_build_object(
          'revision',h.revision,
          'approvedWithDiscrepancies',h.approved_with_discrepancies,
          'closeFingerprint',h.close_fingerprint,
          'reopenedAt',h.reopened_at,'reopenReason',h.reopen_reason,
          'reopenedBy',h.reopened_by_username
        ) AS details
      FROM factory_loading_dispatch_closure_history h
      WHERE h.company_id=${args.companyId} AND h.order_id=${args.orderId}
        ${args.dispatchId ? sql`AND h.dispatch_id=${args.dispatchId}`:sql``}
      ${financialUnion}
    ) all_events
    WHERE TRUE
      ${args.source==="PHYSICAL" ? sql`AND all_events.source='P'` :
        args.source==="FINANCIAL"?sql`AND all_events.source='F'`:
        args.source==="CLOSURE"?sql`AND all_events.source='C'`:sql``}
      ${cursor ? sql`AND (all_events."createdAt",all_events.id,all_events.source)
          < (${cursor.at}::timestamptz,${cursor.id}::bigint,${cursor.source}::text)`:sql``}
    ORDER BY all_events."createdAt" DESC,all_events.id DESC,all_events.source DESC
    LIMIT ${args.limit+1}
  `);
  const allRows=resultRows(all);
  const page=allRows.slice(0,args.limit);
  const entries:DispatchHistoryEntry[]=page.map(r=>({
    source:r.source==="F"?"FINANCIAL":r.source==="C"?"CLOSURE":"PHYSICAL",
    id:String(r.id),dispatchId:r.dispatchId==null?null:String(r.dispatchId),
    eventType:String(r.eventType),
    actorUsername:String(r.actorUsername??"System"),
    createdAt:new Date(String(r.createdAt)).toISOString(),
    reason:r.reason==null?null:String(r.reason),
    details:r.details && typeof r.details==="object" && !Array.isArray(r.details)
      ? r.details as Record<string,unknown> : {},
  }));
  const hasMore=allRows.length>args.limit;
  return {
    entries,hasMore,
    nextCursor:hasMore && page.length?cursorFor(page[page.length-1]):null,
    sourceFilter:args.source,pageSize:args.limit,
    financialSchemaInstalled:financeInstalled,
  };
}
