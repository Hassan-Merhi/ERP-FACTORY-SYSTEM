import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Compare code independent of formatting: whitespace, quote style, trailing
// commas and parentheses around a single arrow parameter are what prettier changes.
const normalized = (code: string) =>
  code
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/,([)\]}])/g, "$1")
    .replace(/\((\w+)\)=>/g, "$1=>");
const source = (path: string) => normalized(readFileSync(resolve(process.cwd(), path), "utf8"));

describe("Production Targets bonus checkout eligibility", () => {
  it("uses only workers assigned to Production Targets/Planner, not every stock-entry worker", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(live).toContain(normalized("FROM factory_worker_categories planner"));
    expect(live).toContain(normalized("planner.company_id=w.company_id"));
    expect(live).toContain(normalized("planner.worker_ids @> jsonb_build_array(w.id)"));
    expect(live).toContain(normalized("planner.worker_ids @> jsonb_build_array(w.id::text)"));
    // Workers still receive production credits from physical Stock Entry history.
    expect(live).toContain(normalized("FROM factory_bales b"));
    expect(live).toContain(normalized("JOIN factory_workers w"));
    expect(live).toContain(normalized("factory_staff_tracking_period_closures"));
  });

  it("uses full production weeks even if the requested dates are partial or production is still open", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const combined = source("server/services/factory/targetBonusReview.ts");
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(route).toContain(normalized("mondayOfProductionBonusWeek(from)"));
    expect(route).toContain(normalized("loadTargetBonusRows(tx, companyId, weekFrom, weekTo)"));
    expect(route).toContain(normalized("allocateWeeklyExtraBales(daily.map(day=>"));
    expect(route).toContain(normalized("weeklyExtras.get(key)??0"));
    expect(route).toContain(normalized("if(source.date<from || source.date>to ||"));
    expect(combined).toContain(normalized("return [...finalizedRows, ...liveRows]"));
    expect(live).toContain(normalized("AND NOT EXISTS ("));
  });

  it("lists exactly the Production Targets workers on the selected end date, not a range union", () => {
    const roster = source("server/services/factory/productionTargetsRoster.ts");
    const tracking = source("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const checkout = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const ui = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const live = source("server/services/factory/targetBonusLivePreview.ts");

    expect(tracking).toContain(normalized("isProductionTargetsRosterWorker({"));
    expect(roster).toContain(normalized("if (row.finalized) return row.savedForPeriod"));
    expect(roster).toContain(normalized("row.plannerAssigned &&"));
    expect(roster).toContain(normalized("factory_worker_categories planner"));
    expect(roster).toContain(normalized("factory_staff_tracking_period_closures c"));
    expect(roster).toContain(normalized("factory_worker_production_links l"));
    expect(checkout).toContain(normalized("loadProductionTargetsRosterIds(tx,companyId,rosterDate)"));
    expect(checkout).toContain(normalized("!rosterWorkerIds.has(source.workerId)"));
    expect(checkout).toContain(normalized("const rosterDate=req.body?.rosterDate??lastDate"));
    expect(checkout).toContain(normalized("calculateOffers(tx,id,firstDate,lastDate,method,rosterDate)"));
    expect(ui).toContain(normalized("method,rosterDate:to,confirm:true"));
    // An active planner worker on the Targets table must be displayed even if
    // they have neither a saved target nor production for the selected day.
    expect(live).not.toContain(normalized("AND (saved.person_id IS NOT NULL OR defaults.target_bales IS NOT NULL"));
    expect(live).toContain(normalized("w.active=TRUE AND (w.date_joined IS NULL"));
  });

  it("does not replace someone's individual target with their linked teammate's target", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expect(live).toContain(normalized("WHEN saved.target_overridden THEN saved.target_bales"));
    expect(live).toContain(normalized("WHEN defaults.found THEN defaults.target_bales"));
    expect(live).toContain(normalized("WHEN link.id IS NOT NULL THEN link_default.target_bales"));
    expect(live).not.toContain(normalized("link_override.found"));
    // Historical finalized records remain sourced from saved Production Targets days.
    const combined = source("server/services/factory/targetBonusReview.ts");
    expect(combined).toContain(normalized("FROM factory_staff_tracking_entries e"));
    expect(combined).toContain(normalized("return [...finalizedRows, ...liveRows]"));
  });

  it("uses each linked worker's Stock Entry bales, not the linked group's equal split", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    const finalized = source("server/services/factory/targetBonusReview.ts");
    const category = source("shared/productionBonusCheckoutMath.ts");
    expect(live).toContain(normalized("COALESCE(single_bales.bales,0)::integer AS credited"));
    expect(live).not.toContain(normalized("linked_work_totals AS MATERIALIZED"));
    expect(finalized).toContain(normalized("factory_target_bonus_category_bale_snapshots"));
    expect(finalized).toContain(normalized("captured_credit.worker_id=e.person_id"));
    expect(finalized).toContain(normalized("own_credit.worker_id=e.person_id"));
    expect(finalized).not.toContain(normalized("FLOOR(COALESCE(e.produced_bales"));
    expect(category).toContain(normalized("if(bale.worker!==workerId)continue"));
  });

  it("highlights the whole achieved daily/weekly target cell rather than only the extra text", () => {
    const sheet = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    expect(sheet).toContain(normalized("day.target > 0 && day.produced >= day.target"));
    expect(sheet).toContain(normalized("const achievedWeek = target > 0 && made >= target;"));
    // The Daily Production Sheet redesign (#2647) tints the whole achieved cell.
    expect(sheet).toContain(normalized("border-emerald-500/30 bg-emerald-500/15 dark:bg-emerald-800/35"));
  });

  it("marks weekly-flat-covered days as weekly, not an unexplained Needs review error", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const panel = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const language = source("client/src/i18n/factoryProductionBonusCheckoutTranslations.ts");
    expect(route).toContain(normalized("handledByWeekly=true"));
    expect(route).toContain(normalized('handledByWeekly ? "weekly"'));
    expect(route).toContain(normalized("weeklyFlat || weeklyClaim"));
    expect(panel).toContain(normalized('if(row.status==="weekly")group.weeklyDays++'));
    expect(panel).not.toContain(normalized('t("statusAction")'));
    expect(language).toContain(normalized("days covered by the weekly bonus (not payable here)"));
    // Preserve duplicate-payment prevention by allowing only payable statuses.
    expect(panel).toContain(normalized('row.status==="pending"||row.status==="approved"'));
  });
});
