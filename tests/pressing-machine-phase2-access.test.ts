import fs from "node:fs";
import { describe, expect, it } from "vitest";

const file = (path: string) => fs.readFileSync(path, "utf8");
const backend = file("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const access = file("server/middleware/factoryBackendAccessBoundary.ts");
const routes = file("server/routes/factoryRoutes.ts");
const catalog = file("shared/factoryPermissionCatalog.ts");
const hub = file("client/src/pages/factory/BaleStockEntry.tsx");
const page = file("client/src/pages/factory/PressingMachineManagement.tsx");

describe("Pressing Machine Management Phase 2 contracts", () => {
  it("registers the management API behind the existing Factory security boundaries", () => {
    expect(routes).toContain("registerFactoryPressingMachineManagementRoutes(app)");
    expect(routes.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(routes.indexOf("registerFactoryPressingMachineManagementRoutes(app)"));
    expect(access).toContain('hasPrefix(path, "/pressing-machines")');
    expect(access).toContain('requirement("factory/stock-entry", ["hide_tab_stockentry_pressing_machines"])');
    expect(catalog).toContain('{ key: "hide_tab_stockentry_pressing_machines", label: "Pressing Machines"');
  });

  it("adds the child tab next to Daily Scan but lazy mounts management", () => {
    expect(hub).toContain('value="pressing-machines"');
    expect(hub).toContain('data-testid="tab-pressing-machines"');
    expect(hub.indexOf('data-testid="tab-daily-scan"')).toBeLessThan(hub.indexOf('data-testid="tab-pressing-machines"'));
    expect(hub).toContain('mountedTabs.has("pressing-machines") && <PressingMachineManagement active={activeTab === "pressing-machines"} />');
    expect(page).toContain('data-testid="pressing-machine-management"');
  });

  it("never exposes company-wide management through the operator-only endpoint", () => {
    expect(backend).toContain('app.get("/api/factory/pressing-machines/me"');
    expect(backend).toContain('eq(factoryPressingAssignments.userId, ctx.userId)');
    expect(backend).toContain('const ctx = await authorize(req, true)');
    expect(backend).toContain('MANAGERS.has(ctx.role) && !ctx.posViewOnly');
    expect(backend).toContain('getActiveCompanyPermissionContext(req)');
  });

  it("keeps exactly one active machine assignment per employee across reassignments", () => {
    expect(backend).toContain("pg_advisory_xact_lock");
    expect(backend).toContain("isNull(factoryPressingAssignments.unassignedAt)");
    expect(backend).toContain("unassignedAt: now, unassignedBy: ctx.userId");
    expect(backend).toContain("if (existing?.machineId === body.machineId)");
    expect(backend).toContain("factoryPressingSessions.assignmentId, existing.id");
    expect(backend).not.toContain("ON CONFLICT");
  });

  it("refuses ineligible operators and locks deactivation to company and machine", () => {
    expect(backend).toContain("OPERATOR_NOT_ELIGIBLE");
    expect(backend).toContain("OPERATOR_TAB_HIDDEN");
    expect(backend).toContain("OPERATOR_PAGE_HIDDEN");
    expect(backend).toContain("MACHINE_INACTIVE");
    expect(backend).toContain('for("update")');
    expect(backend).toContain("factoryPressingMachines.companyId, ctx.companyId");
    expect(backend).toContain('action: "permission_change"');
  });

  it("does not post inventory or change pressing confirmation lifecycle", () => {
    expect(backend).not.toMatch(/(?:update|insert|delete)\(factoryBales\)/);
    expect(backend).not.toMatch(/(?:update|insert|delete)\(factoryPressingConfirmations\)/);
    expect(backend).not.toMatch(/adjustInventory|postStockMovementTx|writeDaybookEntry/);
  });
});
