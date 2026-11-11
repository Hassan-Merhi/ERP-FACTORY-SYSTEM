/**
 * Phase 4 source contracts. Unit scenarios for the deterministic order
 * selection policy are in stock-transfer-order-wa-phase4-policy.test.ts.
 * The database-backed approval transaction is integration-tested in Phase 7.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), "utf8");
const executor = read("server/services/stockTransferOrderWhatsAppBatchExecution.ts");
const worker = read("server/services/stockTransferOrderWhatsAppApprovalWorker.ts");
const webhook = read("server/routes/stockTransferOrderWaApprovalWebhookRoutes.ts");
const index = read("server/index.ts");
const route = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const view = read("client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx");

describe("Stock Transfer Order WhatsApp Phase 4 atomic full-batch execution", () => {
  it("consumes only the authenticated Phase 3 decision for an active frozen batch", () => {
    expect(executor).toContain("event_type IN ('done_received','decline_received')");
    expect(executor).toContain('header.status !== "requested"');
    expect(executor).toContain("senderChat !== expectedSender");
    expect(executor).toContain("rows[0]!.whatsapp_instance_id !== header.whatsapp_instance_id");
    expect(executor).toContain("rows[0]!.approval_group_chat_id !== header.approval_group_chat_id");
    expect(executor).toContain("rows[0]!.quoted_message_id !== header.request_message_id");
    expect(executor).toContain("assertStockTransferOrderApprovalBatchCurrent");
    expect(executor).toContain("chooseStockTransferOrderWaApprovalLeaders");
    expect(executor).toContain("FOR UPDATE");
    expect(executor).toContain("runWithDatabaseMaintenanceScope");
  });

  it("uses existing immutable stock-transfer lifecycle once per transfer, rejecting all revisions together", () => {
    expect(executor).toContain("approveImmutableStockTransferRevision(");
    expect(executor).toContain("rejectImmutableStockTransferRevision(");
    expect(executor).toContain("for (const transferId of snapshot.transferIds)");
    expect(executor).toContain("for (const revision of revisions)");
    expect(executor).toContain("await db.transaction(tx => executeWithinTransaction(tx, batchId))");
    expect(executor).toContain("ensureNoPendingFrozenRevisions");
    expect(executor).toContain('new Set(["approved", "superseded"])');
    expect(executor).toContain('new Set(["rejected"])');
    expect(executor).toContain("STO_WA_BATCH_STALE");
  });

  it("writes one audit entry for every frozen revision in the same database transaction", () => {
    expect(executor).toContain("for (const revision of summary.statuses)");
    expect(executor).toContain("writeAuditEvent({");
    expect(executor).toContain("approvalMode:");
    expect(executor).toContain("reviewerPhone:");
    expect(executor).toContain("providerMessageId:");
    expect(executor).toContain("captureLanReviewIfNeeded");
    expect(executor).toContain("reviewed_by_phone_e164=");
    expect(executor).toContain("reservation_active=false");
  });

  it("creates exactly two pending delivery intents on approval and never sends WhatsApp directly", () => {
    expect(executor).toContain("'approval_group'");
    expect(executor).toContain("'destination'");
    expect(executor).toContain("stock_transfer_order_approval_deliveries");
    expect(executor).toContain("ON CONFLICT (company_id,batch_id,recipient_kind) DO NOTHING");
    expect(executor).toContain("draft_created");
    expect(executor).not.toContain("sendWhatsAppFileToChatId(");
    expect(executor).not.toContain("createNoCostExcel(");
  });

  it("marks known business conflicts stale after rollback while retrying transient database errors", () => {
    expect(executor).toContain("await markBusinessFailureStale(batchId, conflict)");
    expect(executor).toContain("status='stale'");
    expect(executor).toContain("'request_stale'");
    expect(executor).toContain("throw error;");
  });

  it("registers a durable, idempotent worker that replays verified decisions after restart", () => {
    expect(index).toContain("startStockTransferOrderWaApprovalWorker()");
    expect(webhook).toContain("queueStockTransferOrderWaDecision(result.batchId)");
    expect(worker).toContain("setInterval(");
    expect(worker).toContain("sweepStockTransferOrderWaDecisions()");
    expect(worker).toContain("stock_transfer_order_approval_events e");
    expect(worker).toContain("b.status='requested'");
    expect(worker).toContain("stockTransferOrderWaExecutionEnabled()");
    expect(worker).toContain("shouldStartEdgeBackgroundJobs");
    expect(worker).toContain('STO_WA_PRODUCTION_ACTIVATED === "true"');
  });

  it("exposes reviewer and batch status while forbidding cancellation after DONE/DECLINE", () => {
    expect(route).toContain('b.reviewed_by_phone_e164 AS "reviewedByPhone"');
    expect(route).toContain('b.reviewed_at AS "reviewedAt"');
    expect(route).toContain("NOT EXISTS (SELECT 1 FROM stock_transfer_order_approval_events ev");
    expect(route).toContain("ev.event_type IN ('done_received','decline_received')");
    expect(view).toContain("batch.reviewedByPhone");
    expect(view).toContain('["draft", "uncertain", "requested", "stale"]');
  });
});
