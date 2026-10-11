/**
 * Optional (provisional) vouchers are not posted: they may be unbalanced by
 * design and every ledger balance excludes them. The factory employee balance
 * recalculation counted them anyway, so recalculating moved an employee's
 * balance by the amount of any provisional voucher. Both recalculation
 * endpoints must agree with live posting, which never syncs optional vouchers.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "optvoucherbal";

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
      openingBalance: "10.00",
    })
    .returning();
  employeeId = employee.id;

  await postEmployeeCredit(`${TEST_PREFIX}-ACTIVE`, "100.00", false);
  await postEmployeeCredit(`${TEST_PREFIX}-DRAFT`, "50.00", true);
}, 90000);

afterAll(async () => {
  // cleanupTestData deletes every line of the company's vouchers together and
  // only then the employees; deleting the employee's lines on their own would
  // leave each voucher one-sided, which the voucher balance guard refuses.
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("employee balance recalculation ignores optional vouchers", () => {
  it("for one employee", async () => {
    const response = await agent.post(`/api/factory/employees/${employeeId}/recalculate-balance`);
    expect(response.status).toBe(200);
    expect(response.body.newBalance).toBeCloseTo(110, 2);
    expect(response.body.newDeposits).toBeCloseTo(100, 2);
  });

  it("for every employee in the company", async () => {
    await db.update(schema.employees).set({ currentBalance: "0" }).where(eq(schema.employees.id, employeeId));
    const response = await agent.post("/api/factory/employees/recalculate-balances");
    expect(response.status).toBe(200);
    const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId));
    expect(Number(employee.currentBalance)).toBeCloseTo(110, 2);
  });
});

describe("factory cash account balance", () => {
  it("excludes optional and deleted vouchers", async () => {
    const before = await agent.get(`/api/factory/cash-account-balance/${ctx.cashAccountId}`);
    expect(before.status).toBe(200);
    const start = Number(before.body.balance);

    await postEmployeeCredit(`${TEST_PREFIX}-CASH-ACTIVE`, "20.00", false);
    await postEmployeeCredit(`${TEST_PREFIX}-CASH-DRAFT`, "7.00", true);
    await postEmployeeCredit(`${TEST_PREFIX}-CASH-DELETED`, "3.00", false);
    await db
      .update(schema.vouchers)
      .set({ deletedAt: new Date() })
      .where(eq(schema.vouchers.voucherNumber, `${TEST_PREFIX}-CASH-DELETED`));

    const after = await agent.get(`/api/factory/cash-account-balance/${ctx.cashAccountId}`);
    expect(after.status).toBe(200);
    expect(Number(after.body.balance) - start).toBeCloseTo(20, 2);
  });
});
