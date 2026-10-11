import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const tables = {
    factoryAttendance: {
      workerId: "factoryAttendance.workerId",
      status: "factoryAttendance.status",
      companyId: "factoryAttendance.companyId",
      attendanceDate: "factoryAttendance.attendanceDate",
    },
    factoryBales: {
      finalizedBy: "factoryBales.finalizedBy",
      weightKg: "factoryBales.weightKg",
      companyId: "factoryBales.companyId",
      status: "factoryBales.status",
      createdAt: "factoryBales.createdAt",
    },
    factoryPayrolls: {
      name: "factoryPayrolls",
      id: "factoryPayrolls.id",
      companyId: "factoryPayrolls.companyId",
      periodStart: "factoryPayrolls.periodStart",
      periodEnd: "factoryPayrolls.periodEnd",
      workerId: "factoryPayrolls.workerId",
    },
    factoryWorkerAdvances: {
      name: "factoryWorkerAdvances",
      id: "factoryWorkerAdvances.id",
      companyId: "factoryWorkerAdvances.companyId",
      workerId: "factoryWorkerAdvances.workerId",
      fullyPaid: "factoryWorkerAdvances.fullyPaid",
      repaymentType: "factoryWorkerAdvances.repaymentType",
    },
    factoryAdvanceRepayments: { name: "factoryAdvanceRepayments" },
    factoryWorkers: { id: "factoryWorkers.id", companyId: "factoryWorkers.companyId", active: "factoryWorkers.active" },
  };
  const selectResults: unknown[][] = [];
  const payrollReturning: unknown[][] = [];
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const updated: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => {
      const result = selectResults.shift() ?? [];
      const builder = {
        where: () => builder,
        orderBy: () => builder,
        for: async () => result,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return { from: () => builder };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserted.push({ table, values });
        return {
          returning: vi.fn(async () => (table === tables.factoryPayrolls ? (payrollReturning.shift() ?? []) : [])),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => updated.push({ table, values })),
      })),
    })),
  };
  return {
    tables,
    selectResults,
    payrollReturning,
    inserted,
    updated,
    tx,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    writeDaybookEntry: vi.fn(),
    syncProductionBonusProposalsForPeriod: vi.fn(),
    attachProductionBonusesToPayroll: vi.fn(),
    rebuildPayrollGenVoucher: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: { transaction: harness.transaction } }));
vi.mock("@shared/schema", () => harness.tables);
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  gte: (column: unknown, value: unknown) => ({ column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ column, values }),
  lte: (column: unknown, value: unknown) => ({ column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: harness.writeDaybookEntry }));
vi.mock("../server/services/payroll/productionBonusPayrollService", () => ({
  syncProductionBonusProposalsForPeriod: harness.syncProductionBonusProposalsForPeriod,
  attachProductionBonusesToPayroll: harness.attachProductionBonusesToPayroll,
}));

vi.mock("../server/routes/payroll/_payrollAccountingHelper", () => ({
  rebuildPayrollGenVoucher: harness.rebuildPayrollGenVoucher,
}));

import { generateFactoryPayrollBatch } from "../server/services/payroll/factoryPayrollGenerationService";

describe("factory payroll batch generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.payrollReturning.splice(0);
    harness.inserted.splice(0);
    harness.updated.splice(0);
    harness.writeDaybookEntry.mockResolvedValue({ id: 700 });
    harness.syncProductionBonusProposalsForPeriod.mockResolvedValue(undefined);
    harness.attachProductionBonusesToPayroll.mockResolvedValue(undefined);
  });

  it("generates only missing workers, attaches production bonuses, settles advances, and writes daybook evidence", async () => {
    const workers = [
      {
        id: 1,
        fullName: "Monthly Worker",
        employeeCode: "M-1",
        salaryType: "Monthly",
        baseSalary: "3100",
        perBaleRate: "0",
        perKgRate: "0",
        overtimeRate: "0",
      },
      {
        id: 2,
        fullName: "Bale Worker",
        employeeCode: "B-2",
        salaryType: "Per Bale",
        baseSalary: "0",
        perBaleRate: "25",
        perKgRate: "0",
        overtimeRate: "0",
      },
      { id: 3, fullName: "Existing Worker", employeeCode: "E-3", salaryType: "Daily", baseSalary: "10" },
    ];
    const existing = { id: 30, workerId: 3, netSalary: "100" };
    harness.selectResults.push(
      workers,
      [existing],
      [
        { finalizedBy: 2, weightKg: "80" },
        { finalizedBy: 2, weightKg: "90" },
      ],
      [
        { workerId: 1, status: "Present" },
        { workerId: 1, status: "Half Day" },
        { workerId: 1, status: "Absent" },
      ],
      [
        { id: 41, workerId: 1, remainingBalance: "100", fullyPaid: false },
        { id: 42, workerId: 1, remainingBalance: "50", fullyPaid: false },
      ],
      [{ id: 11, workerId: 1, netSalary: "0.00" }],
      [{ id: 12, workerId: 2, netSalary: "50.00" }]
    );
    harness.payrollReturning.push([{ id: 11, workerId: 1 }], [{ id: 12, workerId: 2 }]);

    const result = await generateFactoryPayrollBatch({
      companyId: 4,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      txDate: "2026-08-31",
      createdBy: "payroll-admin",
    });

    expect(result).toEqual({
      payrolls: [{ id: 11, workerId: 1, netSalary: "0.00" }, { id: 12, workerId: 2, netSalary: "50.00" }, existing],
      createdCount: 2,
      replayed: false,
    });
    expect(harness.syncProductionBonusProposalsForPeriod).toHaveBeenCalledWith(
      harness.tx,
      4,
      "2026-08-01",
      "2026-08-31"
    );
    expect(harness.attachProductionBonusesToPayroll).toHaveBeenNthCalledWith(1, harness.tx, 11);
    expect(harness.attachProductionBonusesToPayroll).toHaveBeenNthCalledWith(2, harness.tx, 12);
    expect(harness.inserted.filter(({ table }) => table === harness.tables.factoryAdvanceRepayments)).toHaveLength(2);
    expect(harness.updated.filter(({ table }) => table === harness.tables.factoryWorkerAdvances)).toHaveLength(2);
    expect(harness.writeDaybookEntry).toHaveBeenCalledTimes(2);
    // Wave 7: the period accrual (PAYROLL-GEN) is posted in the generation transaction.
    expect(harness.rebuildPayrollGenVoucher).toHaveBeenCalledWith(harness.tx, 4, "2026-08-01", "2026-08-31");
    expect(harness.writeDaybookEntry).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        txType: "PAYROLL_GENERATED",
        description: expect.stringContaining("Monthly Worker"),
        createdBy: "payroll-admin",
      })
    );
  });

  it("returns an idempotent replay when every active worker already has the period payroll", async () => {
    const worker = { id: 1, fullName: "Existing", salaryType: "Daily", baseSalary: "10" };
    const existing = { id: 11, workerId: 1, netSalary: "100" };
    harness.selectResults.push([worker], [existing]);

    const result = await generateFactoryPayrollBatch({
      companyId: 4,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      txDate: "2026-08-31",
    });

    expect(result).toEqual({ payrolls: [existing], createdCount: 0, replayed: true });
    expect(harness.syncProductionBonusProposalsForPeriod).not.toHaveBeenCalled();
    expect(harness.writeDaybookEntry).not.toHaveBeenCalled();
    expect(harness.rebuildPayrollGenVoucher).not.toHaveBeenCalled();
  });
});
