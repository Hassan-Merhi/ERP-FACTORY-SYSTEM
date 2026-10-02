/**
 * The operational permission layer over HTTP
 * (server/middleware/operationalPermissionScope.ts with the per-route table in
 * server/services/security/operationalPermissionRoutePolicy.ts).
 *
 *   - A route the old URL rules missed (`recalc-opening`: "recalc" never
 *     matched "recalculate") is now refused to View Only before its handler.
 *   - Express routes URLs case-insensitively; the old rules did not, so an
 *     upper-case import URL reached the handler unchecked. It no longer does.
 *   - Admin is unaffected, and an ordinary read stays outside the layer.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "opperm";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let factoryCompanyId: number;

/** Sets the user's role in both companies and re-selects one (the session copies the role). */
async function setRole(role: string, companyId = factoryCompanyId): Promise<void> {
  await db.update(schema.userCompanyRoles).set({ role }).where(eq(schema.userCompanyRoles.userId, ctx.userId));
  expect((await agent.post("/api/auth/set-company").send({ companyId })).status).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'factory', true, 'USD') RETURNING id`,
    ["OPPERMF", `${TEST_PREFIX}_FactoryCompany`]
  );
  factoryCompanyId = company.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Admin', true, true)`,
    [ctx.userId, factoryCompanyId]
  );
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("operational permission scope", () => {
  it("refuses View Only on a raw-stock recalculation the old URL rules missed", async () => {
    await setRole("View Only");
    const response = await agent.post("/api/factory/raw-stock/recalc-opening").send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("OPERATIONAL_ROLE_DENIED");
  });

  it("checks an import reached through an upper-case URL", async () => {
    await setRole("View Only", ctx.companyId);
    const response = await agent.post("/api/STOCK-ITEMS/IMPORT").send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("OPERATIONAL_ROLE_DENIED");
  });

  it("leaves Admin and ordinary reads alone", async () => {
    await setRole("Admin");
    const recalc = await agent.post("/api/factory/raw-stock/recalc-opening").send({});
    expect(recalc.status).toBe(200);
    expect(recalc.body).toHaveProperty("suppliersProcessed");

    await setRole("View Only", ctx.companyId);
    const read = await agent.get("/api/stats/import-cycle-balance");
    expect(read.body.code).not.toBe("OPERATIONAL_ROLE_DENIED");
  });
});
