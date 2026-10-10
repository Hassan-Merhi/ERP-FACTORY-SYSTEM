/**
 * Characterization: employee balance recalculation rebuilds opening + credits
 * - debits as decimals and stores cents. Voucher entries are stored at two
 * decimals, so the 1.005 credit lands as 1.01 and the rebuilt balance,
 * deposits and the numeric response all carry exactly 1.01.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "emprecalcexact";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;

async function postEmployeeCredit(number: string, amount: string, optional: boolean) {
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherNumber: number,
      voucherType: "Journal",
      voucherDate: "2026-05-01",
      totalAmount: amount,
      optional,
    })
    .returning();
  await db.insert(schema.voucherEntries).values([
    { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, debitAmount: amount, creditAmount: "0" },
    { voucherId: voucher.id, employeeId, debitAmount: "0", creditAmount: amount },
  ]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await db.update(schema.companies).set({ companyType: "factory" }).where(eq(schema.companies.id, ctx.companyId));
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const [employee] = await db
    .insert(schema.employees)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}-EMP1`,
      firstName: "Opt",
      lastName: "Voucher",
      joinDate: "2026-01-01",
      employeeType: "Employee",
      openingBalance: "0.00",
    })
    .returning();
  employeeId = employee.id;

  await postEmployeeCredit(`${TEST_PREFIX}-HALF`, "1.005", false);
}, 90000);

afterAll(async () => {
  // cleanupTestData deletes every line of the company's vouchers together and
  // only then the employees; deleting the employee's lines on their own would
  // leave each voucher one-sided, which the voucher balance guard refuses.
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("employee balance recalculation is exact", () => {
  it("for one employee", async () => {
    const response = await agent.post(`/api/factory/employees/${employeeId}/recalculate-balance`);
    expect(response.status).toBe(200);
    expect(response.body.newBalance).toBe(1.01);
    const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId));
    expect(employee.currentBalance).toBe("1.01");
    expect(employee.totalDeposits).toBe("1.01");
  });

  it("for every employee in the company", async () => {
    await db.update(schema.employees).set({ currentBalance: "0" }).where(eq(schema.employees.id, employeeId));
    const response = await agent.post("/api/factory/employees/recalculate-balances");
    expect(response.status).toBe(200);
    const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId));
    expect(employee.currentBalance).toBe("1.01");
  });
});
