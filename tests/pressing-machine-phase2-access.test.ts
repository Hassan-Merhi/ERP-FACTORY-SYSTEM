import fs from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path:string) => fs.readFileSync(path,"utf8");
const backend = read("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const access = read("server/middleware/factoryBackendAccessBoundary.ts");
const routes = read("server/routes/factoryRoutes.ts");
const catalog = read("shared/factoryPermissionCatalog.ts");
const hub = read("client/src/pages/factory/BaleStockEntry.tsx");
const page = read("client/src/pages/factory/PressingMachineManagement.tsx");

describe("Simple pressing access — page-authorized user controls",()=>{
  it("uses existing Factory tab access and lazy mount, just like Ground Scan",()=>{
    expect(routes).toContain("registerFactoryPressingMachineManagementRoutes(app)");
    expect(routes.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(routes.indexOf("registerFactoryPressingMachineManagementRoutes(app)"));
    expect(access).toContain('requirement("factory/stock-entry", ["hide_tab_stockentry_pressing_machines"])');
    expect(catalog).toContain('hide_tab_stockentry_pressing_machines');
    expect(hub).toContain('data-testid="tab-pressing-machines"');
    expect(page).toContain('data-testid="pressing-machine-management"');
  });
  it("automatically initializes one internal station for the logged-in user",()=>{
    expect(backend).toContain('app.post("/api/factory/pressing-machines/activate"');
    expect(backend).toContain('getActiveCompanyPermissionContext(req)');
    expect(backend).toContain('eq(factoryPressingAssignments.userId, userId)');
    expect(backend).toContain('machineCode: "PRESSING-SCAN"');
    expect(backend).toContain("pg_advisory_xact_lock");
    expect(backend).toContain("onConflictDoNothing()");
    expect(backend).toContain("currentAssignment(ctx.companyId, ctx.userId, tx)");
    expect(backend).toContain("isNull(factoryPressingAssignments.unassignedAt)");
  });
  it("rejects unauthorized view-only and inactive users server-side",()=>{
    expect(backend).toContain('ctx.posViewOnly || ["View Only", "ERP Tester"].includes(ctx.role)');
    expect(backend).toContain('if (!user?.active)');
    expect(backend).toContain('"PRESSING_WRITE_DENIED"');
    expect(backend).toContain("requireAuth");
  });
  it("has NO shift, downtime, machine target or manual user assignment interfaces",()=>{
    expect(page).not.toContain("PressingShiftAnalytics");
    expect(page).not.toContain("targetBalesPerHour");
    expect(page).not.toContain("MachineManagerCard");
    expect(page).not.toContain("/assignments");
    expect(routes).not.toContain("registerFactoryPressingOperationsRoutes(app)");
    expect(backend).not.toContain('"/api/factory/pressing-machines/assignments"');
    expect(backend).not.toContain("targetBalesPerHour");
  });
  it("does not touch bale state, stock costing or vouchers",()=>{
    expect(backend).not.toMatch(/(?:update|insert|delete)\(factoryBales\)/);
    expect(backend).not.toMatch(/adjustInventory|postStockMovementTx|writeDaybookEntry/);
  });
});
