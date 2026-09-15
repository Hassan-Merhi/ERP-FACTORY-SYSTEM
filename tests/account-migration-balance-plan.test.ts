import { describe, expect, it } from "vitest";
import {
  buildMigrationVoucherPlan,
  migrationClearingAmounts,
  migrationDestinationTotal,
  type MigrationEntryLike,
} from "../server/routes/admin/accountMigrationBalancePlan";

function entry(overrides: Partial<MigrationEntryLike> = {}): MigrationEntryLike {
  return {
    id: 1,
    voucherId: 10,
    ledgerAccountId: 100,
    debitAmount: "0.00",
    creditAmount: "0.00",
    ...overrides,
  };
}

describe("balanced account migration voucher planning", () => {
  it("moves a voucher intact when every accounting dimension belongs to the migrated account set", () => {
    const plan = buildMigrationVoucherPlan(
      10,
      [
        entry({ id: 1, ledgerAccountId: 100, debitAmount: "125.00" }),
        entry({ id: 2, ledgerAccountId: 101, creditAmount: "125.00" }),
      ],
      new Set([100, 101]),
    );

    expect(plan.isExclusive).toBe(true);
    expect(plan.selectedEntries).toHaveLength(2);
    expect(plan.net).toBe(0);
    expect(migrationClearingAmounts(plan)).toBeNull();
    expect(migrationDestinationTotal(plan)).toBe("125.00");
  });

  it("splits a shared voucher and creates the opposite clearing side for the destination", () => {
    const plan = buildMigrationVoucherPlan(
      10,
      [
        entry({ id: 1, ledgerAccountId: 100, debitAmount: "75.25" }),
        entry({ id: 2, ledgerAccountId: 999, creditAmount: "75.25" }),
      ],
      new Set([100]),
    );

    expect(plan.isExclusive).toBe(false);
    expect(plan.net).toBe(75.25);
    expect(migrationClearingAmounts(plan)).toEqual({ debitAmount: "0.00", creditAmount: "75.25" });
    expect(migrationDestinationTotal(plan)).toBe("75.25");
  });

  it("treats party, bank and asset references as shared even without another ledger account", () => {
    for (const dimension of [
      { supplierId: 7 },
      { employeeId: 8 },
      { customerId: 9 },
      { bankAccountId: 10 },
      { fixedAssetId: 11 },
      { factorySupplierId: 12 },
    ]) {
      const plan = buildMigrationVoucherPlan(
        10,
        [entry({ ledgerAccountId: 100, creditAmount: "20.00", ...dimension })],
        new Set([100]),
      );
      expect(plan.isExclusive).toBe(false);
      expect(migrationClearingAmounts(plan)).toEqual({ debitAmount: "20.00", creditAmount: "0.00" });
    }
  });
});
