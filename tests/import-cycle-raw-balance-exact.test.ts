/**
 * computeRawBalance (the import-cycle balance behind the recalculate endpoints)
 * sums every component exactly and rounds the result to the cent once, halves
 * toward +infinity as Math.round did. Stock of 1.5 units at 0.37 is worth
 * 0.555, which rounds to 0.56; the float path got 0.5549999… and 0.55.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined, requireRole: () => () => undefined }));
vi.mock("../server/routes/_helpers", () => ({ logAudit: async () => undefined }));
vi.mock("../server/storage", () => ({ storage: { getAllSuppliers: async () => [] } }));
// Wave 11: the stock on the floor is the one stock valuation (stockValuation.ts,
// SUM(total_value)), no longer quantity × average_rate from the inventory rows.
// It is mocked at 0.555 (1.5 units worth 0.37 each) to keep exercising the
// single rounding of the exact total.
vi.mock("../server/services/inventory/stockValuation", () => ({ companyStockValue: async () => "0.555" }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: never) => {
          if (fields && "totalCredit" in fields) return chain([{ totalCredit: "0", totalDebit: "0" }]);
          // Only the stock on the floor carries a value; every other balance is empty.
          return chain(getTableName(table) === "inventory" ? [{ quantity: "1.5", averageRate: "0.37" }] : []);
        },
      }),
    },
  };
});

import { computeRawBalance } from "../server/routes/admin/userManagementRoutes";

describe("import cycle raw balance", () => {
  it("rounds the exact total to the cent", async () => {
    expect(await computeRawBalance(7)).toBe(0.56);
  });
});
