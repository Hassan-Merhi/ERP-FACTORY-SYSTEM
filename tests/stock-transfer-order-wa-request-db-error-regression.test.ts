/**
 * Regression for POST /api/stock-transfer-order/wa-approval/requests failing
 * with an opaque "Failed query:" error on a live order with two revisions.
 *
 * The route must retain tenant identity across the external GREEN API
 * requests, lock only the stock transfer header (not a posted financial
 * voucher), and expose safe staged SQLSTATE diagnostics if PostgreSQL refuses
 * a snapshot. Never change inventory or auto-approve as a fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const batch = read("server/services/stockTransferOrderWhatsAppApprovalBatch.ts");
const route = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");

describe("Stock Transfer Order WhatsApp approval request fix", () => {
  it("locks only the transfer row and keeps the company / voucher identity checks", () => {
    expect(batch).toContain("FOR UPDATE OF t");
    expect(batch).not.toContain("FOR UPDATE OF t,v");
    expect(batch).toContain("v.company_id=");
    expect(batch).toContain("v.deleted_at IS NULL");
    expect(batch).toContain("t.workflow_origin='stock_transfer_order'");
    expect(batch).toContain("t.destination_location_id=");
    expect(batch).toContain("item_hash_snapshot");
    expect(batch).toContain("payload_hash_snapshot");
  });

  it("pins the verified active-company context when freezing the batch and reading the message", () => {
    expect(route).toContain("const tenantScope = createTenantDatabaseScope(a.companyId)");
    expect(route).toContain("runWithDatabaseScopeRuntimeContext(tenantScope,");
    expect(route).toContain("() => createStockTransferOrderApprovalDraft({");
    expect(route).toContain("() => db.transaction(async(tx)=>");
    expect(route).toContain("() => makeMessage(");
    expect(route).toContain("getActiveCompanyPermissionContext(req)");
  });

  it("labels every snapshot database operation and logs safe PostgreSQL type diagnostics", () => {
    for (const step of [
      "read_approval_settings", "read_destination_recipient", "lock_and_read_eligible_orders",
      "check_active_reservations", "read_pending_revisions", "read_current_stock_transfer_lines",
      "insert_batch_header", "insert_batch_order_item", "insert_batch_revision",
      "insert_draft_audit_event", "commit_snapshot_transaction",
    ]) expect(batch).toContain("failedStep = \"" + step + "\"");
    expect(route).toContain("function stockTransferApprovalSqlFailure(error: unknown)");
    expect(route).toContain("sqlState:sqlFailure.sqlState");
    expect(route).toContain("dataType:sqlFailure.dataType");
    expect(route).toContain("routine:sqlFailure.routine");
    expect(route).toContain('sqlFailure.step ? "/" + sqlFailure.step : ""');
    expect(route).not.toContain("internalQuery:");
    expect(route).not.toContain("detail:");
    expect(route).toContain('stage="freeze_order_revision_snapshot"');
    expect(route).toContain('stage="verify_immutable_batch"');
    expect(route).toContain('stage="format_approval_message"');
    expect(route).toContain("STO_WA_APPROVAL_DB_FAILURE");
    expect(route).not.toContain("query: error.message");
  });

  it("preserves duplicate prevention, uncertain sends and human review", () => {
    expect(route).toContain('sent.outcome==="failed"');
    expect(route).toContain("sendUncertain=true");
    expect(route).toContain("await setBatchStatus(a.companyId,draft.batchId,\"requested\"");
    expect(route).not.toContain("approveImmutableStockTransferRevision(");
    expect(route).not.toContain("UPDATE stock_transfer_revisions SET status");
    expect(route).not.toContain("sendWhatsAppFileToChatId(");
  });
});
