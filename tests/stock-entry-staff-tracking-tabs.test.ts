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

  it("uses direct table editing instead of Excel import/export for Production Targets", () => {
    const production = src("client/src/pages/factory/FactoryProductionTargets.tsx");
    expect(production).not.toContain("button-production-excel-template");
    expect(production).not.toContain("button-import-production-excel");
    expect(production).toContain("button-save-production");
    expect(production).toContain("button-discard-production-changes");
    expect(production).toContain("production-category-options");
    expect(production).toContain("hasUnsavedChanges");
  });
});
