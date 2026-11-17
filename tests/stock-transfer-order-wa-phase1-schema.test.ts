import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  columnDefinition,
  hasPolicy,
  hasTable,
  indexDefinition,
  tableRowLevelSecurity,
  triggerDefinition,
} from "./helpers/schemaManifest";

// The approval foundation used to be applied at boot (startup-schema/039 and 040
// via ensureStockTransferOrderWhatsAppApprovalSchema) and mirrored in an SQL file.
// Migrations now define it; the archived SQL is kept as history.
const root = process.cwd();
const file = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
const archivedSql = file("migrations/archive/legacy/20261111_001_stock_transfer_order_whatsapp_approval_phase1.sql");

describe("Stock Transfer Order WhatsApp approval — Phase 1 contract", () => {
  it("isolates new approval tables and never changes existing stock movements", () => {
    const tables = [
      "stock_transfer_order_approval_settings",
      "stock_transfer_order_destination_recipients",
      "stock_transfer_order_approval_batches",
      "stock_transfer_order_approval_batch_items",
      "stock_transfer_order_approval_batch_revisions",
      "stock_transfer_order_approval_events",
      "stock_transfer_order_approval_deliveries",
    ];
    for (const table of tables) {
      expect(hasTable(table), table).toBe(true);
      expect(tableRowLevelSecurity(table), table).toEqual({ rls: true, forceRls: true });
      expect(hasPolicy(table, "sto_wa_company_scope"), table).toBe(true);
    }
    expect(columnDefinition("stock_transfer_vouchers", "workflow_origin")).toMatchObject({
      type: "text",
      notNull: true,
      default: "'stock_transfer'::text",
    });
    expect(indexDefinition("sto_wa_active_transfer_uk")).toBeDefined();
    expect(indexDefinition("sto_wa_batch_message_uk")).toBeDefined();
    expect(triggerDefinition("stock_transfer_order_approval_events", "sto_wa_events_immutable_trg")).toBeDefined();
    expect(
      triggerDefinition("stock_transfer_order_approval_batch_revisions", "sto_wa_revisions_immutable_trg")
    ).toBeDefined();
    expect(
      triggerDefinition("stock_transfer_order_approval_batch_items", "sto_wa_batch_items_guard_trg")
    ).toBeDefined();
    expect(archivedSql).not.toMatch(
      /\b(?:UPDATE|DELETE FROM|TRUNCATE)\s+(?:vouchers|stock_transfer_items|stock_transfer_revisions|inventory)\b/i
    );
    expect(archivedSql).not.toMatch(/\b(?:INSERT INTO|DELETE FROM)\s+voucher_entries\b/i);
  });

  it("tags only explicitly order-created documents on the new-order screen", () => {
    const ui = file("client/src/pages/stock-transfer-order/useStockTransferOrderModel.tsx");
    const route = file("server/routes/fiscal-transfers/create.ts");
    const service = file("server/services/inventory/createStockTransfer.ts");
    expect(ui).toContain('apiRequest("POST", "/api/stock-transfer-orders"');
    expect(route).toContain('req.path === "/api/stock-transfer-orders"');
    expect(route).toContain("req.body?.workflowOrigin !== undefined");
    expect(route).toContain("workflowOrigin,");
    expect(service).toContain('workflowOrigin === "stock_transfer_order" ? "stock_transfer_order" : "stock_transfer"');
  });

  it("builds isolated frozen snapshots rather than approving or sending from Phase 1", () => {
    const batchService = file("server/services/stockTransferOrderWhatsAppApprovalBatch.ts");
    expect(batchService).toContain("t.workflow_origin='stock_transfer_order'");
    expect(batchService).toContain("v.company_id=");
    expect(batchService).toContain("r.status='pending'");
    // Only the stock transfer row is locked. Locking posted vouchers needlessly
    // crosses financial row-update policies during a read-only approval request.
    expect(batchService).toContain("FOR UPDATE OF t");
    expect(batchService).not.toContain("FOR UPDATE OF t,v");
    expect(batchService).toContain("item_hash_snapshot");
    expect(batchService).toContain("payload_hash_snapshot");
    expect(batchService).toContain("STO_WA_BATCH_STALE");
    expect(batchService).not.toContain("approveImmutableStockTransferRevision");
    expect(batchService).not.toContain("sendWhatsAppFileToChatId");
  });

  it("pins the Phase 3 webhook-decision constraint", () => {
    expect(indexDefinition("sto_wa_batch_decision_once_uk")).toContain(
      "CREATE UNIQUE INDEX sto_wa_batch_decision_once_uk ON public.stock_transfer_order_approval_events USING btree (company_id, batch_id)"
    );
  });
});
