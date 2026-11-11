/**
 * Phase 5: exactly one immutable, cost-free approved workbook and independently
 * tracked main-GREEN-API delivery to the approval group and destination.
 * Only status='approved' batches can enter this worker.
 *
 * Durable rule: after a network timeout, lost response, process crash, or
 * ambiguous HTTP result, status='uncertain' and NEVER auto-retry.
 */
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { readFactoryEdgeConfiguration, shouldStartEdgeBackgroundJobs } from "../edge/edgeRuntimePolicy.mjs";
import { runWithDatabaseMaintenanceScope } from "./security/databaseScopeRuntimeContext";
import { createNoCostExcel } from "./stockTransferNoCostWorkbook";
import {
  snapshotSha256, validateApprovedOrderNoCostSnapshot,
} from "./stockTransferOrderApprovedWorkbookSnapshot";
import { sendApprovedStockTransferOrderWorkbook } from "./whatsappService";

const INTERVAL_MS = 20_000;
const MAX_PER_SWEEP = 12;
const MAX_ATTEMPTS = 3;
const CLAIM_SECONDS = 150;
let timer: NodeJS.Timeout | null = null;
let running = false;
const active = new Set<number>();

export function stockTransferOrderWaDeliveryEnabled(): boolean {
  return process.env.STO_WA_DELIVERY_ENABLED !== "false" &&
    process.env.ENABLE_SCHEDULERS !== "false" &&
    shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration());
}

type WorkbookRow = {
  company_id: number;
  batch_id: number | string;
  status: string;
  snapshot_json: unknown;
  snapshot_sha256: string;
  workbook_bytes: Buffer | null;
  workbook_sha256: string | null;
  filename: string | null;
};
type Rendered = { buffer: Buffer; hash: string; filename: string };
type DeliveryRow = {
  id: number | string;
  company_id: number;
  batch_id: number | string;
  recipient_kind: "approval_group" | "destination";
  recipient_chat_id: string;
  status: string;
  attempt_count: number;
};
type Claim = {
  id: number;
  companyId: number;
  batchId: number;
  chatId: string;
  recipientKind: "approval_group" | "destination";
  claimToken: string;
  originalInstanceId: string;
  attemptCount: number;
};

function approvedFileName(destination: string, date: string, batchKey: string): string {
  return "Truck_Trip_" + destination.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 70) +
    "_" + date + "_" + batchKey.slice(0, 8) + "_approved.xlsx";
}

