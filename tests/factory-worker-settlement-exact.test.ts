/**
 * Contract settlement prices earned pay exactly: 1.3 hours at 0.35/hour is
 * 0.455, reported and stored as 0.46. The float product 0.45499999999999996
 * printed 0.45.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/routes/factory-workers/_helpers", () => ({
  checkFactoryWorkerContractAccess: () => true,
  computeMonthlyPay: () => 0,
  computeMonthlyPayFromAttendance: () => 0,
  getFactoryCompanyId: () => 7,
  writeDaybookEntry: async () => undefined,
}));
vi.mock("../server/lib/factoryWorkerCategoryMembership", () => ({ removeFactoryWorkerFromCategories: async () => [] }));

import { getTableName } from "drizzle-orm";
import { registerFactoryWorkerBaleSettleRoutes } from "../server/routes/factory-workers/bales-settle";

const worker = {
  id: 5,
  fullName: "Test Worker",
  active: true,
  payFrequency: "Hourly",
  salaryType: "Monthly",
  hourlyRate: "0.35",
  baseSalary: "0",
  contractStartDate: null,
  dateJoined: null,
};

function fakeDb() {
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "orderBy", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    select: () => ({ from: (table: never) => chain(getTableName(table) === "factory_workers" ? [worker] : []) }),
  };
}

describe("worker contract settlement", () => {
  it("prices hourly pay exactly in the dry run", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerFactoryWorkerBaleSettleRoutes(
      {
        get: () => undefined,
        post: (path: string, ...rest: unknown[]) => handlers.set(path, rest[rest.length - 1] as never),
      } as never,
      (() => undefined) as never,
      fakeDb() as never
    );
    let body: Record<string, unknown> = {};
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/workers/:id/settle-and-end")!(
      {
        params: { id: "5" },
        body: { startDate: "2026-09-01", endDate: "2026-09-30", hoursWorked: "1.3", dryRun: true },
        session: {},
      },
      res
    );

    expect(body).toMatchObject({ earned: "0.46", paid: "0.00", advances: "0.00", balance: "0.46", dryRun: true });
  });
});
