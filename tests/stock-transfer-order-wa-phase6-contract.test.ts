/** Phase 6 source contracts; live PostgreSQL/WhatsApp E2E remains Phase 7. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stockTransferOrderWaReconciliationSchema } from "../server/startup-schema/042-stock-transfer-order-wa-reconciliation";

const read=(name:string)=>fs.readFileSync(path.join(process.cwd(),name),"utf8");
const sqlMigration=read("migrations/20261111_004_stock_transfer_order_whatsapp_reconciliation_phase6.sql");
const service=read("server/services/stockTransferOrderWaDeliveryReconciliation.ts");
const policy=read("server/services/stockTransferOrderWaReconciliationPolicy.ts");
const routes=read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const worker=read("server/services/stockTransferOrderWaDeliveryWorker.ts");
const index=read("server/startup-schema/index.ts");
const ensure=read("server/startup/ensureStockTransferOrderWhatsAppApprovalSchema.ts");
const screen=read("client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx");
const review=read("client/src/pages/stock-transfer-order/StockTransferOrderWaDeliveryReconciliation.tsx");
const manifest=JSON.parse(read("config/route-manifest.json")) as {routes:string[];routeCount:number};
const schema=read("shared/schema/erp/stock-transfer-order-approvals.ts");

describe("Stock Transfer Order WhatsApp Phase 6 administrator reconciliation",()=>{
  it("adds four idempotent statements without touching transfer voucher or GL rows",()=>{
    expect(stockTransferOrderWaReconciliationSchema).toHaveLength(4);
    for(const statement of stockTransferOrderWaReconciliationSchema)expect(sqlMigration).toContain(statement);
    const sql=stockTransferOrderWaReconciliationSchema.join(";\n");
    expect(sql).toContain("manual_retry_count");
    expect(sql).toContain("delivery_manually_verified");
    expect(sql).toContain("delivery_manual_retry");
    expect(sql).toContain("sto_wa_manual_retry_count_ck");
    expect(sql).toContain("status IN ('pending','sending','accepted','failed','uncertain','verified')");
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:vouchers|stock_transfer_items|voucher_entries|inventory)\b/i);
    expect(index).toContain("...stockTransferOrderWaReconciliationSchema");
    expect(ensure).toContain("...stockTransferOrderWaReconciliationSchema");
    expect(schema).toContain('manualRetryCount: integer("manual_retry_count")');
  });

  it("restricts both endpoints to admins and active company records",()=>{
    expect(routes).toContain('app.get("/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries"');
    expect(routes).toContain('app.post("/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile"');
    expect(routes).toContain("requireAuth,admins");
    expect(routes).toContain("company_id=$1 AND id=$2");
    expect(routes).toContain("getActiveCompanyPermissionContext");
    expect(manifest.routeCount).toBe(manifest.routes.length);
    expect(manifest.routes).toContain("POST /api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile [requireAuth > <anonymous> > <anonymous>]");
  });

  it("locks the approved batch and both recipient delivery records before manual action",()=>{
    expect(service).toContain("WHERE company_id=$1 AND id=$2 FOR UPDATE");
    expect(service).toContain("ORDER BY recipient_kind FOR UPDATE");
    expect(service).toContain('header.status!=="approved"');
    expect(service).toContain('row.status!==input.expectedStatus');
    expect(service).toContain("row.provider_message_id");
    expect(service).toContain("frozenDest");
    expect(service).toContain("header.approval_group_chat_id");
    expect(service).toContain("await client.query(\\"BEGIN\\")".replaceAll("\\\\",""));
  });

  it("distinguishes manual verification from actual provider acceptance and preserves message evidence",()=>{
    expect(service).toContain("status='verified'");
    expect(service).toContain("delivery_manually_verified");
    expect(service).toContain("administratorId:actor");
    expect(service).toContain("checkedWhatsApp:true,checkedProvider:true");
    expect(service).not.toContain("provider_message_id='verified'");
    expect(policy).toContain("confirmedDelivered");
    expect(review).toContain("A verification audit was recorded");
  });

  it("caps only explicitly attested retry attempts and never blindly retries uncertain files",()=>{
    expect(policy).toContain("acknowledgeDuplicateRisk");
    expect(policy).toContain("confirmedNotDelivered");
    expect(service).toContain("Number(row.manual_retry_count)>=3");
    expect(service).toContain("manual_retry_count=manual_retry_count+1");
    expect(service).toContain("available_at=clock_timestamp()");
    expect(worker).toContain("d.status IN ('pending','failed')");
    expect(worker).toContain("quarantineExpiredStockTransferOrderWaClaims");
    expect(routes).toContain("queueStockTransferOrderWaDeliveries(batchId)");
  });

  it("prevents duplicate uploads when approval group and destination are the same chat",()=>{
    expect(service).toContain('sameChat && recipientKind==="destination"');
    expect(service).toContain('sameChat && recipientKind==="approval_group"');
    expect(service).toContain("sameChatDeduplicated:true");
    expect(worker).toContain('primary.status === "verified"');
    expect(worker).toContain("source','approval_group_manual_verification");
  });

  it("exposes two statuses, message evidence and an audit history in the existing STO screen",()=>{
    expect(screen).toContain("StockTransferOrderWaDeliveryReconciliation");
    expect(screen).toContain("reviewBatchId");
    expect(review).toContain("Provider ID:");
    expect(review).toContain("Delivery evidence history");
    expect(review).toContain("I checked GREEN API message history");
    expect(review).toContain("Authorize one retry");
    expect(review).toContain("Manual retries:");
  });

  it("does not change approval execution or stock, voucher or GL balances",()=>{
    expect(service).not.toContain("approveImmutableStockTransferRevision(");
    expect(service).not.toContain("UPDATE stock_transfer_revisions");
    expect(service).not.toContain("UPDATE stock_transfer_items");
    expect(service).not.toContain("UPDATE vouchers");
    expect(service).not.toContain("UPDATE voucher_entries");
    expect(service).not.toContain("sendApprovedStockTransferOrderWorkbook(");
  });
});