async function approvedWorkbook(companyId: number, batchId: number): Promise<Rendered | null> {
  const result = await pool.query<WorkbookRow>(
    "SELECT w.company_id,w.batch_id,b.status,w.snapshot_json,w.snapshot_sha256," +
    "w.workbook_bytes,w.workbook_sha256,w.filename " +
    "FROM stock_transfer_order_approval_workbooks w " +
    "JOIN stock_transfer_order_approval_batches b ON b.company_id=w.company_id AND b.id=w.batch_id " +
    "WHERE w.company_id=$1 AND w.batch_id=$2",
    [companyId,batchId]
  );
  const row = result.rows[0];
  if (!row || row.status !== "approved") return null;
  const snapshot = validateApprovedOrderNoCostSnapshot(row.snapshot_json);
  if (snapshotSha256(snapshot) !== row.snapshot_sha256) {
    throw new Error("Approved Excel snapshot SHA-256 mismatch: refusing WhatsApp send.");
  }
  if (row.workbook_bytes) {
    const bytes = Buffer.from(row.workbook_bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!row.workbook_sha256 || !row.filename || hash !== row.workbook_sha256) {
      throw new Error("Previously rendered approved Excel checksum mismatch.");
    }
    return { buffer: bytes, hash, filename: row.filename };
  }
  const rendered = await createNoCostExcel({
    companyName: snapshot.companyName,
    destinationName: snapshot.destinationName,
    transferDate: snapshot.transferDate,
    items: snapshot.items,
    batchReference: snapshot.batchKey,
    approvedOrders: snapshot.orderNumbers,
  });
  if (!Buffer.isBuffer(rendered) || !rendered.length || rendered.length > 15 * 1024 * 1024) {
    throw new Error("Approved Excel file failed size validation.");
  }
  const hash = createHash("sha256").update(rendered).digest("hex");
  const filename = approvedFileName(snapshot.destinationName, snapshot.transferDate, snapshot.batchKey);
  // The first renderer wins. Other workers re-read identical persisted bytes.
  const stored = await pool.query<WorkbookRow>(
    "UPDATE stock_transfer_order_approval_workbooks w " +
      "SET workbook_bytes=$3,workbook_sha256=$4,filename=$5,rendered_at=clock_timestamp() " +
      "WHERE w.company_id=$1 AND w.batch_id=$2 AND w.workbook_bytes IS NULL " +
      "AND EXISTS (SELECT 1 FROM stock_transfer_order_approval_batches b " +
      "WHERE b.company_id=w.company_id AND b.id=w.batch_id AND b.status='approved') " +
      "RETURNING w.company_id,w.batch_id,'approved'::text AS status,w.snapshot_json,w.snapshot_sha256," +
      "w.workbook_bytes,w.workbook_sha256,w.filename",
    [companyId,batchId,rendered,hash,filename]
  );
  if (stored.rowCount) return { buffer: rendered, hash, filename };
  // Someone else rendered first; the exact, already-persisted copy wins.
  const after = await pool.query<WorkbookRow>(
    "SELECT w.company_id,w.batch_id,b.status,w.snapshot_json,w.snapshot_sha256," +
      "w.workbook_bytes,w.workbook_sha256,w.filename " +
      "FROM stock_transfer_order_approval_workbooks w " +
      "JOIN stock_transfer_order_approval_batches b ON b.company_id=w.company_id AND b.id=w.batch_id " +
      "WHERE w.company_id=$1 AND w.batch_id=$2",
    [companyId,batchId]
  );
  const persisted = after.rows[0];
  if (!persisted || persisted.status !== "approved" || !persisted.workbook_bytes ||
      !persisted.workbook_sha256 || !persisted.filename) return null;
  const buf = Buffer.from(persisted.workbook_bytes);
  if (createHash("sha256").update(buf).digest("hex") !== persisted.workbook_sha256) {
    throw new Error("Concurrent approved Excel checksum mismatch.");
  }
  return { buffer: buf, hash: persisted.workbook_sha256, filename: persisted.filename };
}

export async function quarantineExpiredStockTransferOrderWaClaims(): Promise<number> {
  // A worker may have uploaded successfully and crashed before recording the
  // returned message ID. Never repeat an expired claimed send automatically.
  const result = await pool.query(
    "WITH expired AS (" +
      "UPDATE stock_transfer_order_approval_deliveries d SET status='uncertain'," +
      "claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()," +
      "last_error='Worker interrupted after send claim; delivery outcome must be verified' " +
      "WHERE d.status='sending' AND d.claim_expires_at < clock_timestamp() " +
      "RETURNING d.company_id,d.batch_id,d.recipient_kind,d.recipient_chat_id,d.id) " +
      "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
      "SELECT company_id,batch_id,'delivery_uncertain'," +
      "jsonb_build_object('recipientKind',recipient_kind,'recipientChatId',recipient_chat_id," +
      "'deliveryId',id,'reason','worker_interrupted') FROM expired RETURNING id"
  );
  return result.rowCount ?? 0;
}

