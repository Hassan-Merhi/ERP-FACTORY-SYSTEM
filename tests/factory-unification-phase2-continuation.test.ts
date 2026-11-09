import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey, isCompanySessionQueryKey } from "../client/src/lib/companyQueryScope";
import { factoryActionCapabilities } from "../shared/factoryActionCapabilities";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Factory Phase 2 continuation: selected-company source invariants", () => {
  it("isolates staff-tracking and attendance keys by company and preserves URL-first prefix", () => {
    const productionA = companyQueryKey("/api/factory/staff-tracking", 1, "production", "daily", "2026-11-09", "2026-11-09");
    const productionB = companyQueryKey("/api/factory/staff-tracking", 2, "production", "daily", "2026-11-09", "2026-11-09");
    expect(productionA[0]).toBe("/api/factory/staff-tracking");
    expect(productionA).not.toEqual(productionB);
    expect(companyQueryKey("/api/factory/attendance", 1, "2026-11-09")).not.toEqual(
      companyQueryKey("/api/factory/attendance", 2, "2026-11-09"),
    );
    expect(isCompanySessionQueryKey(productionA)).toBe(true);
  });

  it("keeps production-bonus management fail closed until same-company access is known", () => {
    for (const role of ["Admin", "Owner", "Developer", "View Only", "Create Only"]) {
      expect(factoryActionCapabilities({ role, hasFactoryAccess: false })["production.manage-bonuses"]).toBe(false);
    }
    expect(factoryActionCapabilities({ role: "Admin", hasFactoryAccess: true })["production.manage-bonuses"]).toBe(true);
    expect(factoryActionCapabilities({ role: "Owner", hasFactoryAccess: true })["production.manage-bonuses"]).toBe(true);
    expect(factoryActionCapabilities({ role: "Developer", hasFactoryAccess: true })["production.manage-bonuses"]).toBe(false);
  });

  it("pins company-scoped data dependencies on sensitive attendance and production views", () => {
    for (const path of [
      "client/src/pages/factory/FactoryAttendance.tsx",
      "client/src/pages/factory/FactoryProductionTargets.tsx",
      "client/src/pages/factory/FactoryLocationInventoryModel.tsx",
    ]) {
      const code = source(path);
      expect(code, path).toContain("companyQueryKey(");
      expect(code, path).toContain("selectedCompany?.id");
    }
    expect(source("client/src/pages/factory/FactoryAttendance.tsx")).toContain(
      'companyQueryKey("/api/factory/attendance", selectedCompany?.id, selectedDate)',
    );
    expect(source("client/src/pages/factory/FactoryProductionTargets.tsx")).toContain(
      "access?.companyId === selectedCompany?.id && access.hasFactoryAccess",
    );
  });

  it("pins company-matched authorization for visible nested hub tabs", () => {
    for (const path of [
      "client/src/pages/factory/FactoryInvoicing.tsx",
      "client/src/pages/factory/FactoryLoadingsHub.tsx",
      "client/src/pages/factory/FactoryDaybook.tsx",
      "client/src/pages/factory/FactoryAdvancesTab.tsx",
      "client/src/pages/factory/FactoryWorkersHub.tsx",
    ]) {
      const code = source(path);
      expect(code, path).toContain("myAccess?.companyId === selectedCompany?.id");
      expect(code, path).toContain("myAccess.hasFactoryAccess");
      expect(code, path).toContain('companyQueryKey("/api/factory/my-access", selectedCompany?.id)');
    }
  });
});
