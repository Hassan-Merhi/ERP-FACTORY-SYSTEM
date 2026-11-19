import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const lineCount = (file: string) => read(file).split(/\r?\n/).length;

describe("Phase 7 debug route architecture", () => {
  it("keeps debugRoutes as a composition-only facade in the original registration order", () => {
    const source = read("server/routes/debugRoutes.ts");
    const registrations = [
      "registerInventoryDebugRoutes(app);",
      "registerImportCycleDiagnosticRoutes(app);",
      "registerOrphanedChargeVoucherRoutes(app);",
      "registerOffloadRoutes(app);",
      "registerFactoryOrderRepairRoutes(app);",
    ];

    expect(lineCount("server/routes/debugRoutes.ts")).toBeLessThanOrEqual(20);
    expect(source).not.toContain("app.get(");
    expect(source).not.toContain("app.post(");
    expect(source).not.toContain("@shared/schema");
    expect(source).not.toContain("drizzle-orm");
    expect(registrations.map((registration) => source.indexOf(registration))).toEqual(
      [...registrations.map((registration) => source.indexOf(registration))].sort((a, b) => a - b)
    );
  });

  it("preserves every extracted endpoint and role boundary", () => {
    const inventory = read("server/routes/debug/inventoryDebugRoutes.ts");
    expect(inventory).toContain("/api/debug/inventory/:stockItemId");
    expect(inventory).toContain('requireRole("Admin", "Developer", "Owner")');

    const importCycle = read("server/routes/debug/importCycleDiagnosticRoutes.ts");
    expect(importCycle).toContain("/api/debug/import-cycle");
    expect(importCycle).toContain('requireRole("Admin")');

    const orphaned = read("server/routes/debug/orphanedChargeVoucherRoutes.ts");
    expect(orphaned).toContain("/api/debug/orphaned-charge-vouchers");
    expect(orphaned).toContain('requireRole("Admin", "Owner", "Manager")');
    expect(orphaned).toContain("/api/admin/fix-orphaned-charge-vouchers");

    const repair = read("server/routes/debug/factoryOrderRepairRoutes.ts");
    expect(repair).toContain("/api/admin/recalculate-factory-order-totals");
    expect(repair).toContain('requireRole("Admin", "Developer")');
  });

  it("keeps import-cycle collection and analysis independently bounded", () => {
    const foundation = read("server/routes/debug/importCycleDiagnosticFoundation.ts");
    const analysis = read("server/routes/debug/importCycleDiagnosticAnalysis.ts");

    expect(lineCount("server/routes/debug/importCycleDiagnosticFoundation.ts")).toBeLessThanOrEqual(650);
    expect(lineCount("server/routes/debug/importCycleDiagnosticAnalysis.ts")).toBeLessThanOrEqual(700);
    expect(foundation).toContain("collectImportCycleBalanceSnapshot");
    expect(foundation).toContain("netImportCycleBalance");
    expect(analysis).toContain("buildImportCycleDiagnostics");
    expect(analysis).toContain("containerAudit");
  });
});