async function recordSameChatAlias(item: DeliveryRow): Promise<boolean> {
  if (item.recipient_kind !== "destination") return false;
  // An alias must still match the immutable destination selected when the
  // original approval request was created. Never silently redirect an order.
  const frozen = await pool.query<{ frozen_chat: string | null }>(
    "SELECT ev.details->>'destinationRecipientChatId' AS frozen_chat " +
    "FROM stock_transfer_order_approval_events ev " +
    "WHERE ev.company_id=$1 AND ev.batch_id=$2 AND ev.event_type='draft_created' " +
    "ORDER BY ev.id LIMIT 1",
    [item.company_id,item.batch_id]
  );
  if (frozen.rows[0]?.frozen_chat !== item.recipient_chat_id) {
    await pool.query(
      "WITH refused AS (UPDATE stock_transfer_order_approval_deliveries " +
      "SET status='failed',attempt_count=$3,available_at=clock_timestamp()+interval '100 years'," +
      "last_error='Recipient no longer matches the originally approved destination'," +
      "updated_at=clock_timestamp() " +
      "WHERE company_id=$1 AND id=$2 AND status IN ('pending','failed') " +
      "RETURNING id,company_id,batch_id) " +
      "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
      "SELECT company_id,batch_id,'delivery_failed'," +
      "jsonb_build_object('deliveryId',id,'recipientKind','destination'," +
      "'reason','frozen_destination_mismatch') FROM refused",
      [item.company_id,item.id,MAX_ATTEMPTS]
    );
    return true;
  }
  const records = await pool.query<{
    recipient_chat_id: string; status: string; provider_message_id: string | null;
    workbook_sha256: string | null; filename: string | null; workbook_storage_key: string | null;
    attempt_count: number;
  }>(
    "SELECT recipient_chat_id,status,provider_message_id,workbook_sha256,filename,workbook_storage_key,attempt_count " +
    "FROM stock_transfer_order_approval_deliveries WHERE company_id=$1 AND batch_id=$2 " +
    "AND recipient_kind='approval_group'",
    [item.company_id,item.batch_id]
  );
  const primary = records.rows[0];
  if (!primary || primary.recipient_chat_id !== item.recipient_chat_id) return false;
  if (primary.status !== "accepted" || !primary.provider_message_id) {
    if (primary.status === "failed" && primary.attempt_count >= MAX_ATTEMPTS) {
      await pool.query(
        "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries " +
        "SET status='failed',attempt_count=$3,available_at=clock_timestamp()+interval '100 years'," +
        "last_error='Same WhatsApp chat as approval group; its upload exhausted safe retries'," +
        "updated_at=clock_timestamp() " +
        "WHERE id=$1 AND company_id=$2 AND status IN ('pending','failed') " +
        "RETURNING id,company_id,batch_id) " +
        "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
        "SELECT company_id,batch_id,'delivery_failed'," +
        "jsonb_build_object('deliveryId',id,'recipientKind','destination','reason','same_chat_primary_failed') FROM alias",
        [item.id,item.company_id,MAX_ATTEMPTS]
      );
    }
    if (primary.status === "uncertain") {
      await pool.query(
        "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries " +
        "SET status='uncertain',last_error='Same chat as approval group; first send is uncertain'," +
        "updated_at=clock_timestamp() " +
        "WHERE id=$1 AND company_id=$2 AND status IN ('pending','failed') RETURNING id,company_id,batch_id) " +
        "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
        "SELECT company_id,batch_id,'delivery_uncertain'," +
        "jsonb_build_object('deliveryId',id,'recipientKind','destination','reason','same_chat_primary_uncertain') FROM alias",
        [item.id,item.company_id]
      );
    }
    return true; // Always wait for primary rather than send a duplicate.
  }
  await pool.query(
    "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries " +
      "SET status='accepted',provider_message_id=$3,workbook_sha256=$4,filename=$5," +
      "workbook_storage_key=$6,accepted_at=clock_timestamp(),updated_at=clock_timestamp() " +
      "WHERE id=$1 AND company_id=$2 AND status IN ('pending','failed') " +
      "RETURNING id,company_id,batch_id) " +
      "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
      "SELECT company_id,batch_id,'delivery_accepted'," +
      "jsonb_build_object('deliveryId',id,'recipientKind','destination'," +
      "'sameChatDeduplicated',true,'sourceMessageId',$3::text) FROM alias",
    [item.id,item.company_id,primary.provider_message_id,primary.workbook_sha256,
     primary.filename,primary.workbook_storage_key]
  );
  return true;
}

