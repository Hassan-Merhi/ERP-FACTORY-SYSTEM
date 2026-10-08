/**
 * The import-cycle diagnostic snapshot sums every component exactly and rounds
 * once at the end:
 * - stock of 1.5 units at 0.37 is worth 0.555, so the net balance is 0.56
 *   (the float path got 0.5549999… and 0.55);
 * - an unbalanced voucher's totals print at the cent from the exact value
 *   (1.005 prints as $1.01; the float path printed $1.00).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/storage", () => ({ storage: { getAllSuppliers: async () => [] } }));
vi.mock("../server/routes/helpers/supplierBalanceHelpers", () => ({ isParentCompanyContext: async () => false }));
// Wave 11: the stock on the floor is the one stock valuation (stockValuation.ts,
// SUM(total_value)), no longer quantity × average_rate from the inventory rows.
// It is mocked at 0.555 (1.5 units worth 0.37 each) to keep exercising the
// single rounding of the exact total.
vi.mock("../server/services/inventory/stockValuation", () => ({ companyStockValue: async () => "0.555" }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never, fields?: Record<string, unknown>) => {
    const name = getTableName(table);
    if (fields && "totalCredit" in fields && name === "voucher_entries") return [{ totalCredit: "0", totalDebit: "0" }];
    if (name === "vouchers") {
      return [{ voucherId: 1, voucherNumber: "JV-1", voucherType: "Journal", totalDebit: "1.005", totalCredit: "0" }];
    }
    // Only the stock on the floor (quantity and rate alone) carries a value.
    if (name === "inventory" && fields && Object.keys(fields).length === 2)
      return [{ quantity: "1.5", averageRate: "0.37" }];
    return [];
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin", "groupBy", "having"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: { select: (fields?: Record<string, unknown>) => ({ from: (table: never) => chain(rowsFor(table, fields)) }) },
  };
});

import { collectImportCycleBalanceSnapshot } from "../server/routes/debug/importCycleDiagnosticFoundation";

describe("import cycle diagnostic snapshot", () => {
  it("rounds the exact net balance to the cent", async () => {
    const snapshot = await collectImportCycleBalanceSnapshot(7);
    expect(snapshot.stockOnFloorValue).toBe(0.555);
    expect(snapshot.netImportCycleBalance).toBe(0.56);
  });

  it("prints unbalanced voucher totals at the cent of the exact value", async () => {
    const snapshot = await collectImportCycleBalanceSnapshot(7);
    const issue = snapshot.issues.find((i) => i.type === "unbalanced_voucher");
    expect(issue?.description).toBe("Unbalanced voucher: JV-1 (Journal) - Debits: $1.01, Credits: $0.00");
    expect(issue?.impact).toBe(1.005);
  });
});
