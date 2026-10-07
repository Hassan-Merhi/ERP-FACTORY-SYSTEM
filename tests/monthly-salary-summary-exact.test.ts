/**
 * The monthly salary summary prorates exactly: on the last day of the month a
 * worker on 0.1 base and 0.2 transport is owed 0.3 (the float sum was
 * 0.30000000000000004).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "factory_workers":
        return [{ id: 1, fullName: "Worker", baseSalary: "0.1", transportAllowance: "0.2", salaryType: "Monthly" }];
      case "employees":
        return [{ id: 2, firstName: "Emp", lastName: "One", monthlySalary: "0.3", currentBalance: "0.7" }];
      default:
        return [];
    }
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    q.where = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      execute: async () => ({ rows: [{}] }),
      select: () => ({ from: (table: never) => chain(rowsFor(table)) }),
    },
  };
});

import { registerEmployeeAttendanceRoutes } from "../server/routes/factory/employee-pos/employeeAttendanceRoutes";

describe("monthly salary summary", () => {
  it("prorates salary and transport exactly", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerEmployeeAttendanceRoutes({
      get: (path: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => handlers.set(path, h),
    } as never);
    let body: { workerBreakdown: unknown[]; employeeBreakdown: unknown[] } = {
      workerBreakdown: [],
      employeeBreakdown: [],
    };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/monthly-salary-summary")!(
      { query: { date: "2026-09-30", includeBreakdown: "true" }, session: { currentCompanyId: 7 } },
      res
    );

    expect(body.workerBreakdown).toEqual([
      { id: 1, name: "Worker", baseSalary: 0.1, transport: 0.2, expected: 0.1, transportProrated: 0.2, total: 0.3 },
    ]);
    expect(body.employeeBreakdown).toEqual([
      { id: 2, name: "Emp One", monthlySalary: 0.3, expected: 0.3, balance: 0.7 },
    ]);
  });
});
