/**
 * Phase 6: auditable, administrator-only reconciliation of Stock Transfer Order
 * WhatsApp Excel deliveries. No voucher, stock, journal or approval mutations.
 *
 * A timed-out upload may have reached WhatsApp; manual retry requires explicit
 * administrator review of BOTH the chat and provider history. Concurrency is
 * controlled by PostgreSQL locks, not browser state.
 */
import { pool } from "../db";
import { logger } from "../lib/logger";

import {
  parseStockTransferOrderDeliveryReconciliation,
  type DeliveryRecipientKind,
  StockTransferOrderDeliveryReconciliationError,
} from "./stockTransferOrderWaReconciliationPolicy";
export { StockTransferOrderDeliveryReconciliationError } from "./stockTransferOrderWaReconciliationPolicy";
const reject=(status:number,message:string):never=>{
  throw new StockTransferOrderDeliveryReconciliationError(status,message);
};

export async function reconcileStockTransferOrderWaDelivery(params: {
  companyId: number;
  batchId: number;
  recipientKind: DeliveryRecipientKind;
  actorId: string;
  payload: unknown;
}): Promise<{ ok: true; status: string; recipientKind: DeliveryRecipientKind; batchId: number;
              sameChatReconciled: boolean; manualRetryCount: number }> {
  const { companyId,batchId,recipientKind,actorId } = params;
  if (!Number.isSafeInteger(companyId)||companyId<1||
      !Number.isSafeInteger(batchId)||batchId<1||
      !["approval_group","destination"].includes(recipientKind)||
      !actorId || actorId.length>255) {
    return reject(400,"Invalid company, approval batch, recipient or administrator.");
  }
  const input = parseStockTransferOrderDeliveryReconciliation(params.payload);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch=await client.query<{
      id:string|number;status:string;approval_group_chat_id:string;whatsapp_instance_id:string|null;
    }>(
      "SELECT id,status,approval_group_chat_id,whatsapp_instance_id " +
      "FROM stock_transfer_order_approval_batches WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [companyId,batchId]
    );
    const header=batch.rows[0];
    if (!header) return reject(404,"This Stock Transfer Order approval batch was not found.");
    if(header.status!=="approved")return reject(409,"Only fully approved Stock Transfer Order batches can reconcile Excel delivery.");

    // Lock both records in a stable order, protecting against concurrent
    // administration and avoiding two overlapping actions on the same batch.
    const records=await client.query<{
      id:number|string;recipient_kind:DeliveryRecipientKind;
      recipient_chat_id:string;status:string;attempt_count:number;
      manual_retry_count:number;provider_message_id:string|null;
    }>(
      "SELECT id,recipient_kind,recipient_chat_id,status,attempt_count,manual_retry_count,provider_message_id " +
      "FROM stock_transfer_order_approval_deliveries " +
      "WHERE company_id=$1 AND batch_id=$2 ORDER BY recipient_kind FOR UPDATE",
      [companyId,batchId]
    );
    const row=records.rows.find(x=>x.recipient_kind===recipientKind);
    const primary=records.rows.find(x=>x.recipient_kind==="approval_group");
    const other=records.rows.find(x=>x.recipient_kind==="destination");
    if(!row||!primary||!other)return reject(409,"Both frozen WhatsApp delivery records must exist.");
    const sameChat=primary.recipient_chat_id===other.recipient_chat_id;
    if(sameChat && recipientKind==="destination"){
      return reject(409,"These recipients are the same chat. Reconcile the approval-group record only.");
    }
    if (row.status!==input.expectedStatus) {
      return reject(409,"Delivery status changed. Refresh and review the latest outcome before proceeding.");
    }
    if (row.provider_message_id) {
      return reject(409,"GREEN API already returned a message ID. Do not retry or override this file.");
    }
    if (sameChat && other.status==="sending"){
      return reject(409,"A same-chat delivery is being processed; retry after its outcome is known.");
    }
    if(input.action==="authorize_retry" && Number(row.manual_retry_count)>=3){
      return reject(409,"Manual retry authorization limit reached. This delivery needs engineering review.");
    }
    const original = await client.query<{chat_id:string|null}>(
      "SELECT details->>'destinationRecipientChatId' AS chat_id " +
      "FROM stock_transfer_order_approval_events " +
      "WHERE company_id=$1 AND batch_id=$2 AND event_type='draft_created' ORDER BY id LIMIT 1",
      [companyId,batchId]
    );
    const frozenDest=original.rows[0]?.chat_id;
    if(!frozenDest || other.recipient_chat_id!==frozenDest ||
       primary.recipient_chat_id!==header.approval_group_chat_id ||
       !header.whatsapp_instance_id) {
      return reject(409,"Original approval recipient or WhatsApp instance differs from the frozen batch; manual reconciliation refused.");
    }

    const actor=String(actorId);
    const detail = {
      action:input.action,recipientKind,recipientChatId:row.recipient_chat_id,
      deliveryId:Number(row.id),priorStatus:row.status,reason:input.reason,
      administratorId:actor,checkedWhatsApp:true,checkedProvider:true,
      confirmedDelivered:input.confirmedDelivered,
      confirmedNotDelivered:input.confirmedNotDelivered,
      acknowledgeDuplicateRisk:input.acknowledgeDuplicateRisk,
      sameChat,
    };
    const next=input.action==="verify_delivered"?"verified":"pending";
    const updated=await client.query<{manual_retry_count:number}>(
      input.action==="verify_delivered"
        ? "UPDATE stock_transfer_order_approval_deliveries SET status='verified'," +
          "claim_token=NULL,claim_expires_at=NULL,last_error=NULL," +
          "updated_at=clock_timestamp() " +
          "WHERE company_id=$1 AND batch_id=$2 AND recipient_kind=$3 AND status=$4 " +
          "RETURNING manual_retry_count"
        : "UPDATE stock_transfer_order_approval_deliveries SET status='pending'," +
          "attempt_count=0,manual_retry_count=manual_retry_count+1," +
          "available_at=clock_timestamp(),claim_token=NULL,claim_expires_at=NULL," +
          "last_error=NULL,updated_at=clock_timestamp() " +
          "WHERE company_id=$1 AND batch_id=$2 AND recipient_kind=$3 AND status=$4 " +
          "AND manual_retry_count < 3 RETURNING manual_retry_count",
      [companyId,batchId,recipientKind,row.status]
    );
    if(updated.rowCount!==1)return reject(409,"Delivery was reconciled concurrently. Refresh the status.");

    await client.query(
      "INSERT INTO stock_transfer_order_approval_events" +
      "(company_id,batch_id,event_type,whatsapp_instance_id,details) " +
      "VALUES($1,$2,$3,$4,$5::jsonb)",
      [companyId,batchId,next==="verified"?"delivery_manually_verified":"delivery_manual_retry",
       header.whatsapp_instance_id,JSON.stringify(detail)]
    );

    // A destination and group may point to one physical WhatsApp chat. Do
    // not enqueue a duplicate file or show conflicting delivery conclusions.
    if(sameChat && recipientKind==="approval_group" &&
       ["pending","failed","uncertain"].includes(other.status)) {
      const alias = await client.query(
        next==="verified"
          ? "UPDATE stock_transfer_order_approval_deliveries " +
            "SET status='verified',claim_token=NULL,claim_expires_at=NULL,last_error=NULL," +
            "updated_at=clock_timestamp() " +
            "WHERE company_id=$1 AND batch_id=$2 AND recipient_kind='destination' " +
            "AND status IN ('pending','failed','uncertain') RETURNING id"
          : "UPDATE stock_transfer_order_approval_deliveries " +
            "SET status='pending',attempt_count=0,available_at=clock_timestamp()," +
            "claim_token=NULL,claim_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() " +
            "WHERE company_id=$1 AND batch_id=$2 AND recipient_kind='destination' " +
            "AND status IN ('pending','failed','uncertain') RETURNING id",
        [companyId,batchId]
      );
      if (alias.rowCount) {
        await client.query(
          "INSERT INTO stock_transfer_order_approval_events" +
          "(company_id,batch_id,event_type,whatsapp_instance_id,details) " +
          "VALUES($1,$2,$3,$4,$5::jsonb)",
          [companyId,batchId,next==="verified"?"delivery_manually_verified":"delivery_manual_retry",
           header.whatsapp_instance_id,JSON.stringify({
             ...detail,recipientKind:"destination",
             deliveryId:Number(other.id),sameChatDeduplicated:true,
           })]
        );
      }
    }
    await client.query("COMMIT");
    logger.info("[STO WA] Administrator reconciled cost-free Excel delivery",{
      batchId,companyId,actorId:actor,recipientKind,action:input.action,
      sameChatReconciled:sameChat,
    });
    return {ok:true,status:next,recipientKind,batchId,
      sameChatReconciled:sameChat,manualRetryCount:Number(updated.rows[0]!.manual_retry_count)};
  } catch(error){
    try{await client.query("ROLLBACK");}catch{ /* connection already closed */ }
    throw error;
  }finally{client.release();}
}
