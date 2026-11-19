// Extracted from ./stockTransferOrderWaDeliveryWorker.ts
import { pool } from "../db";

export const INTERVAL_MS = 20_000;

export const MAX_PER_SWEEP = 12;

export const MAX_ATTEMPTS = 3;

export const CLAIM_SECONDS = 150;

export const active = new Set<number>();

export type WorkbookRow = {
  company_id: number;
  batch_id: number | string;
  status: string;
  snapshot_json: unknown;
  snapshot_sha256: string;
  workbook_bytes: Buffer | null;
  workbook_sha256: string | null;
  filename: string | null;
};

export type Rendered = { buffer: Buffer; hash: string; filename: string };

export type DeliveryRow = {
  id: number | string;
  company_id: number;
  batch_id: number | string;
  recipient_kind: "approval_group" | "destination";
  recipient_chat_id: string;
  status: string;
  attempt_count: number;
};

export type Claim = {
  id: number;
  companyId: number;
  batchId: number;
  chatId: string;
  recipientKind: "approval_group" | "destination";
  claimToken: string;
  originalInstanceId: string;
  attemptCount: number;
};

export async function recordSameChatAlias(item: DeliveryRow): Promise<boolean> {
  if (item.recipient_kind !== "destination") return false;
  // An alias must still match the immutable destination selected when the
  // original approval request was created. Never silently redirect an order.
  const frozen = await pool.query<{ frozen_chat: string | null }>(
    "SELECT ev.details->>'destinationRecipientChatId' AS frozen_chat " +
      "FROM stock_transfer_order_approval_events ev " +
      "WHERE ev.company_id=$1 AND ev.batch_id=$2 AND ev.event_type='draft_created' " +
      "ORDER BY ev.id LIMIT 1",
    [item.company_id, item.batch_id]
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
      [item.company_id, item.id, MAX_ATTEMPTS]
    );
    return true;
  }
  const records = await pool.query<{
    recipient_chat_id: string;
    status: string;
    provider_message_id: string | null;
    workbook_sha256: string | null;
    filename: string | null;
    workbook_storage_key: string | null;
    attempt_count: number;
  }>(
    "SELECT recipient_chat_id,status,provider_message_id,workbook_sha256,filename,workbook_storage_key,attempt_count " +
      "FROM stock_transfer_order_approval_deliveries WHERE company_id=$1 AND batch_id=$2 " +
      "AND recipient_kind='approval_group'",
    [item.company_id, item.batch_id]
  );
  const primary = records.rows[0];
  if (!primary || primary.recipient_chat_id !== item.recipient_chat_id) return false;
  if (primary.status === "verified") {
    // Admin supplied independently checked evidence that this ONE physical
    // message reached the shared group/destination chat. Never upload twice.
    await pool.query(
      "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries d " +
        "SET status='verified',last_error=NULL,updated_at=clock_timestamp() " +
        "WHERE d.id=$1 AND d.company_id=$2 AND d.status IN ('pending','failed','uncertain') " +
        "AND EXISTS (SELECT 1 FROM stock_transfer_order_approval_deliveries p " +
        "WHERE p.company_id=d.company_id AND p.batch_id=d.batch_id " +
        "AND p.recipient_kind='approval_group' AND p.status='verified') " +
        "RETURNING d.id,d.company_id,d.batch_id) " +
        "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
        "SELECT company_id,batch_id,'delivery_manually_verified'," +
        "jsonb_build_object('deliveryId',id,'recipientKind','destination'," +
        "'sameChatDeduplicated',true,'source','approval_group_manual_verification') FROM alias",
      [item.id, item.company_id]
    );
    return true;
  }
  if (primary.status !== "accepted" || !primary.provider_message_id) {
    if (primary.status === "failed" && primary.attempt_count >= MAX_ATTEMPTS) {
      await pool.query(
        "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries d " +
          "SET status='failed',attempt_count=$3,available_at=clock_timestamp()+interval '100 years'," +
          "last_error='Same WhatsApp chat as approval group; its upload exhausted safe retries'," +
          "updated_at=clock_timestamp() " +
          "WHERE d.id=$1 AND d.company_id=$2 AND d.status IN ('pending','failed') " +
          "AND EXISTS (SELECT 1 FROM stock_transfer_order_approval_deliveries p " +
          "WHERE p.company_id=d.company_id AND p.batch_id=d.batch_id " +
          "AND p.recipient_kind='approval_group' AND p.status='failed' AND p.attempt_count >= $3) " +
          "RETURNING d.id,d.company_id,d.batch_id) " +
          "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
          "SELECT company_id,batch_id,'delivery_failed'," +
          "jsonb_build_object('deliveryId',id,'recipientKind','destination','reason','same_chat_primary_failed') FROM alias",
        [item.id, item.company_id, MAX_ATTEMPTS]
      );
    }
    if (primary.status === "uncertain") {
      await pool.query(
        "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries d " +
          "SET status='uncertain',last_error='Same chat as approval group; first send is uncertain'," +
          "updated_at=clock_timestamp() " +
          "WHERE d.id=$1 AND d.company_id=$2 AND d.status IN ('pending','failed') " +
          "AND EXISTS (SELECT 1 FROM stock_transfer_order_approval_deliveries p " +
          "WHERE p.company_id=d.company_id AND p.batch_id=d.batch_id " +
          "AND p.recipient_kind='approval_group' AND p.status='uncertain') " +
          "RETURNING d.id,d.company_id,d.batch_id) " +
          "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
          "SELECT company_id,batch_id,'delivery_uncertain'," +
          "jsonb_build_object('deliveryId',id,'recipientKind','destination','reason','same_chat_primary_uncertain') FROM alias",
        [item.id, item.company_id]
      );
    }
    return true; // Always wait for primary rather than send a duplicate.
  }
  await pool.query(
    "WITH alias AS (UPDATE stock_transfer_order_approval_deliveries d " +
      "SET status='accepted',provider_message_id=$3,workbook_sha256=$4,filename=$5," +
      "workbook_storage_key=$6,accepted_at=clock_timestamp(),updated_at=clock_timestamp() " +
      "WHERE id=$1 AND company_id=$2 AND status IN ('pending','failed') " +
      "RETURNING id,company_id,batch_id) " +
      "INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) " +
      "SELECT company_id,batch_id,'delivery_accepted'," +
      "jsonb_build_object('deliveryId',id,'recipientKind','destination'," +
      "'sameChatDeduplicated',true,'sourceMessageId',$3::text) FROM alias",
    [
      item.id,
      item.company_id,
      primary.provider_message_id,
      primary.workbook_sha256,
      primary.filename,
      primary.workbook_storage_key,
    ]
  );
  return true;
}

