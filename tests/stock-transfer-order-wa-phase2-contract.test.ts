/**
 * Phase 2 source contracts: approval requests are explicit and do not execute
 * inventory approval. Database/webhook end-to-end tests are left to Phase 7.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";
// Whitespace-insensitive source matching: Prettier formats the split route modules.
const compact = (text: string) => text.replace(/\s+/g, "");

const read = (p: string) => readModuleFamily(path.join(process.cwd(), p));
const server = compact(read("server/routes/stockTransferOrderWaApprovalRoutes.ts"));
const messageSender = read("server/services/whatsappService.ts");
const registration = read("server/routes/stockTransferExportWhatsAppRoutes.ts");
const dialog = read("client/src/pages/stock-transfer-order/SendStockTransferWhatsAppDialog.tsx");
const requestPanel = read("client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx");
const settings = read("client/src/pages/settings/StockTransferOrderApprovalSettings.tsx");
const transferCreate = read("server/routes/fiscal-transfers/create.ts");
const accessManifest = read("config/route-access-manifest.json");
const routeManifest = JSON.parse(read("config/route-manifest.json")) as {
  routeCount: number;
  middlewareMountCount: number;
  routes: string[];
  middlewareMounts: string[];
};

describe("Stock Transfer Order WhatsApp approval Phase 2", () => {
  it("appears only within the existing Stock Transfer Order WhatsApp UI", () => {
    expect(dialog).toContain("StockTransferOrderApprovalRequestPanel");
    expect(dialog).toContain("sto-wa-tab-request-approval");
    expect(dialog).toContain('mode === "approval"');
    expect(dialog).toContain("transfer-wa-send-selected");
    expect(requestPanel).toContain("Select all eligible");
    expect(requestPanel).toContain("sto-wa-send-approval-request");
    expect(requestPanel).toContain("pendingRevisions");
    expect(settings).toContain("authorizedPhoneE164");
    expect(settings).toContain("Destination WhatsApp recipients");
    expect(registration).toContain("registerStockTransferOrderWaApprovalRoutes(app);");
  });

  it("preserves the ordinary stock-transfer create path and marks only the order route", () => {
    expect(transferCreate).toContain('"/api/stock-transfers", "/api/stock-transfer-orders"');
    expect(transferCreate).toContain('req.path === "/api/stock-transfer-orders"');
    expect(transferCreate).toContain("req.body?.workflowOrigin !== undefined");
    expect(transferCreate).toContain("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
    // The inventory module permission is declared on every route of both surfaces.
    const moduleRules = accessManifest
      .split("\n")
      .filter((line) => /"id":"[A-Z]+ \/api\/stock-transfer-(orders|order\/wa-approval)[/#]/.test(line))
      .filter((line) => !line.includes("/wa-approval/webhook#"));
    expect(moduleRules.length).toBeGreaterThan(1);
    for (const rule of moduleRules) expect(rule).toContain('"mod_inventory"');
  });

  it("filters only saved, own-company, destination-matched orders", () => {
    expect(server).toContain(compact("t.workflow_origin='stock_transfer_order'"));
    expect(server).toContain(compact("v.company_id=$1 AND t.destination_location_id=$2"));
    expect(server).toContain(compact("createStockTransferOrderApprovalDraft"));
    expect(server).toContain(compact("assertStockTransferOrderApprovalBatchCurrent"));
    expect(server).toContain(compact("getActiveCompanyPermissionContext"));
    expect(server).toContain(compact("requireRole"));
  });

  it("requires explicit admin acknowledgment to enroll historical orders", () => {
    expect(server).toContain(compact("/wa-approval/enroll-legacy"));
    expect(server).toContain(compact("req.body?.acknowledge!==true"));
    expect(server).toContain(compact("v.description LIKE 'Stock Transfer Order - %'"));
    expect(server).toContain(compact("workflow_origin='stock_transfer_order'"));
    expect(requestPanel).toContain("Enable");
  });

  it("sends from the exact configured WhatsApp instance and saves the returned message ID", () => {
    const sender = messageSender.slice(
      messageSender.indexOf("export async function sendStockTransferOrderApprovalRequest")
    );
    expect(sender).toContain('"sendMessage"');
    expect(sender).toContain("idMessage");
    expect(sender).toContain('outcome: "uncertain"');
    expect(sender.split("/** Send a plain text message to one specific chatId */")[0]).not.toContain(
      "fetchGreenApiWithAuthFallback"
    );
    expect(server).toContain(compact("sent.idMessage"));
    expect(server).toContain(compact("request_sent"));
  });

  it("holds uncertain sends and never approves revisions during Phase 2", () => {
    expect(server).toContain(compact('sent.outcome==="failed"'));
    expect(server).toContain(compact('reason:"request_send_uncertain"'));
    // The operator guidance for an uncertain send: never resend the same batch.
    expect(read("server/routes/stockTransferOrderWaApprovalRoutes.ts")).toMatch(/do not send this batch again/i);
    expect(server).not.toContain(compact("approveImmutableStockTransferRevision"));
    expect(server).not.toContain(compact("sendWhatsAppFileToChatId"));
    expect(server).not.toContain(compact("UPDATE stock_transfer_revisions SET status"));
  });

  it("pins the new route and permission boundaries in the reviewed manifest", () => {
    expect(routeManifest.routeCount).toBe(routeManifest.routes.length);
    expect(routeManifest.middlewareMountCount).toBe(routeManifest.middlewareMounts.length);
    expect(routeManifest.routes).toContain(
      "POST /api/stock-transfer-orders [requireAuth > validateRequest > <anonymous>]"
    );
    expect(routeManifest.routes).toContain(
      "POST /api/stock-transfer-order/wa-approval/requests [requireAuth > <anonymous> > validateRequest > <anonymous>]"
    );
    expect(routeManifest.middlewareMounts).toContain("USE / [manifestAccessBoundary]");
    expect(accessManifest).toContain(
      '{"id":"POST /api/stock-transfer-order/wa-approval/webhook#1","guards":"validateRequest > stockTransferOrderWaWebhookHandler","auth":"service-token","companyScope":"none","roles":"any","permission":"none"}'
    );
  });
});
