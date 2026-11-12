import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(),name),"utf8");
const service = read("server/services/whatsappService.ts");
const route = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const parser = read("server/services/stockTransferOrderWhatsAppReplyParser.ts");
const view = read("client/src/pages/settings/StockTransferOrderApprovalSettings.tsx");
const manifest = JSON.parse(read("config/route-manifest.json")) as {routeCount:number;routes:string[]};

describe("STO WhatsApp webhook callback readiness and linked phone replies", () => {
  it("queries MAIN provider settings read-only, without POS fallback or leaking the bearer", () => {
    const start=service.indexOf("export async function getStrictGreenMainWebhookReadiness(");
    const end=service.indexOf("/** Read only chats from the exact main instance",start);
    const code=service.slice(start,end);
    expect(start).toBeGreaterThan(0);
    expect(code).toContain('fetchGreenApiReadOnly({ instanceId, apiToken }, "getSettings"');
    expect(code).toContain("authorizedStockTransferOrderWaWebhook(bearer)");
    expect(code).toContain('provider.incomingWebhook === "yes"');
    expect(code).toContain('provider.outgoingMessageWebhook === "yes"');
    expect(code).toContain("webhookEndpointMatches");
    expect(code).not.toContain("setSettings");
    expect(code).not.toContain("fetchGreenApiWithAuthFallback");
  });

  it("scopes admin diagnostics to the current company and never returns credentials or full URLs", () => {
    expect(route).toContain('app.get("/api/stock-transfer-order/wa-approval/webhook-readiness"');
    expect(route).toContain("requireAuth, admins");
    expect(route).toContain("const a = await actor(req)");
    expect(route).toContain("authorized_phone_e164 FROM stock_transfer_order_approval_settings WHERE company_id=$1");
    expect(route).toContain("selfApprovalAccount:selfApproval");
    const start=route.indexOf('app.get("/api/stock-transfer-order/wa-approval/webhook-readiness"');
    const end=route.indexOf('app.put("/api/stock-transfer-order/wa-approval/settings"',start);
    const code=route.slice(start,end);
    expect(code).not.toContain("apiToken:");
    expect(code).not.toContain("webhookUrlToken:");
    expect(code).not.toContain("mainAccountChatId:");
    expect(manifest.routeCount).toBe(manifest.routes.length);
    expect(manifest.routes).toContain(
      "GET /api/stock-transfer-order/wa-approval/webhook-readiness [requireAuth > <anonymous> > <anonymous>]"
    );
  });

  it("accepts linked-phone outgoingMessageReceived only, never outgoingAPIMessageReceived", () => {
    expect(parser).toContain('root.typeWebhook !== "incomingMessageReceived"');
    expect(parser).toContain('root.typeWebhook !== "outgoingMessageReceived"');
    expect(parser).toContain('root.typeWebhook === "outgoingMessageReceived"');
    expect(parser).toContain("instance.wid !== senderChatId");
    expect(parser).not.toContain('root.typeWebhook === "outgoingAPIMessageReceived"');
    expect(parser).toContain('const quotedMessageId = cleanId(quote)');
  });

  it("displays the relevant incoming/outgoing settings without changing provider config", () => {
    expect(view).toContain("Verify webhook");
    expect(view).toContain("selfApprovalAccount");
    expect(view).toContain("outgoingPhoneWebhookEnabled");
    expect(view).toContain("Callback bearer:");
    expect(view).toContain("preserve it through");
    expect(view).not.toContain("setSettings(");
  });
});
