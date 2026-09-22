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

  it("keeps repeating daily worker defaults separate from day-specific target edits", () => {
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
    expect(dayEditor).toContain("/api/factory/staff-tracking/bulk");
    expect(dayEditor).toContain("targetOverrideState");
    expect(dayEditor).toContain("targetBalesOverridden");
    expect(defaultsEditor).toContain('queryKey: ["/api/factory/staff-tracking/production-target-defaults"]');
    expect(route).toContain("factory_worker_production_target_defaults");
    expect(route).toContain("effective_from <=");
    expect(route).toContain('target_overridden AS "targetBalesOverridden"');
    expect(route).toContain("defaultTargetBales");
    expect(route).toContain("targetBalesOverridden");
    expect(startup).toContain("factory_worker_production_target_defaults");
    expect(startup).toContain("target_overridden boolean NOT NULL DEFAULT false");
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
