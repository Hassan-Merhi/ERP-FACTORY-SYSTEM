/**
 * Stock Transfer Order WhatsApp approval — Phase 4 execution.
 *
 * Consume only an immutable, authenticated Phase 3 DONE/DECLINE event. Apply
 * EVERY frozen order's pending revisions in one DB transaction, using the
 * existing immutable stock revision lifecycle and its inventory/GL guards.
 *
 * No WhatsApp sends are performed here. Phase 5 owns delivery of the
 * consolidated cost-free Excel once the batch status is "approved".
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { logAudit } from "../routes/_helpers";
import {
  approveImmutableStockTransferRevision,
  rejectImmutableStockTransferRevision,
} from "./immutableStockTransferRevisionLifecycle";
import {
  assertStockTransferOrderApprovalBatchCurrent,
  StockTransferOrderApprovalError,
} from "./stockTransferOrderWhatsAppApprovalBatch";
import { runWithDatabaseMaintenanceScope } from "./security/databaseScopeRuntimeContext";
import { runWithAuditActor } from "./audit/auditActorContext";
import { isPhase9LanPrimary } from "../edge/phase9PosOutbox";
import {
  capturePhase9StockTransferRevisionReviewTx,
  phase9RevisionRefTx,
} from "../edge/phase9StockOutbox";

type Header = {
  id: number | string;
  company_id: number;
  status: string;
  batch_key: string;
  approval_group_chat_id: string;
  authorized_phone_e164: string;
};

type DecisionEvent = {
  id: number | string;
  event_type: "done_received" | "decline_received";
  sender_chat_id: string | null;
  provider_message_id: string | null;
};

type FrozenRevision = {
  transfer_id: number;
  revision_id: number;
  revision_number_snapshot: number;
};
type FinalRevision = {
  revision_id: number;
  transfer_id: number;
  status: string;
};

export type StockTransferOrderWaBatchExecution =
  | { outcome: "approved" | "declined"; batchId: number; orderCount: number; revisionCount: number;
      appliedRevisions: number; supersededRevisions: number }
  | { outcome: "skipped" | "waiting"; batchId: number; reason: string };

export function chooseStockTransferOrderWaApprovalLeaders(
  transferIds: readonly number[],
  revisions: readonly FrozenRevision[],
): Map<number, number> {
  const leaders = new Map<number, FrozenRevision>();
  const expected = new Set(transferIds);
  for (const revision of revisions) {
    if (!expected.has(Number(revision.transfer_id))) {
      throw new StockTransferOrderApprovalError("STO_WA_REVISION_SCOPE", "Batch revision is not part of its frozen orders.");
    }
    const transferId = Number(revision.transfer_id);
    const current = leaders.get(transferId);
    if (!current ||
        Number(revision.revision_number_snapshot) > Number(current.revision_number_snapshot) ||
        (Number(revision.revision_number_snapshot) === Number(current.revision_number_snapshot) &&
          Number(revision.revision_id) > Number(current.revision_id))) {
      leaders.set(transferId, revision);
    }
  }
  if (!transferIds.length || [...expected].some(id => !leaders.has(id))) {
    throw new StockTransferOrderApprovalError("STO_WA_REVISION_SCOPE", "Every selected order requires frozen pending revisions.");
  }
  return new Map([...leaders].map(([transferId, revision]) => [transferId, Number(revision.revision_id)]));
}

function knownBusinessConflict(error: unknown): string | null {
  const code = String((error as { code?: string })?.code ?? "");
  if ([
    "STO_WA_BATCH_STALE", "STO_WA_AUTH_CHANGED", "STO_WA_DESTINATION_CHANGED",
    "STO_WA_BATCH_INACTIVE", "STO_WA_REVISION_SCOPE",
    "STOCK_TRANSFER_REVISION_STALE", "STOCK_TRANSFER_REVISION_STATUS",
    "STOCK_TRANSFER_REVISION_SCOPE", "STOCK_TRANSFER_INSUFFICIENT_STOCK",
    "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT",
  ].includes(code)) return code;
  return null;
}

async function captureLanReviewIfNeeded(
  tx: DbTransaction,
  companyId: number,
  revisionId: number,
  reviewer: string,
  decision: "approve" | "reject",
  batchKey: string,
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

async function ensureNoPendingFrozenRevisions(
  tx: DbTransaction,
  companyId: number,
  batchId: number,
  decision: "DONE" | "DECLINE",
  expectedRevisions: number[],
): Promise<{ statuses: FinalRevision[]; superseded: number; approved: number }> {
  const result = await tx.execute(sql`
    SELECT r.id AS revision_id, r.transfer_id, r.status
      FROM stock_transfer_order_approval_batch_revisions frozen
      JOIN stock_transfer_revisions r ON r.id=frozen.revision_id AND r.transfer_id=frozen.transfer_id
     WHERE frozen.company_id=${companyId} AND frozen.batch_id=${batchId}
     ORDER BY r.transfer_id, r.id
  `);
  const statuses = result.rows as FinalRevision[];
  const present = statuses.map(row => Number(row.revision_id)).sort((a, b) => a - b);
  const expected = [...expectedRevisions].sort((a, b) => a - b);
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new StockTransferOrderApprovalError("STO_WA_REVISION_SCOPE", "The frozen revisions changed during approval.");
  }
  const permitted = decision === "DONE" ? new Set(["approved", "superseded"]) : new Set(["rejected"]);
  if (statuses.some(row => !permitted.has(row.status))) {
    throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "Some revisions were not resolved; rolling back the full batch.");
  }
  return {
    statuses,
    approved: statuses.filter(row => row.status === "approved").length,
    superseded: statuses.filter(row => row.status === "superseded").length,
  };
}

async function executeWithinTransaction(tx: DbTransaction, batchId: number): Promise<StockTransferOrderWaBatchExecution> {
  const raw = await tx.execute(sql`
    SELECT id,company_id,status,batch_key,approval_group_chat_id,authorized_phone_e164
      FROM stock_transfer_order_approval_batches
     WHERE id=${batchId}
     FOR UPDATE
  `);
  const header = raw.rows[0] as Header | undefined;
  if (!header) return { outcome: "skipped", batchId, reason: "missing_batch" };
  if (header.status !== "requested") {
    return { outcome: "skipped", batchId, reason: "batch_already_terminal" };
  }

  const companyId = Number(header.company_id);
  const decisions = await tx.execute(sql`
    SELECT id,event_type,sender_chat_id,provider_message_id
      FROM stock_transfer_order_approval_events
     WHERE company_id=${companyId} AND batch_id=${batchId}
       AND event_type IN ('done_received','decline_received')
     ORDER BY id LIMIT 2
  `);
  const rows = decisions.rows as DecisionEvent[];
  if (rows.length !== 1) return { outcome: "waiting", batchId, reason: "verified_decision_not_unique" };
  const decision = rows[0]!.event_type === "done_received" ? "DONE" : "DECLINE";
  const senderChat = rows[0]!.sender_chat_id;
  const expectedSender = header.authorized_phone_e164.slice(1) + "@c.us";
  if (senderChat !== expectedSender || !rows[0]!.provider_message_id) {
    throw new StockTransferOrderApprovalError("STO_WA_AUTH_CHANGED", "The verified decision sender no longer matches the batch.");
  }

  // Hold the parent approval batch row lock while checking every frozen order,
  // all pending revisions, and every stock movement below.
  const snapshot = await assertStockTransferOrderApprovalBatchCurrent(tx, companyId, batchId);
  const frozen = await tx.execute(sql`
    SELECT transfer_id,revision_id,revision_number_snapshot
      FROM stock_transfer_order_approval_batch_revisions
     WHERE company_id=${companyId} AND batch_id=${batchId}
     ORDER BY transfer_id,revision_number_snapshot,revision_id
  `);
  const revisions = frozen.rows as FrozenRevision[];
  const leaders = chooseStockTransferOrderWaApprovalLeaders(snapshot.transferIds, revisions);
  const reviewerId = "whatsapp:" + header.authorized_phone_e164;
  const batchKey = String(header.batch_key);

  if (decision === "DONE") {
    // The existing lifecycle approves/merges ALL pending revisions per
    // transfer. Call it once per selected order, not once per location.
    for (const transferId of snapshot.transferIds) {
      const revisionId = leaders.get(transferId)!;
      const result = await approveImmutableStockTransferRevision(
        companyId,
        revisionId,
        reviewerId,
        async (auditTx, written) => {
          await captureLanReviewIfNeeded(auditTx, companyId, revisionId, reviewerId, "approve", batchKey);
          if (written.transition !== "approved") {
            throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "The selected transfer changed before approval.");
          }
        },
        tx
      );
      if (result.transition !== "approved") {
        throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "A transfer was already approved or changed.");
      }
    }
  } else {
    // Rejection is per revision in the existing lifecycle; it must be inside
    // ONE shared transaction to ensure that every location is declined.
    const reason = "Declined via WhatsApp approval batch " + batchKey;
    for (const revision of revisions) {
      const revisionId = Number(revision.revision_id);
      const result = await rejectImmutableStockTransferRevision(
        companyId,
        revisionId,
        reviewerId,
        reason,
        async (auditTx, written) => {
          await captureLanReviewIfNeeded(auditTx, companyId, revisionId, reviewerId, "reject", batchKey);
          if (written.transition !== "rejected") {
            throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "A revision changed before rejection.");
          }
        },
        tx
      );
      if (result.transition !== "rejected") {
        throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "A revision was already rejected or changed.");
      }
    }
  }

  const summary = await ensureNoPendingFrozenRevisions(tx, companyId, batchId, decision, snapshot.revisionIds);
  // Audit EACH frozen revision, including revisions merged as superseded by
  // newer edits from the same location. All audit rows share the DB transaction.
  for (const revision of summary.statuses) {
    await logAudit({
      userId: reviewerId,
      username: "WhatsApp " + header.authorized_phone_e164,
      companyId,
      action: decision === "DONE" ? "approve" : "update",
      tableName: "stock_transfer_revisions",
      recordId: Number(revision.revision_id),
      recordIdentifier: "sto-wa:" + batchKey + ":revision:" + revision.revision_id,
      changes: {
        status: { old: "pending", new: revision.status },
        approvalMode: { new: "stock-transfer-order-whatsapp" },
        batchKey: { new: batchKey },
        transferId: { new: Number(revision.transfer_id) },
        reviewerPhone: { new: header.authorized_phone_e164 },
        providerMessageId: { new: rows[0]!.provider_message_id },
      },
    }, tx);
  }

  const newStatus = decision === "DONE" ? "approved" : "declined";
  const completed = await tx.execute(sql`
    UPDATE stock_transfer_order_approval_batches
       SET status=${newStatus},
           reviewed_at=clock_timestamp(),
           reviewed_by_phone_e164=${header.authorized_phone_e164},
           updated_at=clock_timestamp()
     WHERE company_id=${companyId} AND id=${batchId} AND status='requested'
     RETURNING id
  `);
  if (completed.rows.length !== 1) {
    throw new StockTransferOrderApprovalError("STO_WA_BATCH_STALE", "Approval batch was changed concurrently.");
  }
  await tx.execute(sql`
    UPDATE stock_transfer_order_approval_batch_items
       SET reservation_active=false
     WHERE company_id=${companyId} AND batch_id=${batchId}
       AND reservation_active=true
  `);
  const outcome = {
    orderCount: snapshot.transferIds.length,
    revisionCount: summary.statuses.length,
    appliedRevisions: summary.approved,
    supersededRevisions: summary.superseded,
  };
  await tx.execute(sql`
    INSERT INTO stock_transfer_order_approval_events
      (company_id,batch_id,event_type,details)
    VALUES (${companyId},${batchId},${newStatus},
      ${JSON.stringify({ ...outcome, decisionEventId: rows[0]!.id,
        decisionMessageId: rows[0]!.provider_message_id })}::jsonb)
  `);

  if (newStatus === "approved") {
    // Phase 5 will render and send the *same* final approved workbook to both
    // recipients. Persist both delivery intents in this approval transaction;
    // no Excel or WhatsApp operation happens until Phase 5 is installed.
    const recipientResult = await tx.execute(sql`
      SELECT details->>'destinationRecipientChatId' AS chat_id
        FROM stock_transfer_order_approval_events
       WHERE company_id=${companyId} AND batch_id=${batchId}
         AND event_type='draft_created'
       ORDER BY id LIMIT 1
    `);
    const destinationChat = (recipientResult.rows[0] as { chat_id?: string } | undefined)?.chat_id;
    if (!destinationChat) {
      throw new StockTransferOrderApprovalError("STO_WA_DESTINATION_CHANGED", "Frozen destination WhatsApp recipient missing.");
    }
    await tx.execute(sql`
      INSERT INTO stock_transfer_order_approval_deliveries
        (company_id,batch_id,recipient_kind,recipient_chat_id,status)
      VALUES
        (${companyId},${batchId},'approval_group',${header.approval_group_chat_id},'pending'),
        (${companyId},${batchId},'destination',${destinationChat},'pending')
      ON CONFLICT (company_id,batch_id,recipient_kind) DO NOTHING
    `);
  }

  return {
    outcome: newStatus,
    batchId,
    orderCount: outcome.orderCount,
    revisionCount: outcome.revisionCount,
    appliedRevisions: outcome.appliedRevisions,
    supersededRevisions: outcome.supersededRevisions,
  };
}

async function markBusinessFailureStale(batchId: number, reason: string): Promise<void> {
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

/**
 * Idempotent single-batch executor. A failed database transaction leaves
 * every stock/voucher/audit change rolled back. Known domain conflicts become
 * terminal stale; transient/unexpected failures stay requested for retry.
 */
export async function executeStockTransferOrderWaBatch(
  batchId: number
): Promise<StockTransferOrderWaBatchExecution> {
  if (!Number.isSafeInteger(batchId) || batchId <= 0) {
    return { outcome: "skipped", batchId, reason: "invalid_batch_id" };
  }
  return runWithDatabaseMaintenanceScope("verified_sto_whatsapp_batch_execution", async () =>
    runWithAuditActor({
      actorId: "system:sto-wa-batch",
      actorName: "Verified WhatsApp Stock Transfer Order batch",
      reason: "Verified DONE/DECLINE approval batch " + batchId,
      requestId: randomUUID(),
    }, async () => {
      try {
        return await db.transaction(tx => executeWithinTransaction(tx, batchId));
      } catch (error) {
        const conflict = knownBusinessConflict(error);
        if (conflict) {
          await markBusinessFailureStale(batchId, conflict);
          logger.warn("[STO WA] Full approval batch rejected; no partial stock changes", {
            batchId, reason: conflict,
          });
          return { outcome: "skipped", batchId, reason: conflict };
        }
        // Unexpected DB/network failures are not classified as stale; leave the
        // immutable decision queued for the durable worker to retry.
        throw error;
      }
    })
  );
}
