/**
 * Payroll run items are stored at the exact cents of the submitted amounts,
 * and an amount that does not parse is rejected before anything is written.
 * The float path wrote parseFloat("333.335").toFixed(2) = "333.33", and an
 * unparsed amount as 'NaN' (which Postgres numeric accepts and which then
 * reached the payment voucher).
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ inserts: [] as [string, unknown][] }));

vi.mock("../server/auth", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return { requireAuth: pass, requireNonPOS: pass };
});
vi.mock("../server/routes/factoryWhatsappRoutes", () => ({
  triggerAccountWhatsAppStatement: async () => ({ sent: false }),
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    q.returning = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      insert: (table: never) => ({
        values: (values: unknown) => {
          harness.inserts.push([getTableName(table), values]);
          return chain([{ id: 3 }]);
        },
      }),
    },
  };
});

import { registerPayrollRunRoutes } from "../server/routes/erp-payroll/runs";

async function createRun(items: Record<string, unknown>[]) {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerPayrollRunRoutes({
    post: (path: string, ...handlers: never[]) => {
      if (path === "/api/payroll/runs") handler = handlers.at(-1);
    },
    get: () => undefined,
    patch: () => undefined,
  } as never);
  harness.inserts = [];
  let status = 200;
  await handler!(
    { body: { date: "2026-03-31", items }, session: { currentCompanyId: 7 } },
    { status: (code: number) => ((status = code), { json: () => undefined }), json: () => undefined }
  );
  return status;
}

const employee = (amounts: Record<string, unknown>) => ({ employeeId: 1, employeeName: "Sami", ...amounts });

describe("payroll run amounts", () => {
  it("stores each amount at its exact cents", async () => {
    expect(await createRun([employee({ baseSalary: "333.335", deduction: "1.005", netPay: "332.33" })])).toBe(200);

    const items = harness.inserts.find(([table]) => table === "erp_payroll_run_items")?.[1];
    expect(items).toEqual([
      {
        runId: 3,
        employeeId: 1,
        employeeName: "Sami",
        groupName: null,
        baseSalary: "333.34",
        deduction: "1.01",
        payrollDeduction: "0.00",
        netPay: "332.33",
      },
    ]);
  });

  it("rejects an amount that does not parse before writing the run", async () => {
    expect(await createRun([employee({ baseSalary: "1000", netPay: "abc" })])).toBe(400);
    expect(harness.inserts).toEqual([]);
  });
});
