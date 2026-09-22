import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const src = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("Stock Entry staff tracking tabs", () => {
  it("hosts Production Targets and Attendance Register in Bale Stock Entry", () => {
    const stockEntry = src("client/src/pages/factory/BaleStockEntry.tsx");
    expect(stockEntry).toContain('value="production-targets"');
    expect(stockEntry).toContain('value="attendance-register"');
    expect(stockEntry).toContain("<FactoryProductionTargets />");
    expect(stockEntry).toContain('<FactoryStaffTracking mode="attendance" />');
  });

  it("removes Production Targets and Attendance Register from Payroll & Benefits", () => {
    const payroll = src("client/src/pages/factory/FactoryPayrollHub.tsx");
    expect(payroll).not.toContain('"production-targets"');
    expect(payroll).not.toContain('"attendance-register"');
    expect(payroll).not.toContain("<FactoryProductionTargets />");
    expect(payroll).not.toContain('<FactoryStaffTracking mode="attendance" />');
  });

  it("exposes per-user Stock Entry restrictions in Settings", () => {
    const constants = src("client/src/pages/settings/users/UserManagementConstants.tsx");
    expect(constants).toContain("hide_tab_stockentry_production_targets");
    expect(constants).toContain("hide_tab_stockentry_attendance_register");
  });

  it("enforces the same per-user restrictions on staff-tracking APIs", () => {
    const route = src("server/routes/factory/factoryStaffTrackingRoutes.ts");
    expect(route).toContain("hide_tab_stockentry_production_targets");
    expect(route).toContain("hide_tab_stockentry_attendance_register");
    expect(route).toContain("canAccessTrackingPage");
    expect(route).toContain("res.status(403)");
  });

  it("uses a dedicated editor dialog instead of Excel import/export for Production Targets", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const editor = src("client/src/pages/factory/productiontargets/ProductionTargetsEditorDialog.tsx");
    expect(production).not.toContain("button-production-excel-template");
    expect(production).not.toContain("button-import-production-excel");
    expect(production).toContain("button-edit-production-targets");
    expect(production).toContain("<ProductionTargetsEditorDialog");
    expect(editor).toContain("dialog-production-targets-editor");
    expect(editor).toContain("button-save-production-editor");
    expect(editor).toContain("input-production-category-");
    expect(editor).toContain("input-production-target-");
  });

  it("keeps repeating daily category/target defaults separate from day-specific edits", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const defaultsEditor = src(
      "client/src/pages/factory/productiontargets/ProductionTargetDefaultsDialog.tsx"
    );
    const dayEditor = src("client/src/pages/factory/productiontargets/ProductionTargetsEditorDialog.tsx");
    const route = src("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const startup = src("server/startup/factoryStaffTrackingSchema.ts");

    expect(production).toContain("button-edit-production-default-targets");
    expect(production).toContain("<ProductionTargetDefaultsDialog");
    expect(defaultsEditor).toContain("production-target-defaults");
    expect(defaultsEditor).toContain("effectiveFrom");
    expect(defaultsEditor).toContain("input-production-default-category-");
    expect(defaultsEditor).toContain("category: (draftDefaults");
    expect(dayEditor).toContain("/api/factory/staff-tracking/bulk");
    expect(dayEditor).toContain("categoryOverrideState");
    expect(dayEditor).toContain("categoryOverridden");
    expect(dayEditor).toContain("targetOverrideState");
    expect(dayEditor).toContain("targetBalesOverridden");
    expect(defaultsEditor).toContain('queryKey: ["/api/factory/staff-tracking/production-target-defaults"]');
    expect(route).toContain("factory_worker_production_target_defaults");
    expect(route).toContain("effective_from <=");
    expect(route).toContain('category_overridden AS "categoryOverridden"');
    expect(route).toContain('target_overridden AS "targetBalesOverridden"');
    expect(route).toContain("defaultCategory");
    expect(route).toContain("categoryOverridden");
    expect(route).toContain("defaultTargetBales");
    expect(route).toContain("targetBalesOverridden");
    expect(startup).toContain("factory_worker_production_target_defaults");
    expect(startup).toContain("ADD COLUMN IF NOT EXISTS category varchar(150)");
    expect(startup).toContain("category_overridden boolean NOT NULL DEFAULT true");
    expect(startup).toContain("ALTER COLUMN category_overridden SET DEFAULT false");
    expect(startup).toContain("target_overridden boolean NOT NULL DEFAULT false");
  });

  it("supports effective-dated linked production workers with one shared target", () => {
    const editor = src("client/src/pages/factory/productiontargets/ProductionTargetsEditorDialog.tsx");
    const defaultsEditor = src("client/src/pages/factory/productiontargets/ProductionTargetDefaultsDialog.tsx");
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const model = src("client/src/pages/factory/factoryProductionTargetsModel.ts");
    const route = src("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const linkService = src("server/services/factory/productionWorkerLinks.ts");
    const startup = src("server/startup/factoryStaffTrackingSchema.ts");

    expect(editor).toContain("button-link-worker-");
    expect(editor).toContain("button-unlink-worker-");
    expect(editor).toContain("/api/factory/staff-tracking/production-worker-links");
    expect(editor).toContain("linkGroupId");
    expect(defaultsEditor).toContain("linkGroupId");
    expect(production).toContain('tr("linkedWith")');
    expect(model).toContain("summarizeProductionRows");
    expect(route).toContain("loadActiveProductionWorkerLinks");
    expect(route).toContain("saveProductionLinkTargetDefault");
    expect(route).toContain("unlinkProductionWorkerLink");
    expect(route).toContain("hasFinalizedProductionOnOrAfter");
    expect(route).toContain("finalized production history");
    expect(route).toContain("/api/factory/staff-tracking/production-worker-links");
    expect(route).toContain("/api/factory/staff-tracking/production-worker-links/:linkId/unlink");
    expect(startup).toContain("factory_worker_production_links");
    expect(startup).toContain("factory_worker_production_link_members");
    expect(startup).toContain("factory_worker_production_link_target_defaults");
    expect(linkService).toContain("w.position");
    expect(linkService).toContain("w.department");

  });

  it("combines target and produced into one KPI and exposes People attendance breakdown on hover", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    expect(production).toContain("kpi-production-target-produced");
    expect(production).toContain("TargetProducedTile");
    expect(production).toContain("md:grid-cols-3");
    expect(production).toContain("kpi-production-people");
    expect(production).toContain("tooltip-production-people");
    expect(production).toContain("peopleBreakdown");
    expect(production).toContain("FACTORY_TRACKING_STATUSES.absent");
    expect(production).toContain("FACTORY_TRACKING_STATUSES.new");
  });
});
