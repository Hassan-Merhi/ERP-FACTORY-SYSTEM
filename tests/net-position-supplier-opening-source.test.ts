import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("ERP Net Position supplier opening balances", () => {
  it("loads company-owned suppliers even when they have no voucher activity", () => {
    const live = read("server/routes/stats/statsNetProfitRoutes.ts");
    const excel = read("server/routes/stats/statsNetPositionRoutes.ts");

    for (const source of [live, excel]) {
      expect(source).toContain("companyScopedSuppliers.companyId, companyId");
      expect(source).toContain('supplierBalances.get(sup.id) || { debit: 0, credit: 0 }');
      expect(source).toContain('parseFloat(sup.openingBalance || "0")');
      expect(source).not.toContain("supplierIdsWithBalance");
    }
  });

  it("keeps supplier reads tenant-scoped instead of reading unrelated supplier masters", () => {
    const live = read("server/routes/stats/statsNetProfitRoutes.ts");
    const excel = read("server/routes/stats/statsNetPositionRoutes.ts");

    expect(live).toContain('from(companyScopedSuppliers)');
    expect(excel).toContain('from(companyScopedSuppliers)');
    expect(live).toContain("eq(companyScopedSuppliers.companyId, companyId)");
    expect(excel).toContain("eq(companyScopedSuppliers.companyId, companyId)");
  });
});
