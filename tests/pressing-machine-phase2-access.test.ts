import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";
const read = (path: string) => fs.readFileSync(path, "utf8");
const backend = read("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const access = read("server/middleware/factoryBackendAccessBoundary.ts");
const routes = read("server/routes/factoryRoutes.ts");
const catalog = read("shared/factoryPermissionCatalog.ts");
const hub = read("client/src/pages/factory/BaleStockEntry.tsx");
const page = read("client/src/pages/factory/PressingMachineManagement.tsx");
const report = read("server/routes/factory/factoryPressingReportRoutes.ts");

describe("Simple pressing access — page-authorized user controls", () => {
  it("uses existing Factory tab access and lazy mount, just like Ground Scan", () => {
    expect(shaped(routes)).toContain(fragmentFor(routes, "registerFactoryPressingMachineManagementRoutes(app)"));
    expect(codeShape(routes).indexOf(codeShape('app.use("/api/factory", enforceFactoryBackendAccess)'))).toBeLessThan(
      codeShape(routes).indexOf(codeShape("registerFactoryPressingMachineManagementRoutes(app)"))
    );
    expect(shaped(access)).toContain(fragmentFor(access, 'requirement("factory/stock-entry", ["hide_tab_stockentry_pressing_machines"])'));
    expect(shaped(catalog)).toContain(fragmentFor(catalog, "hide_tab_stockentry_pressing_machines"));
    expect(shaped(hub)).toContain(fragmentFor(hub, 'data-testid="tab-pressing-machines"'));
    expect(shaped(page)).toContain(fragmentFor(page, 'data-testid="pressing-machine-management"'));
  });
  it("automatically initializes one internal station for the logged-in user", () => {
    expect(shaped(backend)).toContain(fragmentFor(backend, 'app.post("/api/factory/pressing-machines/activate"'));
    expect(shaped(backend)).toContain(fragmentFor(backend, "getActiveCompanyPermissionContext(req)"));
    expect(shaped(backend)).toContain(fragmentFor(backend, "eq(factoryPressingAssignments.userId, userId)"));
    expect(shaped(backend)).toContain(fragmentFor(backend, 'machineCode: "PRESSING-SCAN"'));
    expect(shaped(backend)).toContain(fragmentFor(backend, "pg_advisory_xact_lock"));
    expect(shaped(backend)).toContain(fragmentFor(backend, "onConflictDoNothing()"));
    expect(shaped(backend)).toContain(fragmentFor(backend, "currentAssignment(ctx.companyId, ctx.userId, tx)"));
    expect(shaped(backend)).toContain(fragmentFor(backend, "isNull(factoryPressingAssignments.unassignedAt)"));
  });
  it("rejects unauthorized view-only and inactive users server-side", () => {
    expect(shaped(backend)).toContain(fragmentFor(backend, 'ctx.posViewOnly || ["View Only", "Create Only", "ERP Tester"].includes(ctx.role)'));
    expect(shaped(backend)).toContain(fragmentFor(backend, "if (!user?.active)"));
    expect(shaped(backend)).toContain(fragmentFor(backend, '"PRESSING_WRITE_DENIED"'));
    expect(shaped(backend)).toContain(fragmentFor(backend, "requireAuth"));
  });
  it("keeps View Only in read-only pressing overview without station setup or scanning", () => {
    expect(shaped(backend)).toContain(fragmentFor(backend, 'canScan: !ctx.posViewOnly && !["View Only", "Create Only", "ERP Tester"].includes(ctx.role)'));
    expect(shaped(page)).toContain(fragmentFor(page, "if (active && access.data && validCompany && !assignment && canScan) void activate()"));
    expect(shaped(page)).toContain(fragmentFor(page, "{canScan && !assignment && !access.isLoading"));
    expect(shaped(page)).toContain(fragmentFor(page, "{canScan && <div"));
    expect(shaped(page)).toContain(fragmentFor(page, "fullControls || viewOnly"));
    expect(shaped(page)).toContain(fragmentFor(page, 'data-testid="pressing-view-only-notice"'));
    expect(shaped(report)).toContain(fragmentFor(report, 'ctx.role === "View Only"'));
    expect(shaped(report)).toContain(fragmentFor(report, "canCorrect: canEditPressingTargets(ctx.role, ctx.posViewOnly)"));
  });
  it("has NO shift, downtime, machine target or manual user assignment interfaces", () => {
    expect(shaped(page)).not.toContain(fragmentFor(page, "PressingShiftAnalytics"));
    expect(shaped(page)).not.toContain(fragmentFor(page, "targetBalesPerHour"));
    expect(shaped(page)).not.toContain(fragmentFor(page, "MachineManagerCard"));
    expect(shaped(page)).not.toContain(fragmentFor(page, "/assignments"));
    expect(shaped(routes)).not.toContain(fragmentFor(routes, "registerFactoryPressingOperationsRoutes(app)"));
    expect(shaped(backend)).not.toContain(fragmentFor(backend, '"/api/factory/pressing-machines/assignments"'));
    expect(shaped(backend)).not.toContain(fragmentFor(backend, "targetBalesPerHour"));
  });
  it("does not touch bale state, stock costing or vouchers", () => {
    expect(backend).not.toMatch(/(?:update|insert|delete)\(factoryBales\)/);
    expect(backend).not.toMatch(/adjustInventory|postStockMovementTx|writeDaybookEntry/);
  });
});