async function claimForSend(row: DeliveryRow, workbook: Rendered): Promise<Claim | null> {
  const claimToken = randomUUID();
  const result = await pool.query<{
    id: number | string; company_id: number; batch_id: number | string;
    recipient_kind: "approval_group"|"destination";
    recipient_chat_id: string; attempt_count: number; whatsapp_instance_id: string;
  }>(
    "UPDATE stock_transfer_order_approval_deliveries d SET " +
    "status='sending',claim_token=$2::uuid,claim_expires_at=clock_timestamp()+($3::int * interval '1 second')," +
    "attempt_count=attempt_count+1,workbook_sha256=$4,filename=$5," +
    "workbook_storage_key=$6,updated_at=clock_timestamp(),last_error=NULL " +
    "FROM stock_transfer_order_approval_batches b " +
    "WHERE d.id=$1 AND d.company_id=b.company_id AND d.batch_id=b.id " +
    "AND b.status='approved' AND b.whatsapp_instance_id IS NOT NULL " +
    "AND d.recipient_chat_id = CASE WHEN d.recipient_kind='approval_group' " +
    "THEN b.approval_group_chat_id ELSE (" +
    "SELECT ev.details->>'destinationRecipientChatId' " +
    "FROM stock_transfer_order_approval_events ev " +
    "WHERE ev.company_id=b.company_id AND ev.batch_id=b.id " +
    "AND ev.event_type='draft_created' ORDER BY ev.id LIMIT 1) END " +
    "AND d.status IN ('pending','failed') AND d.available_at<=clock_timestamp() " +
    "AND d.attempt_count < $7 " +
    "RETURNING d.id,d.company_id,d.batch_id,d.recipient_kind,d.recipient_chat_id," +
    "d.attempt_count,b.whatsapp_instance_id",
    [row.id,claimToken,CLAIM_SECONDS,workbook.hash,workbook.filename,
     "sto-wa-db:" + row.batch_id,MAX_ATTEMPTS]
  );
  const c=result.rows[0];if (!c) return null;
  return { id:Number(c.id),companyId:Number(c.company_id),batchId:Number(c.batch_id),
    chatId:c.recipient_chat_id,recipientKind:c.recipient_kind,claimToken,
    originalInstanceId:c.whatsapp_instance_id,attemptCount:c.attempt_count };
}

async function finishSend(claim: Claim, outcome: {
  outcome: "accepted" | "failed" | "uncertain"; idMessage?: string; error?: string;
}): Promise<void> {
  // Status and append-only event must commit together. If DB dies after a
  // successful HTTP response, the claim expires to uncertain, never duplicate.
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const status=outcome.outcome;
    const completed=await client.query(
      "UPDATE stock_transfer_order_approval_deliveries SET " +
      "status=$4,provider_message_id=$5,last_error=$6,accepted_at=" +
      "CASE WHEN $4='accepted' THEN clock_timestamp() ELSE NULL END," +
      "claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()," +
      "available_at=clock_timestamp()+ (LEAST(3600,60 * power(2,LEAST(attempt_count,5))) * interval '1 second') " +
      "WHERE id=$1 AND company_id=$2 AND claim_token=$3::uuid AND status='sending' " +
      "RETURNING id",
      [claim.id,claim.companyId,claim.claimToken,status,
       status==="accepted"?outcome.idMessage??null:null,
       status==="accepted"?null:String(outcome.error??"GREEN API rejected the file").slice(0,300)]
    );
    if (!completed.rowCount) { await client.query("ROLLBACK"); return; }
    await client.query(
      "INSERT INTO stock_transfer_order_approval_events " +
      "(company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,details) " +
      "VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [claim.companyId,claim.batchId,
       status==="accepted"?"delivery_accepted":status==="failed"?"delivery_failed":"delivery_uncertain",
       claim.originalInstanceId,status==="accepted"?outcome.idMessage??null:null,
       JSON.stringify({deliveryId:claim.id,recipientKind:claim.recipientKind,
         recipientChatId:claim.chatId,attempt:claim.attemptCount,reason:outcome.error??null})]
    );
    await client.query("COMMIT");
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
}

