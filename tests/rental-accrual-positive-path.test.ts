import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const queryResults: unknown[][] = [];
  const executeResults: Array<{ rows: unknown[] }> = [];
  const voucherValues: unknown[] = [];
  const voucherEntryValues: unknown[] = [];
  const ledgerUpdates: unknown[] = [];
  let voucherId = 900;

  const tables = {
    propertyUnits: {
      id: "propertyUnits.id",
      unitType: "propertyUnits.unitType",
      unitNumber: "propertyUnits.unitNumber",
    },
    propertyContracts: {
      id: "propertyContracts.id",
      companyId: "propertyContracts.companyId",
      linkedCompanyId: "propertyContracts.linkedCompanyId",
      module: "propertyContracts.module",
      status: "propertyContracts.status",
      unitId: "propertyContracts.unitId",
      startDate: "propertyContracts.startDate",
      currency: "propertyContracts.currency",
    },
    propertyMonthlyLedger: {
      id: "propertyMonthlyLedger.id",
      contractId: "propertyMonthlyLedger.contractId",
      accrualVoucherId: "propertyMonthlyLedger.accrualVoucherId",
      usedPrepaidAccount: "propertyMonthlyLedger.usedPrepaidAccount",
      usedAdvanceAccount: "propertyMonthlyLedger.usedAdvanceAccount",
      expectedAmount: "propertyMonthlyLedger.expectedAmount",
      paidAmount: "propertyMonthlyLedger.paidAmount",
      year: "propertyMonthlyLedger.year",
      month: "propertyMonthlyLedger.month",
    },
    vouchers: { name: "vouchers" },
    voucherEntries: { name: "voucherEntries" },
  };

  const select = vi.fn(() => {
    const result = queryResults.shift() ?? [];
    const builder = {
      innerJoin: () => builder,
      where: () => builder,
      groupBy: async () => result,
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return { from: () => builder };
  });

  const tx = {
    execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (table === tables.vouchers) voucherValues.push(values);
        if (table === tables.voucherEntries) voucherEntryValues.push(values);
        const persisted = [{ id: ++voucherId }];
        return {
          returning: vi.fn(async () => persisted),
          then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          ledgerUpdates.push(values);
        }),
      })),
    })),
  };

  return {
    tables,
    queryResults,
    executeResults,
    voucherValues,
    voucherEntryValues,
    ledgerUpdates,
    select,
    tx,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    ensureMonthlyLedgerRows: vi.fn(),
    findOrCreateLedgerAccount: vi.fn(),
    isRentalPeriodDue: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() },
    writeAuditEvent: vi.fn(),
  };
});

vi.mock("../server/db", () => ({
  db: { select: harness.select, transaction: harness.transaction },
}));
vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));
// Wave 18 A: each accrual voucher is audited in its posting transaction.
vi.mock("../server/services/audit", () => ({ writeAuditEvent: harness.writeAuditEvent }));
vi.mock("../server/services/rental/rentalPeriodService", () => ({
  getUtcTodayString: () => "2026-08-11",
  isRentalPeriodDue: harness.isRentalPeriodDue,
}));
vi.mock("../server/routes/rental/shared/ledger", () => ({
  RentalModule: {},
  findOrCreateLedgerAccount: harness.findOrCreateLedgerAccount,
}));
vi.mock("../server/routes/rental/shared/monthly-rows", () => ({
  ensureMonthlyLedgerRows: harness.ensureMonthlyLedgerRows,
}));
vi.mock("@shared/schema", () => harness.tables);
vi.mock("drizzle-orm", () => {
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), {
    raw: (value: string) => ({ raw: value }),
  });
  return {
    eq: (column: unknown, value: unknown) => ({ column, value }),
    and: (...conditions: unknown[]) => conditions,
    inArray: (column: unknown, values: unknown[]) => ({ column, values }),
    isNull: (column: unknown) => ({ column, value: null }),
    isNotNull: (column: unknown) => ({ column, operation: "not-null" }),
    ne: (column: unknown, value: unknown) => ({ column, operation: "ne", value }),
    sql,
  };
});

import {
  ensureMonthlyForCompany,
  postRentAccrualForCompany,
  postRentAccrualForContract,
} from "../server/routes/rental/shared/accrual";

