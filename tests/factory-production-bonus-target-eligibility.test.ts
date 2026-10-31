import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Formatting-insensitive source check: compares code tokens, not layout, so a
// Prettier reflow of the source cannot break the contract.
const normalizeCode = (code: string) =>
  code
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/\((\w+)\)=>/g, "$1=>")
    .replace(/,([}\])])/g, "$1");
const expectCode = (code: string, expected: string) => expect(normalizeCode(code)).toContain(normalizeCode(expected));
const expectNoCode = (code: string, unexpected: string) =>
  expect(normalizeCode(code)).not.toContain(normalizeCode(unexpected));

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Production Targets bonus checkout eligibility", () => {
  it("uses only workers assigned to Production Targets/Planner, not every stock-entry worker", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expectCode(live, "FROM factory_worker_categories planner");
    expectCode(live, "planner.company_id=w.company_id");
    expectCode(live, "planner.worker_ids @> jsonb_build_array(w.id)");
    expectCode(live, "planner.worker_ids @> jsonb_build_array(w.id::text)");
    // Workers still receive production credits from physical Stock Entry history.
    expectCode(live, "FROM factory_bales b");
    expectCode(live, "JOIN factory_workers w");
    expectCode(live, "factory_staff_tracking_period_closures");
  });

  it("uses full production weeks even if the requested dates are partial or production is still open", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const combined = source("server/services/factory/targetBonusReview.ts");
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expectCode(route, "mondayOfProductionBonusWeek(from)");
    expectCode(route, "loadTargetBonusRows(tx, companyId, weekFrom, weekTo)");
    expect(route).toMatch(/allocateWeeklyExtraBales\(\s*daily\.map\(\(?day\)?\s*=>/);
    expectCode(route, "weeklyExtras.get(key)??0");
    expectCode(route, "if(source.date<from || source.date>to ||");
    expectCode(combined, "return [...finalizedRows, ...liveRows]");
    expectCode(live, "AND NOT EXISTS (");
  });

  it("lists exactly the Production Targets workers on the selected end date, not a range union", () => {
    const roster = source("server/services/factory/productionTargetsRoster.ts");
    const tracking = source("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const checkout = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const ui = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const live = source("server/services/factory/targetBonusLivePreview.ts");

    expectCode(tracking, "isProductionTargetsRosterWorker({");
    expectCode(roster, "if (row.finalized) return row.savedForPeriod");
    expectCode(roster, "row.plannerAssigned &&");
    expectCode(roster, "factory_worker_categories planner");
    expectCode(roster, "factory_staff_tracking_period_closures c");
    expectCode(roster, "factory_worker_production_links l");
    expectCode(checkout, "loadProductionTargetsRosterIds(tx, companyId, rosterDate)");
    expectCode(checkout, "!rosterWorkerIds.has(source.workerId)");
    expectCode(checkout, "const rosterDate=req.body?.rosterDate??lastDate");
    expectCode(checkout, "calculateOffers(tx,id,firstDate,lastDate,method,rosterDate)");
    expectCode(ui, "method,rosterDate:to,confirm:true");
    // An active planner worker on the Targets table must be displayed even if
    // they have neither a saved target nor production for the selected day.
    expectNoCode(live, "AND (saved.person_id IS NOT NULL OR defaults.target_bales IS NOT NULL");
    expectCode(live, "w.active=TRUE AND (w.date_joined IS NULL");
  });

  it("does not replace someone's individual target with their linked teammate's target", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    expectCode(live, "WHEN saved.target_overridden THEN saved.target_bales");
    expectCode(live, "WHEN defaults.found THEN defaults.target_bales");
    expectCode(live, "WHEN link.id IS NOT NULL THEN link_default.target_bales");
    expectNoCode(live, "link_override.found");
    // Historical finalized records remain sourced from saved Production Targets days.
    const combined = source("server/services/factory/targetBonusReview.ts");
    expectCode(combined, "FROM factory_staff_tracking_entries e");
    expectCode(combined, "return [...finalizedRows, ...liveRows]");
  });

  it("uses each linked worker's Stock Entry bales, not the linked group's equal split", () => {
    const live = source("server/services/factory/targetBonusLivePreview.ts");
    const finalized = source("server/services/factory/targetBonusReview.ts");
    const category = source("shared/productionBonusCheckoutMath.ts");
    expectCode(live, "COALESCE(single_bales.bales,0)::integer AS credited");
    expectNoCode(live, "linked_work_totals AS MATERIALIZED");
    expectCode(finalized, "factory_target_bonus_category_bale_snapshots");
    expectCode(finalized, "captured_credit.worker_id=e.person_id");
    expectCode(finalized, "own_credit.worker_id=e.person_id");
    expectNoCode(finalized, "FLOOR(COALESCE(e.produced_bales");
    expectCode(category, "if(bale.worker!==workerId)continue");
  });

  it("highlights the whole achieved daily/weekly target cell rather than only the extra text", () => {
    const sheet = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    expectCode(sheet, "day.target > 0 && day.produced >= day.target");
    expectCode(sheet, "const achievedWeek = target > 0 && made >= target;");
    // #2647 redesign: the whole day cell switches to the achieved style.
    expectCode(sheet, "border-emerald-500/30 bg-emerald-500/15 dark:bg-emerald-800/35");
  });

  it("marks weekly-flat-covered days as weekly, not an unexplained Needs review error", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    const panel = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const language = source("client/src/i18n/factoryProductionBonusCheckoutTranslations.ts");
    expectCode(route, "handledByWeekly = true");
    expectCode(route, 'handledByWeekly ? "weekly"');
    expectCode(route, "weeklyFlat || weeklyClaim");
    expectCode(panel, 'if(row.status==="weekly")group.weeklyDays++');
    expectNoCode(panel, 't("statusAction")');
    expectCode(language, "days covered by the weekly bonus (not payable here)");
    // Preserve duplicate-payment prevention by allowing only payable statuses.
    expectCode(panel, 'row.status==="pending"||row.status==="approved"');
  });
});
