/**
 * PATCH /api/factory/payroll/:id computes the edited payroll exactly and
 * stores each amount at the cent numeric(…, 2) keeps: an other bonus of 1.005
 * is 1.01 and the net moves by 1.01 (the float path stored 1.00).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ d: null as any, writes: [] as unknown[] }));
vi.mock("../server/routes/helpers/auditHelpers", () => ({
  logAudit: async (a: any) => void h.writes.push(["audit", a.changes]),
}));
vi.mock("../server/routes/factory-payroll/_helpers", () => ({
  writeDaybookEntry: async (_d: unknown, e: any) => void h.writes.push(["daybook", e.amountUsd]),
}));
vi.mock("../server/routes/payroll/_payrollAccountingHelper", () => ({
  rebuildPayrollGenVoucher: async () => void h.writes.push(["rebuild"]),
  findOrCreateLedger: async () => ({ id: 99 }),
}));
vi.mock("../server/services/payroll/productionBonusPayrollService", () => ({
  prepareProductionBonusesForPayroll: async () => undefined,
  getProductionBonusTotalsForPayrollIds: async () => new Map([[1, h.d.totals]]),
}));
vi.mock("../server/routes/factory/_helpers", () => ({ checkFactoryAdmin: () => true }));
vi.mock("../server/db", () => ({ db: {} }));

import { getTableName } from "drizzle-orm";
import { registerFactoryPayrollUpdateRoutes } from "../server/routes/factory-payroll/update";

const chain = (value: () => unknown) => {
  const q: any = {};
  // "for": the edit locks the payroll row (wave 7: one transaction).
  for (const step of ["where", "returning", "for"]) q[step] = () => q;
  q.then = (ok: any, bad: any) => Promise.resolve().then(value).then(ok, bad);
  return q;
};
const db: any = {
  select: () => ({
    from: (t: any) =>
      chain(() => {
        const n = getTableName(t);
        if (n === "factory_payrolls") return [h.d.payroll];
        if (n === "factory_advance_repayments") return h.d.repayments;
        if (n === "factory_worker_advances") return [h.d.advance];
        return [];
      }),
  }),
  update: (t: any) => ({
    set: (v: any) => {
      const { approvedAt, ...rest } = v;
      h.writes.push(["update", getTableName(t), rest]);
      return chain(() => [{ id: 1, ...rest }]);
    },
  }),
  delete: (t: any) => ({
    where: () => {
      h.writes.push(["delete", getTableName(t)]);
      return Promise.resolve();
    },
  }),
};
db.transaction = async (fn: any) => fn(db);

describe("factory payroll edit", () => {
  it("stores half-cent edits at the cent Postgres would keep", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    const register =
      (method: string) => (path: string, _auth: unknown, handler: (req: unknown, res: unknown) => Promise<void>) =>
        handlers.set(method + path, handler);
    registerFactoryPayrollUpdateRoutes(
      { patch: register("PATCH"), post: register("POST") } as never,
      (() => undefined) as never,
      db
    );
    h.d = {
      totals: { approved: 0, pending: 0, pendingCount: 0 },
      payroll: {
        id: 1,
        companyId: 7,
        workerId: 3,
        status: "DRAFT",
        bonuses: "0",
        deductions: "0",
        advances: "0",
        overtimePay: "0",
        overtimeHours: "0",
        netSalary: "100.00",
      },
    };
    h.writes = [];
    let body: Record<string, unknown> = {};
    const res = {
      status: () => res,
      json: (value: Record<string, unknown>) => {
        body = value;
        return res;
      },
    };
    await handlers.get("PATCH/api/factory/payroll/:id")!(
      {
        params: { id: "1" },
        session: { currentCompanyId: 7, userId: 1 },
        body: { otherBonuses: "1.005" },
        headers: {},
      },
      res
    );
    // 1.005 is stored as 1.01 by numeric(…, 2); the float path wrote 1.00 and a net of 101.00.
    expect(body).toMatchObject({ bonuses: "1.01", netSalary: "101.01", otherBonuses: "1.01" });
  });

  it("rejects a value that does not parse", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    const register =
      (method: string) => (path: string, _auth: unknown, handler: (req: unknown, res: unknown) => Promise<void>) =>
        handlers.set(method + path, handler);
    registerFactoryPayrollUpdateRoutes(
      { patch: register("PATCH"), post: register("POST") } as never,
      (() => undefined) as never,
      db
    );
    let status = 200;
    const res = {
      status: (code: number) => {
        status = code;
        return res;
      },
      json: () => res,
    };
    await handlers.get("PATCH/api/factory/payroll/:id")!(
      { params: { id: "1" }, session: { currentCompanyId: 7, userId: 1 }, body: { deductions: "abc" }, headers: {} },
      res
    );
    expect(status).toBe(400);
  });
});
