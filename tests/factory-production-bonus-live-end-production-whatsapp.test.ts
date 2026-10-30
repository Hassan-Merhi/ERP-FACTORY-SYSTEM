import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}
describe("Production bonus live calculation and manual-only WhatsApp", () => {
  it("loads open physical-bale production without requiring End Production", () => {
    const bonus = source("server/services/factory/targetBonusReview.ts");
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(bonus).toContain("loadLiveTargetBonusRows(executor, companyId, start, end)");
    expect(bonus).toContain("return [...finalizedRows, ...liveRows]");
    expect(live).toContain("FROM generate_series(");
    expect(live).toContain("FROM factory_bales b");
    expect(live).toContain("factory_worker_production_links");
    expect(live).toContain("factory_worker_production_target_defaults");
    expect(live).toContain("factory_production_target_bonus_rates");
    expect(live).toContain("COALESCE(review.bonus_amount");
    expect(live).toContain("sourceFinalized:false");
    expect(live).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM factory_staff_tracking_period_closures c/);
    expect(live).toContain("factory_staff_tracking_period_closures c");
  });

  it("revalidates live amount inside the company-locking immutable approval", () => {
    const routes = source("server/routes/factory/factoryTargetBonusRoutes.ts");
    expect(routes).toContain("pg_advisory_xact_lock(84023");
    expect(routes).toContain("loadTargetBonusRows(tx, companyId");
    expect(routes).toContain("Set a valid production target before approving this live bonus");
    expect(routes).toContain("Math.round(item.proposedAmount * 100)");
    expect(routes).toContain("item.producedBales !== choice.expectedProducedBales");
    expect(routes).toContain("Math.round(item.targetBales * 100)");
    expect(routes).toContain("INSERT INTO factory_target_bonus_reviews");
    const panel = source("client/src/pages/factory/productiontargets/ProductionBonusesPanel.tsx");
    expect(panel).toContain("expectedProducedBales: row.producedBales");
    expect(panel).toContain("Live production");
    expect(panel).toContain("targetConfigured !== false");
    expect(panel).toContain("Approval freezes the worker/day target");
  });

  it("End Production never sends a WhatsApp file or claims that a file was sent", () => {
    const server = source("server/routes/factory/endProductionRoutes.ts");
    const start = server.indexOf('"/api/factory/stock-entry/end-production"');
    const next = server.indexOf('"/api/factory/bales/send-worker-pdf-whatsapp"');
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const endBlock = server.slice(start, next);
    expect(endBlock).not.toContain("sendWhatsAppFileByUploadPos(");
    expect(endBlock).not.toContain("getProductionWaGroupId(");
    expect(endBlock).not.toContain("workerMatrixWhatsappSentAt:");
    expect(endBlock).toContain("whatsappSent: false");
    const manualBlock = server.slice(next);
    expect(manualBlock).toContain("sendWhatsAppFileByUploadPos(");
    const targets = source("client/src/pages/factory/FactoryProductionTargets.tsx");
    const send = targets.indexOf("const sendWhatsappMutation");
    const end = targets.indexOf("const endProductionMutation");
    const exportPos = targets.indexOf("const exportWeeklyMutation");
    expect(end).toBeGreaterThan(send);
    expect(targets.slice(end, exportPos)).not.toContain("sendProductionWhatsappImage");
  });
});
