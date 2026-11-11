/** Phase 5 route/workflow safeguards; full PostgreSQL/Green API E2E in Phase 7. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stockTransferOrderWaDeliverySchema } from "../server/startup-schema/041-stock-transfer-order-wa-delivery";
const read = (name: string) => fs.readFileSync(path.join(process.cwd(),name),"utf8");

const migration = read("migrations/20261111_003_stock_transfer_order_whatsapp_excel_phase5.sql");
const snapshot = read("server/services/stockTransferOrderApprovedWorkbookSnapshot.ts");
const delivery = read("server/services/stockTransferOrderWaDeliveryWorker.ts");
const approval = read("server/services/stockTransferOrderWhatsAppBatchExecution.ts");
const approvalWorker = read("server/services/stockTransferOrderWhatsAppApprovalWorker.ts");
const server = read("server/index.ts");
const sending = read("server/services/whatsappService.ts");
const settings = read("client/src/pages/settings/StockTransferOrderApprovalSettings.tsx");
const panel = read("client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx");
const endpoints = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const manualExport = read("server/routes/stockTransferExportWhatsAppRoutes.ts");
const ensure = read("server/startup/ensureStockTransferOrderWhatsAppApprovalSchema.ts");

describe("Stock Transfer Order Phase 5 no-cost Excel delivery", () => {
  it("mirrors seven idempotent migration statements, protects workbook snapshot and binary", () => {
    expect(stockTransferOrderWaDeliverySchema).toHaveLength(7);
    for(const statement of stockTransferOrderWaDeliverySchema) expect(migration).toContain(statement);
    const ddl=stockTransferOrderWaDeliverySchema.join("; ");
    expect(ddl).toContain("stock_transfer_order_approval_workbooks");
    expect(ddl).toContain("workbook_bytes bytea");
    expect(ddl).toContain("sto_wa_workbook_immutable_trg");
    expect(ddl).toContain("FORCE ROW LEVEL SECURITY");
    expect(ensure).toContain("stockTransferOrderWaDeliverySchema");
  });

  it("freezes final approved quantities in the SAME revision approval transaction", () => {
    expect(approval).toContain("freezeApprovedStockTransferOrderWorkbookTx(");
    expect(approval).toContain("db.transaction(tx => executeWithinTransaction(tx, batchId))");
    expect(snapshot).toContain("t.workflow_origin='stock_transfer_order'");
    expect(snapshot).toContain("SUM(ti.quantity)::text AS quantity");
    expect(snapshot).toContain("GROUP BY i.id,i.name,src.id,src.name");
    expect(snapshot).toContain("snapshotSha256");
    expect(snapshot).toContain("ON CONFLICT (company_id,batch_id) DO NOTHING");
    // Source data excludes price, rate, cost and value_moved.
    expect(snapshot).not.toMatch(/(ti|i|v)\.(?:rate|cost|total_amount|price|value_moved)\b/);
  });

  it("reuses the existing manual export template without changing its content", () => {
    expect(manualExport).toContain("createNoCostExcel");
    expect(manualExport).toContain("parseItems");
    expect(approval).not.toContain("sendWhatsAppFileToChatId");
    expect(delivery).toContain("createNoCostExcel");
    expect(delivery).toContain("batchReference: snapshot.batchKey");
    expect(delivery).toContain("approvedOrders: snapshot.orderNumbers");
  });

  it("stores the actual workbook bytes once and verifies SHA-256 on every send", () => {
    expect(delivery).toContain("workbook_bytes=$3");
    expect(delivery).toContain("w.workbook_bytes IS NULL");
    expect(delivery).toContain("snapshotSha256(snapshot) !== row.snapshot_sha256");
    expect(delivery).toContain('createHash("sha256").update(bytes)');
    expect(delivery).toContain("sto-wa-db:");
  });

  it("sends only from the original main instance, never fallback or blind network retry", () => {
    const start=sending.indexOf("export async function sendApprovedStockTransferOrderWorkbook(");
    const end=sending.indexOf("/** Send a plain text message to one specific chatId */",start);
    const fn=sending.slice(start,end);
    expect(fn).toContain("settings.instanceId !== expectedInstanceId");
    expect(fn).toContain("requestGreenApiUpload(settings");
    expect(fn).not.toContain("uploadGreenApiWithAuthFallback");
    expect(fn).toContain('outcome: "uncertain"');
    expect(fn).toContain("idMessage");
    expect(delivery).toContain("originalInstanceId");
  });

  it("tracks each destination with atomic claim, expiry quarantine and no uncertain resend", () => {
    expect(delivery).toContain("claim_token=$2::uuid");
    expect(delivery).toContain("claim_expires_at=clock_timestamp()");
    expect(delivery).toContain("status='sending'");
    expect(delivery).toContain("status='uncertain'");
    expect(delivery).toContain("quarantineExpiredStockTransferOrderWaClaims");
    expect(delivery).toContain("d.status IN ('pending','failed')");
    expect(delivery).toContain("d.attempt_count < $7");
    expect(delivery).toContain("stock_transfer_order_approval_events");
    expect(delivery).toContain("finishSend(claim,outcome)");
    expect(delivery).toContain("b.status='approved'");
  });

  it("deduplicates a physically identical group and destination chat", () => {
    expect(delivery).toContain('item.recipient_kind !== "destination"');
    expect(delivery).toContain("primary.recipient_chat_id !== item.recipient_chat_id");
    expect(delivery).toContain("sameChatDeduplicated");
    expect(delivery).toContain("same_chat_primary_uncertain");
    expect(delivery).toContain("frozen_destination_mismatch");
    expect(delivery).toContain("return true; // Always wait for primary");
  });

  it("starts after approval on the authoritative scheduler and reports two distinct states", () => {
    expect(server).toContain("startStockTransferOrderWaDeliveryWorker()");
    expect(approvalWorker).toContain("queueStockTransferOrderWaDeliveries(batchId)");
    expect(delivery).toContain("shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())");
    expect(delivery).toContain('STO_WA_DELIVERY_ENABLED !== "false"');
    expect(endpoints).toContain("deliveryEnabled: stockTransferOrderWaDeliveryEnabled()");
    expect(endpoints).toContain("'recipientKind',del.recipient_kind");
    expect(settings).toContain("Final Excel delivery worker enabled");
    expect(panel).toContain("Accepted by GREEN API");
    expect(panel).toContain("Outcome unknown — verify in WhatsApp");
  });
});