describe("rental accrual positive paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queryResults.splice(0);
    harness.executeResults.splice(0);
    harness.voucherValues.splice(0);
    harness.voucherEntryValues.splice(0);
    harness.ledgerUpdates.splice(0);
    harness.isRentalPeriodDue.mockReturnValue(true);
    harness.findOrCreateLedgerAccount.mockImplementation(
      async (_tx: unknown, _companyId: number, name: string) =>
        ({
          "Shop Rent Expense": 401,
          "Accrued Rent Payable": 402,
          "Advance Rent Paid": 403,
          "Prepaid Rent": 404,
          "Rental Income": 405,
          "Deferred Rent Revenue": 406,
        })[name] ?? 499
    );
  });

  it("ensures monthly rows for every active company contract", async () => {
    harness.queryResults.push([{ id: 10 }, { id: 20 }]);

    await ensureMonthlyForCompany(4, "ERP", "2026-08-11");

    expect(harness.ensureMonthlyLedgerRows).toHaveBeenNthCalledWith(1, 10, "2026-08-11");
    expect(harness.ensureMonthlyLedgerRows).toHaveBeenNthCalledWith(2, 20, "2026-08-11");
  });

  it("posts the standard, advance, prepaid, and landlord-recognition journals in one deterministic run", async () => {
    harness.queryResults.push(
      [{ id: 1, unitId: 101, unitNumber: "Shop A", startDate: "2026-01-05", currency: "USD" }],
      [
        { id: 1, unitId: 101, unitNumber: "Shop A duplicate", startDate: "2026-01-05", currency: "USD" },
        { id: 2, unitId: 102, unitNumber: "Shop B", startDate: "2026-02-10", currency: "EUR" },
      ],
      [
        { id: 11, contractId: 1, unitId: 101, year: 2026, month: 8, expectedAmount: "100", paidAmount: "20" },
        { id: 12, contractId: 2, unitId: 102, year: 2026, month: 8, expectedAmount: "200", paidAmount: "0" },
      ],
      [
        { contractId: 1, expected: "100", paid: "20" },
        { contractId: 2, expected: "200", paid: "0" },
      ],
      [{ id: 99 }],
      [{ id: 13, contractId: 1, unitId: 101, year: 2026, month: 8, expectedAmount: "100", paidAmount: "60" }],
      [{ id: 14, contractId: 2, unitId: 102, year: 2026, month: 8, expectedAmount: "120", paidAmount: "80" }],
      [{ id: 3, unitId: 201, unitNumber: "Apartment A", startDate: "2026-03-01", currency: "EUR" }],
      [{ id: 15, contractId: 3, unitId: 201, year: 2026, month: 8, expectedAmount: "300", paidAmount: "150" }]
    );
    harness.executeResults.push(
      {
        rows: [
          { id: 11, expected_amount: "100", paid_amount: "20", unit_id: 101, month: 8, year: 2026 },
          { id: 12, expected_amount: "200", paid_amount: "0", unit_id: 102, month: 8, year: 2026 },
        ],
      },
      { rows: [{ ledger_row_id: 11, total_paid: "25" }] },
      { rows: [{ id: 13, expected_amount: "100", paid_amount: "60", unit_id: 101, month: 8, year: 2026 }] }
    );

    const result = await postRentAccrualForCompany(4, "Shop Rent Expense", "ERP", "Rental Income", "2026-08-11");

    expect(result).toEqual({ accrued: 4, skipped: 1 });
    expect(harness.transaction).toHaveBeenCalledTimes(4);
    expect(harness.writeAuditEvent).toHaveBeenCalledTimes(4);
    for (const [, executor] of harness.writeAuditEvent.mock.calls) expect(executor).toBe(harness.tx);
    expect(harness.voucherValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ description: "Rent accrual - 4 - 08/2026", totalAmount: "275", currency: "USD" }),
        expect.objectContaining({ description: "Advance rent recognition - 4 - 08/2026", totalAmount: "100" }),
        expect.objectContaining({ description: "Prepaid rent recognized - 4 - 08/2026", totalAmount: "120" }),
        expect.objectContaining({
          description: "Deferred rent recognized - 4 - 08/2026",
          totalAmount: "150",
          currency: "EUR",
        }),
      ])
    );
    const flattenedEntries = harness.voucherEntryValues.flat() as Array<Record<string, unknown>>;
    expect(flattenedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: 401, debitAmount: "75" }),
        expect.objectContaining({ ledgerAccountId: 402, creditAmount: "275" }),
        expect.objectContaining({ ledgerAccountId: 403, creditAmount: "60" }),
        expect.objectContaining({ ledgerAccountId: 404, creditAmount: "80.00" }),
        expect.objectContaining({ ledgerAccountId: 405, creditAmount: "150.00" }),
        expect.objectContaining({ ledgerAccountId: 406, debitAmount: "150.00" }),
      ])
    );
    expect(harness.ledgerUpdates).toHaveLength(4);
  });

  it("only delegates a contract accrual for an ERP shop owned by the selected company", async () => {
    harness.queryResults.push([], [{ id: 8, companyId: 4, unitId: 88 }], [{ unitType: "WAREHOUSE" }]);

    await expect(postRentAccrualForContract(999, "Shop Rent Expense")).resolves.toEqual({ accrued: 0, skipped: 0 });
    await expect(postRentAccrualForContract(8, "Shop Rent Expense")).resolves.toEqual({ accrued: 0, skipped: 0 });
  });
});
