/**
 * A non-USD journal voucher, posted or optional, writes its factory daybook amount from the stored
 * base total times the rate taken exactly: 1.13 USD at 1.5 is 1.695, stored as
 * 1.70. The float product 1.6949999999999998 was stored as 1.69.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db } from "../server/db";
import * as schema from "../shared/schema";

const TEST_PREFIX = "jvdbx";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await db.insert(schema.factorySettings).values({ companyId: ctx.companyId });
}, 60000);

afterAll(async () => {
  await db.delete(schema.factoryDaybookEntries).where(eq(schema.factoryDaybookEntries.companyId, ctx.companyId));
  await db.delete(schema.factorySettings).where(eq(schema.factorySettings.companyId, ctx.companyId));
  const vouchers = await db
    .select({ id: schema.vouchers.id })
    .from(schema.vouchers)
    .where(eq(schema.vouchers.companyId, ctx.companyId));
  for (const v of vouchers) {
    await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, v.id));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.id, v.id));
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("journal voucher daybook amount", () => {
  it.each([
    ["posted", false],
    ["optional", true],
  ])("multiplies the base total by the rate exactly for a %s journal", async (_label, optional) => {
    const res = await agent.post("/api/vouchers/journal").send({
      voucherDate: "2026-01-15",
      currency: "CFA",
      exchangeRate: "1.5",
      optional,
      entries: [
        { type: "DR", accountType: "ledger", accountId: ctx.cashAccountId, amount: "1.695" },
        { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount: "1.695" },
      ],
    });
    expect(res.status).toBeLessThan(300);
    const voucherId = res.body?.voucher?.id ?? res.body?.id;

    const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
    expect(voucher).toMatchObject({ totalAmount: "1.13", optional });
    const [daybook] = await db
      .select()
      .from(schema.factoryDaybookEntries)
      .where(
        and(
          eq(schema.factoryDaybookEntries.referenceTable, "vouchers"),
          eq(schema.factoryDaybookEntries.referenceId, voucherId)
        )
      );
    expect(daybook).toMatchObject({ amountCurrency: "1.70", amountUsd: "1.13" });
  });
});