export async function finishSend(
  claim: Claim,
  outcome: {
    outcome: "accepted" | "failed" | "uncertain";
    idMessage?: string;
    error?: string;
  }
): Promise<void> {
  // Status and append-only event must commit together. If DB dies after a
  // successful HTTP response, the claim expires to uncertain, never duplicate.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const status = outcome.outcome;
    const completed = await client.query(
      "UPDATE stock_transfer_order_approval_deliveries SET " +
        "status=$4,provider_message_id=$5,last_error=$6,accepted_at=" +
        "CASE WHEN $4='accepted' THEN clock_timestamp() ELSE NULL END," +
        "claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()," +
        "available_at=clock_timestamp()+ (LEAST(3600,60 * power(2,LEAST(attempt_count,5))) * interval '1 second') " +
        "WHERE id=$1 AND company_id=$2 AND claim_token=$3::uuid AND status='sending' " +
        "RETURNING id",
      [
        claim.id,
        claim.companyId,
        claim.claimToken,
        status,
        status === "accepted" ? (outcome.idMessage ?? null) : null,
        status === "accepted" ? null : String(outcome.error ?? "GREEN API rejected the file").slice(0, 300),
      ]
    );
    if (!completed.rowCount) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "INSERT INTO stock_transfer_order_approval_events " +
        "(company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,details) " +
        "VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [
        claim.companyId,
        claim.batchId,
        status === "accepted" ? "delivery_accepted" : status === "failed" ? "delivery_failed" : "delivery_uncertain",
        claim.originalInstanceId,
        status === "accepted" ? (outcome.idMessage ?? null) : null,
        JSON.stringify({
          deliveryId: claim.id,
          recipientKind: claim.recipientKind,
          recipientChatId: claim.chatId,
          attempt: claim.attemptCount,
          reason: outcome.error ?? null,
        }),
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
