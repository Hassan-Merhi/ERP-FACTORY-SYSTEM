import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calculateProductionBonusPreview: vi.fn(),
  rebuildPayrollGenVoucher: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("../server/lib/sqlArray", () => ({ sqlArray: (values: unknown[]) => values }));
vi.mock("../server/routes/payroll/_payrollAccountingHelper", () => ({
  rebuildPayrollGenVoucher: harness.rebuildPayrollGenVoucher,
}));
vi.mock("../server/services/factory/productionBonusPreview", () => ({
  calculateProductionBonusPreview: harness.calculateProductionBonusPreview,
}));

import {
  attachProductionBonusesToPayroll,
  getProductionBonusDetailsForPayroll,
  getProductionBonusTotalsForPayrollIds,
  prepareProductionBonusesForPayroll,
  syncProductionBonusProposalsForPeriod,
  updateProductionBonusRunStatuses,
} from "../server/services/payroll/productionBonusPayrollService";

function executorWith(...results: unknown[]) {
  return {
    execute: vi.fn(async () => results.shift() ?? { rows: [] }),
  };
}

describe("production bonus payroll integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.calculateProductionBonusPreview.mockReturnValue({
      extraBales: 3,
      bonusPool: 30,
      distributable: true,
      allocations: [
        { workerId: 1, workerName: "Ada", amount: 15 },
        { workerId: 2, workerName: "Benoit", amount: 15 },
      ],
    });
    harness.rebuildPayrollGenVoucher.mockResolvedValue(undefined);
  });

  it("upserts a saved production plan proposal and replaces its pending worker allocations", async () => {
    const executor = executorWith(
      {
        rows: [
          {
            planId: 10,
            planEntryId: 11,
            productionDate: "2026-08-10",
            positionId: 12,
            positionName: "Press 1",
            targetBales: 10,
            bonusPerExtraBale: "10",
            bonusEnabled: true,
            members: JSON.stringify([
              { workerId: 2, workerName: "Benoit" },
              { workerId: 1, workerName: "Ada" },
            ]),
          },
        ],
      },
      { rows: [{ productionDate: "2026-08-10", positionId: 12, actualBales: 13 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 50 }] },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    await syncProductionBonusProposalsForPeriod(executor, 4, "2026-08-01", "2026-08-31");

    expect(harness.calculateProductionBonusPreview).toHaveBeenCalledWith({
      targetBales: 10,
      actualBales: 13,
      bonusPerExtraBale: 10,
      bonusEnabled: true,
      members: [
        { workerId: 1, workerName: "Ada" },
        { workerId: 2, workerName: "Benoit" },
      ],
    });
    expect(executor.execute).toHaveBeenCalledTimes(8);
  });

  it("attaches an approved orphan allocation by delta and rebuilds the normal payroll voucher", async () => {
    const executor = executorWith(
      {
        rows: [
          {
            id: 70,
            companyId: 4,
            workerId: 1,
            periodStart: "2026-08-01",
            periodEnd: "2026-08-31",
            status: "DRAFT",
            bonuses: "5",
            netSalary: "100",
          },
        ],
      },
      {
        rows: [
          {
            payrollId: 70,
            approved: "0",
            pending: "5",
            rejected: "0",
            totalSuggested: "5",
            pendingCount: 1,
            approvedCount: 0,
            rejectedCount: 0,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            payrollId: 70,
            approved: "15",
            pending: "0",
            rejected: "0",
            totalSuggested: "15",
            pendingCount: 0,
            approvedCount: 1,
            rejectedCount: 0,
          },
        ],
      },
      { rows: [] }
    );

    await attachProductionBonusesToPayroll(executor, 70);

    expect(executor.execute).toHaveBeenCalledTimes(5);
    expect(harness.rebuildPayrollGenVoucher).toHaveBeenCalledWith(executor, 4, "2026-08-01", "2026-08-31");
  });

  it("loads typed totals/details while leaving a paid payroll immutable", async () => {
    const executor = executorWith(
      { rows: [{ companyId: 4, periodStart: "2026-08-01", periodEnd: "2026-08-31", status: "PAID" }] },
      {
        rows: [
          {
            allocationId: 1,
            runId: 50,
            productionDate: "2026-08-10",
            positionId: 12,
            positionName: "Press 1",
            targetBales: 10,
            actualBales: 13,
            extraBales: 3,
            rate: "10",
            bonusPool: "30",
            memberCount: 2,
            workerId: 1,
            workerName: "Ada",
            amount: "15",
            decisionStatus: "APPROVED",
            decidedBy: "manager",
            decidedAt: "2026-08-11",
            decisionNote: "Validated output",
          },
        ],
      },
      {
        rows: [
          {
            payrollId: 70,
            approved: "15",
            pending: "0",
            rejected: "0",
            totalSuggested: "15",
            pendingCount: 0,
            approvedCount: 1,
            rejectedCount: 0,
          },
        ],
      }
    );

    const result = await getProductionBonusDetailsForPayroll(executor, 70);

    expect(result).toEqual({
      totals: {
        approved: 15,
        pending: 0,
        rejected: 0,
        totalSuggested: 15,
        pendingCount: 0,
        approvedCount: 1,
        rejectedCount: 0,
      },
      allocations: [expect.objectContaining({ allocationId: 1, workerId: 1, amount: 15, decisionStatus: "APPROVED" })],
    });
    expect(executor.execute).toHaveBeenCalledTimes(3);
  });

  it("handles empty totals and updates each unique bonus-run aggregate status once", async () => {
    const executor = executorWith({ rows: [{ status: "PAID" }] }, { rows: [] }, { rows: [] });

    await expect(getProductionBonusTotalsForPayrollIds(executor, [])).resolves.toEqual(new Map());
    await prepareProductionBonusesForPayroll(executor, 90);
    await updateProductionBonusRunStatuses(executor, [50, 50, 51]);

    expect(executor.execute).toHaveBeenCalledTimes(3);
  });
});