async function processDelivery(id: number): Promise<void> {
  if (!stockTransferOrderWaDeliveryEnabled() || active.has(id)) return;
  active.add(id);
  try {
    await runWithDatabaseMaintenanceScope("sto_whatsapp_approved_excel_delivery",async()=>{
      const rows=await pool.query<DeliveryRow>(
        "SELECT d.id,d.company_id,d.batch_id,d.recipient_kind,d.recipient_chat_id,d.status,d.attempt_count " +
        "FROM stock_transfer_order_approval_deliveries d " +
        "JOIN stock_transfer_order_approval_batches b ON b.id=d.batch_id AND b.company_id=d.company_id " +
        "WHERE d.id=$1 AND b.status='approved'",[id]
      );
      const item=rows.rows[0];
      if (!item || !["pending","failed"].includes(item.status) || item.attempt_count>=MAX_ATTEMPTS) return;
      if(await recordSameChatAlias(item)) return;
      const workbook=await approvedWorkbook(Number(item.company_id),Number(item.batch_id));
      if (!workbook) return;
      const claim=await claimForSend(item,workbook);
      if(!claim) return;
      let outcome: Awaited<ReturnType<typeof sendApprovedStockTransferOrderWorkbook>>;
      try {
        outcome=await sendApprovedStockTransferOrderWorkbook(
          claim.originalInstanceId,claim.chatId,workbook.buffer,workbook.filename,
          "Approved Stock Transfer Orders — batch " + claim.batchId + " — without cost"
        );
      } catch(e) {
        outcome={outcome:"uncertain",error:e instanceof Error?e.message:"Unexpected upload failure"};
      }
      await finishSend(claim,outcome);
      logger.info("[STO WA] Approved Excel delivery attempt recorded",{
        batchId:claim.batchId,recipientKind:claim.recipientKind,outcome:outcome.outcome,
        attempt:claim.attemptCount,
      });
    });
  } catch(error) {
    logger.error("[STO WA] Approved Excel delivery deferred",{
      deliveryId:id,error:error instanceof Error?error.message:"unknown error",
    });
  } finally {active.delete(id);}
}

export async function sweepStockTransferOrderWaDeliveries(): Promise<number> {
  if (!stockTransferOrderWaDeliveryEnabled() || running) return 0;
  running=true;
  try {
    return await runWithDatabaseMaintenanceScope("sto_whatsapp_excel_delivery_scan",async()=>{
      await quarantineExpiredStockTransferOrderWaClaims();
      const rows=await pool.query<{id:number|string}>(
        "SELECT d.id FROM stock_transfer_order_approval_deliveries d " +
        "JOIN stock_transfer_order_approval_batches b ON b.id=d.batch_id AND b.company_id=d.company_id " +
        "WHERE b.status='approved' AND d.status IN ('pending','failed') " +
        "AND d.available_at<=clock_timestamp() AND d.attempt_count < $1 " +
        "ORDER BY d.batch_id,CASE WHEN d.recipient_kind='approval_group' THEN 0 ELSE 1 END,d.id " +
        "LIMIT $2",
        [MAX_ATTEMPTS,MAX_PER_SWEEP * 4]
      );
      let processed=0;
      for(const item of rows.rows){
        if(processed>=MAX_PER_SWEEP)break;
        await processDelivery(Number(item.id));
        processed++;
      }
      return processed;
    });
  } catch(e) {
    logger.error("[STO WA] Approved Excel delivery sweep failed",{
      error:e instanceof Error?e.message:"unknown error",
    });
    return 0;
  } finally {running=false;}
}

export function queueStockTransferOrderWaDeliveries(batchId:number):void{
  if (!stockTransferOrderWaDeliveryEnabled() || !Number.isSafeInteger(batchId) || batchId<=0) return;
  // The scan owns ordering: approval group first, destination second.
  setImmediate(()=>{void sweepStockTransferOrderWaDeliveries();});
}
export function startStockTransferOrderWaDeliveryWorker():void{
  if(timer || !stockTransferOrderWaDeliveryEnabled())return;
  timer=setInterval(()=>{void sweepStockTransferOrderWaDeliveries();},INTERVAL_MS);
  timer.unref();
  void sweepStockTransferOrderWaDeliveries();
  logger.info("[STO WA] Approved no-cost Excel delivery worker started");
}
