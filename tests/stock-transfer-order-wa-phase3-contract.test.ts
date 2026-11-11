/**
 * Phase 3 guarantees: token-only public ingress, exact quote correlation,
 * immutable first-decision writes, and zero stock approval side effects.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const webhook = read("server/routes/stockTransferOrderWaApprovalWebhookRoutes.ts");
const parser = read("server/services/stockTransferOrderWhatsAppReplyParser.ts");
const consumer = read("server/services/stockTransferOrderWhatsAppInbound.ts");
const batch = read("server/services/stockTransferOrderWhatsAppApprovalBatch.ts");
const entry = read("server/routes.ts");
const origin = read("server/security/originGuard.ts");
const stage = read("server/startup-schema/040-stock-transfer-order-wa-webhook.ts");
const boot = read("server/startup/ensureStockTransferOrderWhatsAppApprovalSchema.ts");
const settings = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const manifest = JSON.parse(read("config/route-manifest.json")) as {
  routeCount: number; routes: string[]; middlewareMountCount: number; middlewareMounts: string[];
};

describe("Stock Transfer Order WhatsApp inbound Phase 3", () => {
  it("registers a named bearer-guarded route before all human tenant and module boundaries", () => {
    expect(entry.indexOf("registerStockTransferOrderWaApprovalWebhookRoutes(app);")).toBeLessThan(
      entry.indexOf("registerTenantIsolationBoundary(app);")
    );
    expect(webhook).toContain("authorizedStockTransferOrderWaWebhook(req.headers.authorization)");
    expect(webhook).toContain("webhookTokenIsConfigured()");
    expect(webhook).toContain("stockTransferOrderWaWebhookHandler");
    expect(origin).toContain('"/api/stock-transfer-order/wa-approval/webhook"');
    expect(manifest.routeCount).toBe(manifest.routes.length);
    expect(manifest.middlewareMountCount).toBe(manifest.middlewareMounts.length);
    expect(manifest.routes[0]).toBe(
      "POST /api/stock-transfer-order/wa-approval/webhook [stockTransferOrderWaWebhookHandler]"
    );
  });

  it("parses only GREEN API incoming exact commands directly quoting one message", () => {
    expect(parser).toContain('root.typeWebhook !== "incomingMessageReceived"');
    expect(parser).toContain('message.typeMessage === "quotedMessage"');
    expect(parser).toContain('message.typeMessage === "textMessage"');
    expect(parser).toContain('record(message.quotedMessage)?.stanzaId');
    expect(parser).toContain('textData?.stanzaId');
    expect(parser).toContain('normalized !== "DONE" && normalized !== "DECLINE"');
  });

  it("pins the instance, group, sender phone and quoted provider message ID", () => {
    expect(consumer).toContain("instance.instanceId !== reply.instanceId");
    expect(consumer).toContain("b.approval_group_chat_id=");
    expect(consumer).toContain("b.request_message_id=");
    expect(consumer).toContain("reply.senderE164 !== matched.authorized_phone_e164");
    expect(consumer).toContain("matched.current_phone !== matched.authorized_phone_e164");
    expect(consumer).toContain("matched.current_group !== matched.approval_group_chat_id");
    expect(consumer).toContain("matched.status !== \"requested\"");
    expect(consumer).toContain("runWithDatabaseMaintenanceScope");
  });

  it("revalidates the immutable batch and refuses stale requests, with no stock changes", () => {
    expect(consumer).toContain("assertStockTransferOrderApprovalBatchCurrent");
    expect(consumer).toContain("status='stale'");
    expect(consumer).toContain("reservation_active=false");
    expect(consumer).toContain("'request_stale'");
    expect(consumer).not.toContain("approveImmutableStockTransferRevision");
    expect(consumer).not.toContain("UPDATE stock_transfer_revisions");
    expect(consumer).not.toContain("UPDATE stock_transfer_items");
    expect(consumer).not.toContain("sendWhatsAppFileToChatId");
    expect(webhook).toContain("approvalExecuted: false");
  });

  it("pins the destination recipient and rejects any approval/routing edit after request creation", () => {
    expect(batch).toContain("destinationRecipientChatId");
    expect(batch).toContain("draft_created");
    expect(batch).toContain("STO_WA_DESTINATION_CHANGED");
    expect(batch).toContain("STO_WA_AUTH_CHANGED");
    expect(batch).toContain("s.unchanged");
    expect(batch).toContain("currentDestination.unchanged");
    expect(batch).toContain("clock_timestamp()");
    expect(settings).toContain("updated_at=clock_timestamp()");
  });

  it("atomically stages one and only one accepted decision per batch", () => {
    expect(stage).toContain("sto_wa_batch_decision_once_uk");
    expect(stage).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(stage).toContain("event_type IN ('done_received','decline_received')");
    expect(consumer).toContain("'done_received','decline_received'");
    expect(consumer).toContain("ON CONFLICT DO NOTHING");
    expect(consumer).toContain("FOR UPDATE OF b");
    expect(consumer).toContain("decline_received");
    expect(consumer).toContain("done_received");
    expect(boot).toContain("stockTransferOrderWaWebhookIntegrity");
  });

  it("reports staged decisions in the existing Stock Transfer Order approval area", () => {
    expect(settings).toContain("webhookConfigured: webhookTokenIsConfigured()");
    expect(settings).toContain("'done_received'");
    expect(settings).toContain("'decline_received'");
    expect(settings).toContain("if(!webhookTokenIsConfigured())");
  });
});
