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

  it("keeps Daily Defaults separate from day-specific Edit Targets overrides", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const defaultsEditor = src(
      "client/src/pages/factory/productiontargets/ProductionTargetDefaultsDialog.tsx"
    );
    const dayEditor = src("client/src/pages/factory/productiontargets/ProductionTargetsEditorDialog.tsx");
    const route = src("server/routes/factory/factoryStaffTrackingRoutes.ts");
    const targetDefaultsService = src("server/services/factory/productionTargetDefaults.ts");
    const startup = src("server/startup/factoryStaffTrackingSchema.ts");

    expect(production).toContain("button-edit-production-default-targets");
    expect(production).toContain("<ProductionTargetDefaultsDialog");
    expect(defaultsEditor).toContain("production-target-defaults");
    expect(defaultsEditor).toContain("effectiveFrom");
    expect(defaultsEditor).toContain("input-production-default-category-");
    expect(defaultsEditor).toContain("category: (draftDefaults");
    expect(defaultsEditor).toContain("The new category grouping takes effect after Save + refetch");
    expect(dayEditor).toContain("/api/factory/staff-tracking/bulk");
    expect(dayEditor).toContain("originalById.get(row.personId)?.category");
    expect(dayEditor).toContain("Re-group only after the edit is saved");
    expect(dayEditor).toContain("categoryOverrideState");
    expect(dayEditor).toContain("categoryOverridden");
    expect(dayEditor).toContain("targetOverrideState");
    expect(dayEditor).toContain("targetBalesOverridden");
    expect(defaultsEditor).toContain('queryKey: ["/api/factory/staff-tracking/production-target-defaults"]');
    expect(route).toContain("factory_worker_production_target_defaults");
    expect(targetDefaultsService).toContain("effective_from <=");
    expect(targetDefaultsService).toContain("loadActiveProductionWorkerLinks");
    expect(route).toContain('category_overridden AS "categoryOverridden"');
    expect(route).toContain('target_overridden AS "targetBalesOverridden"');
    expect(route).toContain("defaultCategory");
    expect(route).toContain("categoryOverridden");
    expect(route).toContain("defaultTargetBales");
    expect(route).toContain("targetBalesOverridden");
    expect(route).toContain("savedRow?.categoryOverridden === true");
    expect(route).toContain("savedRow?.targetBalesOverridden === true");
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
    const linkRoute = src("server/routes/factory/factoryProductionWorkerLinkRoutes.ts");
    const linkService = src("server/services/factory/productionWorkerLinks.ts");
    const startup = src("server/startup/factoryStaffTrackingSchema.ts");

    expect(editor).toContain("button-link-worker-");
    expect(editor).toContain("button-unlink-worker-");
    expect(editor).toContain("/api/factory/staff-tracking/production-worker-links");
    expect(editor).toContain("linkGroupId");
    expect(defaultsEditor).toContain("linkGroupId");
    expect(production).toContain("collapseLinkedProductionRows");
    expect(production).toContain("row.displayMembers");
    expect(model).toContain("summarizeProductionRows");
    expect(route).toContain("loadActiveProductionWorkerLinks");
    expect(route).toContain("saveProductionLinkTargetDefault");
    expect(linkRoute).toContain("unlinkProductionWorkerLink");
    expect(linkRoute).toContain("hasFinalizedProductionOnOrAfter");
    expect(linkRoute).toContain("finalized production history");
    expect(linkRoute).toContain("/api/factory/staff-tracking/production-worker-links");
    expect(linkRoute).toContain("/api/factory/staff-tracking/production-worker-links/:linkId/unlink");
    expect(startup).toContain("factory_worker_production_links");
    expect(startup).toContain("factory_worker_production_link_members");
    expect(startup).toContain("factory_worker_production_link_target_defaults");
    expect(linkService).toContain("w.position");
    expect(linkService).toContain("w.department");
    expect(linkService).toContain("pg_advisory_xact_lock");
    expect(linkService).toContain("nextEffectiveFrom");

  });

  it("renders Attendance Register KPIs inside the WhatsApp attendance image", () => {
    const attendance = src("client/src/pages/factory/FactoryStaffTracking.tsx");
    expect(attendance).toContain('data-testid="attendance-report-kpis"');
    expect(attendance).toContain('data-testid={\`attendance-report-kpi-\${kpi.key}\`}');
    expect(attendance).toContain('label: tr("totalPeople")');
    expect(attendance).toContain('value: rows.length');
    expect(attendance).toContain('label: tr("present")');
    expect(attendance).toContain('value: totals.present');
    expect(attendance).toContain('label: tr("absent")');
    expect(attendance).toContain('value: totals.absent');
    expect(attendance).toContain('label: tr("new")');
    expect(attendance).toContain('value: totals.newCount');
    expect(attendance).toContain("html2canvas(attendanceReportRef.current");
  });

  it("shows target, absent target, expected target, and expected-minus-produced KPIs", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const model = src("client/src/pages/factory/factoryProductionTargetsModel.ts");
    expect(production).toContain('tr("totalTarget")');
    expect(production).toContain('tr("totalAbsentTarget")');
    expect(production).toContain('tr("totalExpected")');
    expect(production).toContain('tr("diff")');
    expect(production).toContain("sm:grid-cols-2 xl:grid-cols-4");
    expect(model).toContain("absentTarget");
    expect(model).toContain("const expected = target - absentTarget");
    expect(model).toContain("difference: expected - produced");
  });
});
