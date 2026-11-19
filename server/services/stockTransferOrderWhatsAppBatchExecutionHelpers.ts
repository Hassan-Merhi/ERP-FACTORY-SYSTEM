// Extracted from ./stockTransferOrderWhatsAppBatchExecution.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { StockTransferOrderApprovalError } from "./stockTransferOrderWhatsAppApprovalBatch";
import { isPhase9LanPrimary } from "../edge/phase9PosOutbox";
import { capturePhase9StockTransferRevisionReviewTx, phase9RevisionRefTx } from "../edge/phase9StockOutbox";

export type Header = {
  id: number | string;
  company_id: number;
  status: string;
  batch_key: string;
  approval_group_chat_id: string;
  authorized_phone_e164: string;
  whatsapp_instance_id: string | null;
  request_message_id: string | null;
};

export type DecisionEvent = {
  id: number | string;
  event_type: "done_received" | "decline_received";
  sender_chat_id: string | null;
  provider_message_id: string | null;
  whatsapp_instance_id: string | null;
  approval_group_chat_id: string | null;
  quoted_message_id: string | null;
};

type FinalRevision = {
  revision_id: number;
  transfer_id: number;
  status: string;
};

export type StockTransferOrderWaBatchExecution =
  | {
      outcome: "approved" | "declined";
      batchId: number;
      orderCount: number;
      revisionCount: number;
      appliedRevisions: number;
      supersededRevisions: number;
    }
  | { outcome: "skipped" | "waiting"; batchId: number; reason: string };

export async function captureLanReviewIfNeeded(
  tx: DbTransaction,
  companyId: number,
  revisionId: number,
  reviewer: string,
  decision: "approve" | "reject",
  batchKey: string
): Promise<void> {
  if (!isPhase9LanPrimary()) return;
  await capturePhase9StockTransferRevisionReviewTx(tx, {
    companyId,
    actorUserId: reviewer,
    actorUsername: reviewer,
    requestId: randomUUID(),
    businessDate: new Date().toISOString().slice(0, 10),
    revision: await phase9RevisionRefTx(tx, revisionId),
    decision,
    reason: decision === "reject" ? "Declined via WhatsApp batch " + batchKey : null,
  });
}

export async function ensureNoPendingFrozenRevisions(
  tx: DbTransaction,
  companyId: number,
  batchId: number,
  decision: "DONE" | "DECLINE",
  expectedRevisions: number[]
): Promise<{ statuses: FinalRevision[]; superseded: number; approved: number }> {
  const result = await tx.execute(sql`
    SELECT r.id AS revision_id, r.transfer_id, r.status
      FROM stock_transfer_order_approval_batch_revisions frozen
      JOIN stock_transfer_revisions r ON r.id=frozen.revision_id AND r.transfer_id=frozen.transfer_id
     WHERE frozen.company_id=${companyId} AND frozen.batch_id=${batchId}
     ORDER BY r.transfer_id, r.id
  `);
  const statuses = result.rows as FinalRevision[];
  const present = statuses.map((row) => Number(row.revision_id)).sort((a, b) => a - b);
  const expected = [...expectedRevisions].sort((a, b) => a - b);
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new StockTransferOrderApprovalError("STO_WA_REVISION_SCOPE", "The frozen revisions changed during approval.");
  }
  const permitted = decision === "DONE" ? new Set(["approved", "superseded"]) : new Set(["rejected"]);
  if (statuses.some((row) => !permitted.has(row.status))) {
    throw new StockTransferOrderApprovalError(
      "STO_WA_BATCH_STALE",
      "Some revisions were not resolved; rolling back the full batch."
    );
  }
  return {
    statuses,
    approved: statuses.filter((row) => row.status === "approved").length,
    superseded: statuses.filter((row) => row.status === "superseded").length,
  };
}

export async function markBusinessFailureStale(batchId: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const batch = await tx.execute(sql`
      SELECT company_id,status FROM stock_transfer_order_approval_batches
       WHERE id=${batchId} FOR UPDATE
    `);
    const header = batch.rows[0] as { company_id?: number; status?: string } | undefined;
    if (!header || header.status !== "requested") return;
    const companyId = Number(header.company_id);
    const prior = await tx.execute(sql`
      SELECT 1 FROM stock_transfer_order_approval_events
       WHERE company_id=${companyId} AND batch_id=${batchId}
         AND event_type IN ('done_received','decline_received') LIMIT 1
    `);
    if (!prior.rows.length) return;
    await tx.execute(sql`
      UPDATE stock_transfer_order_approval_batches
         SET status='stale',updated_at=clock_timestamp()
       WHERE company_id=${companyId} AND id=${batchId} AND status='requested'
    `);
    await tx.execute(sql`
      UPDATE stock_transfer_order_approval_batch_items
         SET reservation_active=false
       WHERE company_id=${companyId} AND batch_id=${batchId}
         AND reservation_active=true
    `);
    await tx.execute(sql`
      INSERT INTO stock_transfer_order_approval_events
        (company_id,batch_id,event_type,details)
      VALUES (${companyId},${batchId},'request_stale',
              ${JSON.stringify({ reason, phase: "approval_execution" })}::jsonb)
    `);
  });
}
