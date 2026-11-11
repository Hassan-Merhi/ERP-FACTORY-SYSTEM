/**
 * Phase 3: authenticated inbound GREEN API group reply intake.
 *
 * Captures the first verified DONE/DECLINE as an immutable event. It never
 * approves a stock transfer, changes a voucher or sends an Excel workbook.
 * Phase 4 will consume accepted decision events inside its approval transaction.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";
import { getWaSettings } from "./whatsappService";
import {
  assertStockTransferOrderApprovalBatchCurrent,
  StockTransferOrderApprovalError,
} from "./stockTransferOrderWhatsAppApprovalBatch";
import {
  type StockTransferOrderWaReply,
} from "./stockTransferOrderWhatsAppReplyParser";
import { runWithDatabaseMaintenanceScope } from "./security/databaseScopeRuntimeContext";

export type StockTransferOrderWaInboundResult =
  | { outcome: "accepted"; batchId: number; command: "DONE" | "DECLINE" }
  | { outcome: "duplicate" | "ignored" | "stale"; reason: string };

type MatchedBatch = {
  id: number | string;
  company_id: number;
  status: string;
  authorized_phone_e164: string;
  approval_group_chat_id: string;
  current_enabled: boolean;
  current_phone: string | null;
  current_group: string | null;
};

export async function recordStockTransferOrderWaReply(
  reply: StockTransferOrderWaReply
): Promise<StockTransferOrderWaInboundResult> {
  // Authenticated webhook route calls this with a server-trusted event; no
  // companyId may be accepted from provider payloads or user-controlled URLs.
  return runWithDatabaseMaintenanceScope("verified_sto_green_api_webhook", async () => {
    const instance = await getWaSettings();
    if (!instance?.enabled || !instance.instanceId ||
        instance.instanceId !== reply.instanceId) {
      return { outcome: "ignored", reason: "instance_mismatch" };
    }

    return db.transaction(async (tx): Promise<StockTransferOrderWaInboundResult> => {
      const candidates = await tx.execute(sql`
        SELECT b.id,b.company_id,b.status,b.authorized_phone_e164,
               b.approval_group_chat_id,
               s.enabled AS current_enabled,
               s.authorized_phone_e164 AS current_phone,
               s.approval_group_chat_id AS current_group
          FROM stock_transfer_order_approval_batches b
          JOIN stock_transfer_order_approval_settings s ON s.company_id=b.company_id
         WHERE b.whatsapp_instance_id=${reply.instanceId}
           AND b.approval_group_chat_id=${reply.chatId}
           AND b.request_message_id=${reply.quotedMessageId}
         FOR UPDATE OF b
      `);
      const matched = candidates.rows[0] as MatchedBatch | undefined;
      if (!matched) return { outcome: "ignored", reason: "unmatched_quote" };
      const companyId = Number(matched.company_id);
      const batchId = Number(matched.id);
      if (matched.status !== "requested") {
        return { outcome: "ignored", reason: "inactive_batch" };
      }

      if (reply.senderE164 !== matched.authorized_phone_e164 ||
          !matched.current_enabled ||
          matched.current_phone !== matched.authorized_phone_e164 ||
          matched.current_group !== matched.approval_group_chat_id) {
        // Store only the minimum audit evidence; never store arbitrary chat text.
        await tx.execute(sql`
          INSERT INTO stock_transfer_order_approval_events
            (company_id,batch_id,event_type,whatsapp_instance_id,
             provider_message_id,sender_chat_id,approval_group_chat_id,details)
          VALUES (${companyId},${batchId},'ignored',${reply.instanceId},
                  ${reply.incomingMessageId},${reply.senderChatId},${reply.chatId},
                  ${JSON.stringify({ reason: "unauthorized_sender_or_config_changed" })}::jsonb)
          ON CONFLICT DO NOTHING
        `);
        return { outcome: "ignored", reason: "not_authorized" };
      }

      // The unique partial index makes DONE and DECLINE mutually exclusive
      // for this batch, across simultaneous webhooks and across Render workers.
      const prior = await tx.execute(sql`
        SELECT id,event_type,provider_message_id
          FROM stock_transfer_order_approval_events
         WHERE company_id=${companyId}
           AND batch_id=${batchId}
           AND event_type IN ('done_received','decline_received')
         ORDER BY id
         LIMIT 1
      `);
      if (prior.rows.length) return { outcome: "duplicate", reason: "decision_already_received" };

      try {
        // Re-evaluate frozen order quantities and every pending revision
        // BEFORE accepting a message. Prevents approving unseen changes.
        await assertStockTransferOrderApprovalBatchCurrent(tx, companyId, batchId);
      } catch (error) {
        if (!(error instanceof StockTransferOrderApprovalError)) throw error;
        const changed = await tx.execute(sql`
          UPDATE stock_transfer_order_approval_batches
             SET status='stale',updated_at=now()
           WHERE company_id=${companyId} AND id=${batchId} AND status='requested'
           RETURNING id
        `);
        if (changed.rows.length) {
          await tx.execute(sql`
            UPDATE stock_transfer_order_approval_batch_items
               SET reservation_active=false
             WHERE company_id=${companyId} AND batch_id=${batchId}
          `);
          await tx.execute(sql`
            INSERT INTO stock_transfer_order_approval_events
              (company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,
               sender_chat_id,approval_group_chat_id,details)
            VALUES (${companyId},${batchId},'request_stale',${reply.instanceId},
                    ${reply.incomingMessageId},${reply.senderChatId},${reply.chatId},
                    ${JSON.stringify({ reason: error.code })}::jsonb)
            ON CONFLICT DO NOTHING
          `);
        }
        return { outcome: "stale", reason: "approval_request_outdated" };
      }

      const type = reply.command === "DONE" ? "done_received" : "decline_received";
      const saved = await tx.execute(sql`
        INSERT INTO stock_transfer_order_approval_events
          (company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,
           sender_chat_id,approval_group_chat_id,details)
        VALUES (${companyId},${batchId},${type},${reply.instanceId},
                ${reply.incomingMessageId},${reply.senderChatId},${reply.chatId},
                ${JSON.stringify({ command: reply.command,
                  quotedMessageId: reply.quotedMessageId, providerTimestamp: reply.timestamp })}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      if (!saved.rows.length) return { outcome: "duplicate", reason: "decision_already_received" };
      logger.info("[STO WA] Verified WhatsApp decision staged for Phase 4", {
        companyId, batchId, command: reply.command,
      });
      return { outcome: "accepted", batchId, command: reply.command };
    });
  });
}
