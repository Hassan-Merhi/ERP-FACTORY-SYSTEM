/**
 * Regression tests for the "Set Today's Exchange Rate" popup being shared
 * company-wide instead of per-user/per-device.
 *
 * Root cause: (1) there was no DB uniqueness constraint on
 * (companyId, effectiveDate, fromCurrency, toCurrency), so concurrent saves
 * could create duplicate daily rows, and (2) the frontend's "Use Previous
 * Rate" button only closed the popup without saving anything, so no row was
 * ever created for "today" — meaning every other user (and the same user on
 * refresh) still saw hasRate:false and the popup kept reappearing.
 *
 * These tests exercise the backend/database source of truth directly:
 * GET /api/exchange-rates/check-today and the atomic upsert on
 * POST /api/exchange-rates.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";

const TEST_PREFIX = "xrpoptest";

let ctx: TestContext;
let agentA: request.SuperAgentTest;
let agentB: request.SuperAgentTest;
let userBId: string;

async function cleanupExchangeRates(companyIds: number[]) {
  for (const id of companyIds) {
    await pool.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [id]);
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);

  // MALI-equivalent test company: USD base, CFA display currency (mirrors the
  // real-world MALI/CFA scenario from the bug report).
  await db
    .update(schema.companies)
    .set({ baseCurrency: "USD", displayCurrency: "CFA" })
    .where(eq(schema.companies.id, ctx.companyId));

  // A second user in the SAME company — simulates "User B opens MALI from
  // another session/device".
  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.hash("testpassword123", 10);
  const [userB] = await db
    .insert(schema.users)
    .values({ username: `${TEST_PREFIX}_userB`, password: hashedPassword })
    .returning();
  userBId = userB.id;
  await db.insert(schema.userCompanyRoles).values({
    userId: userB.id,
    companyId: ctx.companyId,
    role: "Admin",
  });

  agentA = request.agent(ctx.app);
  agentB = request.agent(ctx.app);

  await agentA.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agentA.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  await agentB.post("/api/auth/login").send({ username: `${TEST_PREFIX}_userB`, password: "testpassword123" });
  await agentB.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM login_history WHERE user_id = $1`, [userBId]);
  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.userId, userBId));
  await db.delete(schema.users).where(eq(schema.users.id, userBId));
  await cleanupExchangeRates([ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("Exchange rate is a shared company-wide record, not per-user", () => {
  it("User A opens MALI with no rate for today: popup should appear (hasRate=false)", async () => {
    const res = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(res.status).toBe(200);
    expect(res.body.hasRate).toBe(false);
    expect(typeof res.body.today).toBe("string");
  });

  it("User A sets today's rate to 592 CFA", async () => {
    // Read today first: Supertest 7.3 closes an agent's shared server once its last pending
    // request settles, so a request awaited inside another request's arguments closes the
    // server under the outer one.
    const today = (await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`)).body.today;
    const res = await agentA.post("/api/exchange-rates").send({
      fromCurrency: "USD",
      toCurrency: "CFA",
      rate: "592",
      effectiveDate: today,
    });
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.rate)).toBeCloseTo(592, 4);
  });

  it("User B opens MALI from another session: popup does not appear and 592 is loaded", async () => {
    const res = await agentB.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(res.status).toBe(200);
    expect(res.body.hasRate).toBe(true);
    expect(parseFloat(res.body.latestRate.rate)).toBeCloseTo(592, 4);
  });

  it("User A refreshes / re-checks: popup does not appear again", async () => {
    const res = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(res.status).toBe(200);
    expect(res.body.hasRate).toBe(true);
  });

  it("User B navigating between pages (repeated checks) never reopens the popup", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await agentB.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
      expect(res.body.hasRate).toBe(true);
    }
  });

  it("a different company without today's rate still receives its own popup (company isolation)", async () => {
    const [otherCompany] = await db
      .insert(schema.companies)
      .values({
        code: `${TEST_PREFIX}OTH`.slice(0, 8).toUpperCase(),
        name: `${TEST_PREFIX}_OtherCompany`,
        baseCurrency: "USD",
        displayCurrency: "CFA",
      })
      .returning();

    try {
      await db.insert(schema.userCompanyRoles).values({
        userId: ctx.userId,
        companyId: otherCompany.id,
        role: "Admin",
      });

      // Membership alone no longer lets a request name another company: the
      // tenant boundary requires the active company to be switched first, so a
      // primary companyId that disagrees with the session fails closed even for
      // an Admin who genuinely belongs to the target company.
      const foreign = await agentA.get(`/api/exchange-rates/check-today?companyId=${otherCompany.id}`);
      expect(foreign.status).toBe(403);

      // Switching the active company is the supported route, and it gives the
      // other company its own popup rather than MALI's answer.
      await agentA.post("/api/auth/set-company").send({ companyId: otherCompany.id });
      const res = await agentA.get(`/api/exchange-rates/check-today?companyId=${otherCompany.id}`);
      expect(res.status).toBe(200);
      expect(res.body.hasRate).toBe(false);

      // MALI's own rate must be unaffected once the session switches back.
      await agentA.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      const maliRes = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
      expect(maliRes.body.hasRate).toBe(true);
    } finally {
      await agentA.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      await cleanupExchangeRates([otherCompany.id]);
      await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.companyId, otherCompany.id));
      await db.delete(schema.companies).where(eq(schema.companies.id, otherCompany.id));
    }
  });

  it("on the next business date, MALI receives the popup again if no new daily rate exists", async () => {
    // Simulate "today" having no rate by checking against a future date directly
    // via storage, since we can't fast-forward the real clock in this test.
    const futureDate = "2099-01-01";
    const { storage } = await import("../server/storage");
    const hasRateForFuture = await storage.getExchangeRateForExactDate(ctx.companyId, "USD", "CFA", futureDate);
    expect(hasRateForFuture).toBeUndefined();
  });

  it("'Use Previous Rate' creates today's shared company rate and suppresses the popup for all MALI users", async () => {
    // Reset today's rate to simulate a fresh day with no rate yet, but a
    // previous day's rate available to copy from.
    await cleanupExchangeRates([ctx.companyId]);
    await db.insert(schema.exchangeRates).values({
      companyId: ctx.companyId,
      fromCurrency: "USD",
      toCurrency: "CFA",
      rate: "590",
      effectiveDate: "2020-01-01",
    });

    const checkRes = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(checkRes.body.hasRate).toBe(false);
    expect(parseFloat(checkRes.body.latestRate.rate)).toBeCloseTo(590, 4);

    // Frontend's handleUsePrevious posts the previous value for today's business date.
    const useRes = await agentA.post("/api/exchange-rates").send({
      fromCurrency: "USD",
      toCurrency: "CFA",
      rate: String(parseFloat(checkRes.body.latestRate.rate)),
      effectiveDate: checkRes.body.today,
    });
    expect(useRes.status).toBe(200);

    const afterA = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(afterA.body.hasRate).toBe(true);

    const afterB = await agentB.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    expect(afterB.body.hasRate).toBe(true);
    expect(parseFloat(afterB.body.latestRate.rate)).toBeCloseTo(590, 4);
  });

  it("concurrent saves for the same day never create duplicate rows (atomic upsert)", async () => {
    await cleanupExchangeRates([ctx.companyId]);
    const today = (await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`)).body.today;

    await Promise.all([
      agentA
        .post("/api/exchange-rates")
        .send({ fromCurrency: "USD", toCurrency: "CFA", rate: "600", effectiveDate: today }),
      agentB
        .post("/api/exchange-rates")
        .send({ fromCurrency: "USD", toCurrency: "CFA", rate: "610", effectiveDate: today }),
    ]);

    const rows = await db.select().from(schema.exchangeRates).where(eq(schema.exchangeRates.companyId, ctx.companyId));
    const todaysRows = rows.filter((r) => r.effectiveDate === today);
    expect(todaysRows.length).toBe(1);
    expect(["600.000000", "610.000000"]).toContain(parseFloat(todaysRows[0].rate).toFixed(6));
  });

  it("the DB rejects a manual duplicate insert for the same (company, date, pair)", async () => {
    await cleanupExchangeRates([ctx.companyId]);
    const checkRes = await agentA.get(`/api/exchange-rates/check-today?companyId=${ctx.companyId}`);
    const today: string = checkRes.body.today;
    expect(typeof today).toBe("string");

    await db.insert(schema.exchangeRates).values({
      companyId: ctx.companyId,
      fromCurrency: "USD",
      toCurrency: "CFA",
      rate: "601",
      effectiveDate: today,
    });

    await expect(
      db.insert(schema.exchangeRates).values({
        companyId: ctx.companyId,
        fromCurrency: "USD",
        toCurrency: "CFA",
        rate: "602",
        effectiveDate: today,
      })
    ).rejects.toThrow();
  });
});
