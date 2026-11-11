import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stockTransferOrderWaApprovalFoundation } from "../server/startup-schema/039-stock-transfer-order-wa-approval";
import { stockTransferOrderWaWebhookIntegrity } from "../server/startup-schema/040-stock-transfer-order-wa-webhook";

const root = process.cwd();
const file = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
const sqlMigration = file("migrations/20261111_001_stock_transfer_order_whatsapp_approval_phase1.sql");
const startupSql = stockTransferOrderWaApprovalFoundation.join(";\n");

describe("Stock Transfer Order WhatsApp approval — Phase 1 contract", () => {
  it("mirrors every startup statement in the additive SQL migration", () => {
    expect(stockTransferOrderWaApprovalFoundation).toHaveLength(44);
    for (const statement of stockTransferOrderWaApprovalFoundation) {
      expect(sqlMigration).toContain(statement);
    }
  });

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
      expect(startupSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(startupSql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(startupSql).toContain(`CREATE POLICY sto_wa_company_scope ON ${table}`);
    }
    expect(startupSql).toContain("workflow_origin text NOT NULL DEFAULT 'stock_transfer'");
    expect(startupSql).toContain("sto_wa_active_transfer_uk");
    expect(startupSql).toContain("sto_wa_batch_message_uk");
    expect(startupSql).toContain("sto_wa_events_immutable_trg");
    expect(startupSql).toContain("sto_wa_revisions_immutable_trg");
    expect(startupSql).toContain("sto_wa_batch_items_guard_trg");
    expect(startupSql).not.toMatch(/\b(?:UPDATE|DELETE FROM|TRUNCATE)\s+(?:vouchers|stock_transfer_items|stock_transfer_revisions|inventory)\b/i);
    expect(startupSql).not.toMatch(/\b(?:INSERT INTO|DELETE FROM)\s+voucher_entries\b/i);
  });

  it("tags only explicitly order-created documents on the new-order screen", () => {
    const ui = file("client/src/pages/stock-transfer-order/useStockTransferOrderModel.tsx");
    const route = file("server/routes/fiscal-transfers/create.ts");
    const service = file("server/services/inventory/createStockTransfer.ts");
    expect(ui).toContain('apiRequest("POST", "/api/stock-transfer-orders"');
    expect(route).toContain('req.path === "/api/stock-transfer-orders"');
    expect(route).toContain('req.body?.workflowOrigin !== undefined');
    expect(route).toContain('workflowOrigin,');
    expect(service).toContain('workflowOrigin === "stock_transfer_order" ? "stock_transfer_order" : "stock_transfer"');
  });

  it("builds isolated frozen snapshots rather than approving or sending from Phase 1", () => {
    const batchService = file("server/services/stockTransferOrderWhatsAppApprovalBatch.ts");
    expect(batchService).toContain('t.workflow_origin=\'stock_transfer_order\'');
    expect(batchService).toContain("v.company_id=");
    expect(batchService).toContain("r.status='pending'");
    expect(batchService).toContain("FOR UPDATE OF t,v");
    expect(batchService).toContain("item_hash_snapshot");
    expect(batchService).toContain("payload_hash_snapshot");
    expect(batchService).toContain("STO_WA_BATCH_STALE");
    expect(batchService).not.toContain("approveImmutableStockTransferRevision");
    expect(batchService).not.toContain("sendWhatsAppFileToChatId");
  });

  it("pins the Phase 3 webhook-decision constraint without rewriting accounting rows", () => {
    expect(stockTransferOrderWaWebhookIntegrity).toHaveLength(1);
    expect(stockTransferOrderWaWebhookIntegrity[0]).toContain("sto_wa_batch_decision_once_uk");
    expect(stockTransferOrderWaWebhookIntegrity[0]).not.toMatch(/\\bUPDATE\\s+vouchers\\b/i);
  });

  it("ensures the additive foundation even when bulk startup migrations are disabled", () => {
    const boot = file("server/index.ts");
    const ensure = file("server/startup/ensureStockTransferOrderWhatsAppApprovalSchema.ts");
    expect(boot).toContain("await ensureStockTransferOrderWhatsAppApprovalSchema(pool);");
    expect(ensure).toContain("...stockTransferOrderWaApprovalFoundation, ...stockTransferOrderWaWebhookIntegrity");
  });
});
