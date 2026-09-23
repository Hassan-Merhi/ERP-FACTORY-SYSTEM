import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const src = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("Stock Entry staff tracking tabs", () => {
  it("keeps Production Targets in Bale Stock Entry and hides the legacy Attendance Register", () => {
    const stockEntry = src("client/src/pages/factory/BaleStockEntry.tsx");
    expect(stockEntry).toContain('value="production-targets"');
    expect(stockEntry).toContain("<FactoryProductionTargets />");
    expect(stockEntry).not.toContain('value="attendance-register"');
    expect(stockEntry).not.toContain('<FactoryStaffTracking mode="attendance" />');
  });

  it("keeps Attendance under Payroll & Benefits and centralizes its WhatsApp group in Intel Settings", () => {
    const payroll = src("client/src/pages/factory/FactoryPayrollHub.tsx");
    const workersHub = src("client/src/pages/factory/FactoryWorkersHub.tsx");
    const attendance = src("client/src/pages/factory/FactoryAttendance.tsx");
    const intelSettings = src("client/src/pages/factory/factorysettings/FactorySettingsView.tsx");

    expect(payroll).toContain("<FactoryWorkersHub />");
    expect(workersHub).toContain('value="attendance"');
    expect(workersHub).toContain("<FactoryAttendance />");
    expect(attendance).not.toContain('data-testid="button-change-attendance-whatsapp-group"');
    expect(attendance).not.toContain('data-testid="button-save-attendance-wa-group"');
    expect(attendance).toContain('data-testid="button-send-attendance-whatsapp-image"');
    expect(attendance).toContain('destination: "attendance"');
    expect(intelSettings).toContain("Attendance WhatsApp Group");
    expect(intelSettings).toContain('data-testid="button-change-attendance-wa-group"');
    expect(intelSettings).toContain('data-testid="button-save-attendance-wa-group"');
  });

  it("keeps the Attendance workflow intact inside the modernized layout", () => {
    const attendance = src("client/src/pages/factory/FactoryAttendance.tsx");
    const summaryCard = src("client/src/pages/factory/factoryattendance/components/SummaryCard.tsx");

    expect(attendance).toContain("factory-tracking-modern factory-tracking-attendance");
    expect(attendance).toContain('data-testid="input-attendance-date"');
    expect(attendance).toContain('data-testid="input-shift"');
    expect(attendance).toContain('data-testid="button-send-attendance-whatsapp-image"');
    expect(attendance).toContain('data-testid="button-actions-dropdown"');
    expect(attendance).toContain('data-testid="button-save-attendance"');
    expect(attendance).toContain('data-testid="button-range-export-excel"');
    expect(attendance).toContain('data-testid="button-range-print"');
    expect(attendance).toContain('data-testid={`select-status-${worker.id}`}');
    expect(attendance).toContain('data-testid={`input-notes-${worker.id}`}');
    expect(summaryCard).toContain("hover:-translate-y-0.5");
  });

  it("removes the obsolete Attendance Register visibility setting", () => {
    const constants = src("client/src/pages/settings/users/UserManagementConstants.tsx");
    expect(constants).toContain("hide_tab_stockentry_production_targets");
    expect(constants).not.toContain("hide_tab_stockentry_attendance_register");
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

  it("uses the modern Attendance shell without changing the existing attendance actions", () => {
    const attendance = src("client/src/pages/factory/FactoryAttendance.tsx");
    const summaryCard = src("client/src/pages/factory/factoryattendance/components/SummaryCard.tsx");
    const perWorker = src("client/src/pages/factory/factoryattendance/components/PerWorkerView.tsx");

    expect(attendance).toContain("factory-tracking-modern factory-tracking-attendance");
    expect(attendance).toContain('import "./factoryTrackingModern.css"');
    expect(attendance).toContain('data-testid="input-attendance-date"');
    expect(attendance).toContain('data-testid="input-shift"');
    expect(attendance).toContain('data-testid="button-send-attendance-whatsapp-image"');
    expect(attendance).toContain('data-testid="button-actions-dropdown"');
    expect(attendance).toContain('data-testid="button-save-attendance"');
    expect(attendance).toContain('data-testid="button-range-export-excel"');
    expect(attendance).toContain('data-testid="button-range-print"');
    expect(attendance).toContain("modern");
    expect(summaryCard).toContain("modern = false");
    expect(perWorker).toContain("modern");
  });

  it("renders Payroll Attendance KPIs inside the WhatsApp attendance image", () => {
    const attendance = src("client/src/pages/factory/FactoryAttendance.tsx");
    expect(attendance).toContain('data-testid="attendance-report-kpis"');
    expect(attendance).toContain('data-testid={\`attendance-report-kpi-\${kpi.key}\`}');
    expect(attendance).toContain('label: "Total"');
    expect(attendance).toContain('value: counts.total');
    expect(attendance).toContain('label: "Present"');
    expect(attendance).toContain('value: counts.present');
    expect(attendance).toContain('label: "Absent"');
    expect(attendance).toContain('value: counts.absent');
    expect(attendance).toContain('label: "Other"');
    expect(attendance).toContain('value: counts.other');
    expect(attendance).toContain("html2canvas(attendanceReportRef.current");
  });

  it("shows target, absent target, expected target, and expected-minus-produced KPIs", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    const model = src("client/src/pages/factory/factoryProductionTargetsModel.ts");
    expect(production).toContain('tr("totalTarget")');
    expect(production).toContain('tr("totalAbsentTarget")');
    expect(production).toContain('tr("totalExpected")');
    expect(production).toContain('tr("totalWorkers")');
    expect(production).toContain('tr("totalAbsent")');
    expect(production).toContain('tr("totalPresent")');
    expect(production).toContain('tr("diff")');
    expect(production).toContain("grid-cols-3");
    expect(production).toContain("sm:grid-cols-2 xl:grid-cols-4");
    expect(model).toContain("absentTarget");
    expect(model).toContain("const expected = target - absentTarget");
    expect(model).toContain("difference: expected - produced");
  });
});
