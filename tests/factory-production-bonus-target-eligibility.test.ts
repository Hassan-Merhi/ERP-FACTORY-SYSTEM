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

  it("uses full production weeks even if the requested dates are partial or production is still open", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const combined = source("server/services/factory/targetBonusReview.ts");
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(route).toContain("mondayOfProductionBonusWeek(from)");
    expect(route).toContain("loadTargetBonusRows(tx, companyId, weekFrom, weekTo)");
    expect(route).toContain("allocateWeeklyExtraBales(daily.map(day=>");
    expect(route).toContain("weeklyExtras.get(key)??0");
    expect(route).toContain("if(source.date<from || source.date>to ||");
    expect(combined).toContain("return [...finalizedRows, ...liveRows]");
    expect(live).toContain("AND NOT EXISTS (");
  });

  it("lists exactly the Production Targets workers on the selected end date, not a range union", () => {
    const roster = source("server/services/factory/productionTargetsRoster.ts");
    const tracking = source("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const checkout = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const ui = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const live = source("server/services/factory/targetBonusLivePreview.ts");

    expect(tracking).toContain("isProductionTargetsRosterWorker({");
    expect(roster).toContain("if (row.finalized) return row.savedForPeriod");
    expect(roster).toContain("row.plannerAssigned &&");
    expect(roster).toContain("factory_worker_categories planner");
    expect(roster).toContain("factory_staff_tracking_period_closures c");
    expect(roster).toContain("factory_worker_production_links l");
    expect(checkout).toContain("loadProductionTargetsRosterIds(tx,companyId,rosterDate)");
    expect(checkout).toContain("!rosterWorkerIds.has(source.workerId)");
    expect(checkout).toContain("const rosterDate=req.body?.rosterDate??lastDate");
    expect(checkout).toContain("calculateOffers(tx,id,firstDate,lastDate,method,rosterDate)");
    expect(ui).toContain("method,rosterDate:to,confirm:true");
    // An active planner worker on the Targets table must be displayed even if
    // they have neither a saved target nor production for the selected day.
    expect(live).not.toContain("AND (saved.person_id IS NOT NULL OR defaults.target_bales IS NOT NULL");
    expect(live).toContain("w.active=TRUE AND (w.date_joined IS NULL");
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
    expect(panel).not.toContain('t("statusAction")');
    expect(language).toContain("days covered by the weekly bonus (not payable here)");
    // Preserve duplicate-payment prevention by allowing only payable statuses.
    expect(panel).toContain('row.status==="pending"||row.status==="approved"');
  });
});
