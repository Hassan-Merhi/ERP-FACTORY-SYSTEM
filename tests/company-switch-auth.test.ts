import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "companyswitch";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let secondCompanyId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const [secondCompany] = await db
    .insert(schema.companies)
    .values({
      code: "COSWITCH2",
      name: `${TEST_PREFIX}_SecondCompany`,
      baseCurrency: "USD",
    })
    .returning();
  secondCompanyId = secondCompany.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: secondCompanyId,
    role: "Admin",
  });
}, 60000);

afterAll(async () => {
  closeTestServer();

  try {
    await cleanupTestData(TEST_PREFIX);
  } catch (error) {
    // Login-history persistence is intentionally asynchronous. If its final row
    // commits during teardown, the company FK can win the race against the
    // shared cleanup helper. Once the server is closed, let that write settle,
    // clear only this test's companies, and rerun the idempotent cleanup.
    if (!String(error).includes("login_history_company_id_fkey")) throw error;

    await new Promise((resolve) => setTimeout(resolve, 25));
    await pool.query("DELETE FROM login_history WHERE company_id = ANY($1::int[])", [[ctx.companyId, secondCompanyId]]);
    await cleanupTestData(TEST_PREFIX);
  }
}, 30000);

describe("company switching authorization", () => {
  it("allows an authenticated user to switch to another assigned company", async () => {
    const switched = await agent.post("/api/auth/set-company").send({ companyId: secondCompanyId });

    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      message: "Company set successfully",
      companyId: secondCompanyId,
    });

    const sessionCompany = await agent.get("/api/auth/session-company");
    expect(sessionCompany.status).toBe(200);
    // The revision lets a tab prove its writes belong to this company session.
    expect(sessionCompany.body).toEqual({ companyId: secondCompanyId, companyRevision: expect.any(String) });
  });

  it("still rejects switching to an unassigned company", async () => {
    const denied = await agent.post("/api/auth/set-company").send({ companyId: 999999999 });

    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe("You don't have access to this company");
  });
});
