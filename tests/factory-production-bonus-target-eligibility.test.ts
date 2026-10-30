import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Production Targets bonus checkout eligibility", () => {
  it("uses only workers assigned to Production Targets/Planner, not every stock-entry worker", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(live).toContain("FROM factory_worker_categories planner");
    expect(live).toContain("planner.company_id=w.company_id");
    expect(live).toContain("planner.worker_ids @> jsonb_build_array(w.id)");
    expect(live).toContain("planner.worker_ids @> jsonb_build_array(w.id::text)");
    // Workers still receive production credits from physical Stock Entry history.
    expect(live).toContain("FROM factory_bales b");
    expect(live).toContain("JOIN factory_workers w");
    expect(live).toContain("factory_staff_tracking_period_closures");
  });

  it("does not replace someone's individual target with their linked teammate's target", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(live).toContain("WHEN saved.target_overridden THEN saved.target_bales");
    expect(live).toContain("WHEN defaults.found THEN defaults.target_bales");
    expect(live).toContain("WHEN link.id IS NOT NULL THEN link_default.target_bales");
    expect(live).not.toContain("link_override.found");
    // Historical finalized records remain sourced from saved Production Targets days.
    const combined = source("server/services/factory/targetBonusReview.ts");
    expect(combined).toContain("FROM factory_staff_tracking_entries e");
    expect(combined).toContain("return [...finalizedRows, ...liveRows]");
  });

  it("marks weekly-flat-covered days as weekly, not an unexplained Needs review error", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const panel = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const language = source("client/src/i18n/factoryProductionBonusCheckoutTranslations.ts");
    expect(route).toContain("handledByWeekly=true");
    expect(route).toContain('handledByWeekly ? "weekly"');
    expect(route).toContain("weeklyFlat || weeklyClaim");
    expect(panel).toContain('if(row.status==="weekly")group.weeklyDays++');
    expect(panel).toContain('group.weeklyDays>0?t("weeklyStatus")');
    expect(language).toContain("days covered by the weekly bonus (not payable here)");
    // Preserve duplicate-payment prevention by allowing only payable statuses.
    expect(panel).toContain('row.status==="pending"||row.status==="approved"');
  });
});
