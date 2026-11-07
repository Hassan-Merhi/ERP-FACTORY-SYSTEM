/**
 * End-to-end Create Only enforcement through the real application and database.
 *
 * A seeded company user is switched to the Create Only role in the database,
 * then signs in and attacks every registered write route directly over HTTP.
 * The test proves, with real responses and before/after database fingerprints:
 *   - every unverified business write is refused with 403 before any handler runs;
 *   - verified creates succeed only for clean new records and refuse opening
 *     balances and opening stock;
 *   - the user cannot edit or delete records it has just created;
 *   - a body naming another company is refused;
 *   - a session whose role was changed to Create Only in the database after
 *     sign-in cannot keep making unverified writes.
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { db, pool } from "../server/db";
import { CREATE_ONLY_VERIFIED_CREATE_SIGNATURES } from "../shared/createOnlyRolePolicy";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const CREATE_ONLY_PREFIX = "corolehttp";
const STALE_PREFIX = "corolestale";
const OTHER_PREFIX = "coroleother";
const MISSING_ID = 2_147_483_000;

const VERIFIED = new Set<string>(Object.values(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).flat());
const LIFECYCLE = [/^\/api\/auth\//, /^\/api\/user-presence/, /^\/api\/screen-feed/];

// Company-scoped business tables whose rows must not change when writes are refused.
const FINGERPRINTED_TABLES = [
  "vouchers",
  "voucher_entries",
  "inventory",
  "stock_items",
  "suppliers",
  "customers",
  "ledger_accounts",
  "role_feature_permissions",
  "user_company_roles",
];

async function fingerprint(companyId: number): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of FINGERPRINTED_TABLES) {
    const exists = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'company_id'`,
      [table]
    );
    if (exists.rowCount === 0) continue;
    const rows = await pool.query(
      `SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h
         FROM ${table} t WHERE t.company_id = $1`,
      [companyId]
    );
    result[table] = `${rows.rows[0].n}:${rows.rows[0].h}`;
  }
  return result;
}

function writeRoutes(): Array<{ method: string; path: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8")) as {
    routes: string[];
  };
  const seen = new Set<string>();
  const routes: Array<{ method: string; path: string }> = [];
  for (const row of manifest.routes) {
    const match = /^([A-Z]+) (\/api\/\S+) \[/.exec(row);
    // Every HTTP verb a client can send; app.all() registrations also list
    // CONNECT and similar verbs, which the pure boundary suite covers.
    if (!match || !["POST", "PUT", "PATCH", "DELETE"].includes(match[1])) continue;
    const [, method, routePath] = match;
    if (VERIFIED.has(`${method} ${routePath}`) || LIFECYCLE.some((pattern) => pattern.test(routePath))) continue;
    if (routePath.includes("*")) continue;
    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path: routePath.replace(/:([A-Za-z0-9_]+)/g, String(MISSING_ID)) });
  }
  return routes;
}

function send(agent: request.SuperAgentTest, method: string, url: string, body: object = {}): request.Test {
  const verb = method.toLowerCase() as "post" | "put" | "patch" | "delete";
  return agent[verb](url).send(body);
}

async function signIn(ctx: TestContext, prefix: string): Promise<request.SuperAgentTest> {
  const agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${prefix}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status).toBe(200);
  return agent;
}

async function setRole(ctx: TestContext, role: string): Promise<void> {
  await db
    .update(schema.userCompanyRoles)
    .set({ role })
    .where(and(eq(schema.userCompanyRoles.userId, ctx.userId), eq(schema.userCompanyRoles.companyId, ctx.companyId)));
}

describe("Create Only enforcement over HTTP", () => {
  let ctx: TestContext;
  let staleCtx: TestContext;
  let otherCtx: TestContext;
  let agent: request.SuperAgentTest;

  beforeAll(async () => {
    // Mount the same global write guards as production (server/index.ts).
    ctx = await seedTestData(CREATE_ONLY_PREFIX, { productionWriteGuards: true });
    staleCtx = await seedTestData(STALE_PREFIX, { productionWriteGuards: true });
    otherCtx = await seedTestData(OTHER_PREFIX, { productionWriteGuards: true });
    await setRole(ctx, "Create Only");
    agent = await signIn(ctx, CREATE_ONLY_PREFIX);
  }, 180_000);

  afterAll(async () => {
    await cleanupTestData(CREATE_ONLY_PREFIX);
    await cleanupTestData(STALE_PREFIX);
    await cleanupTestData(OTHER_PREFIX);
    await closeTestServer();
  }, 180_000);

  it("signs in with the Create Only role", async () => {
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.currentRole).toBe("Create Only");
  });

  it("refuses every unverified write route with 403 and changes no business data", async () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(1000);
    const before = await fingerprint(ctx.companyId);
    const leaks: string[] = [];
    for (const route of routes) {
      let response: request.Response;
      try {
        response = await send(agent, route.method, route.path, { companyId: ctx.companyId, id: MISSING_ID });
      } catch (error) {
        leaks.push(`${route.method} ${route.path} -> transport error ${String(error)}`);
        continue;
      }
      if (response.status !== 403 || response.body?.code !== "BUSINESS_ACTION_NOT_VERIFIED") {
        leaks.push(
          `${route.method} ${route.path} -> ${response.status} ${JSON.stringify(response.body)?.slice(0, 120)}`
        );
      }
    }
    expect(leaks).toEqual([]);
    expect(await fingerprint(ctx.companyId)).toEqual(before);
  }, 600_000);

  it("creates clean new master records and refuses opening balances and opening stock", async () => {
    const before = await fingerprint(ctx.companyId);
    const deniedSupplier = await agent
      .post("/api/suppliers")
      .send({ legalName: "CO Supplier Balance", openingBalance: "500" });
    expect(deniedSupplier.status).toBe(403);
    expect(deniedSupplier.body.code).toBe("BUSINESS_ACTION_DENIED");
    const deniedCustomer = await agent
      .post("/api/customers")
      .send({ legalName: "CO Customer Balance", openingBalance: "75" });
    expect(deniedCustomer.status).toBe(403);
    const deniedItem = await agent
      .post("/api/stock-items")
      .send({
        code: "CO-OPEN",
        name: "Opening stock item",
        uom: "PCS",
        stockGroupId: ctx.stockGroupId,
        openingQty: "5",
      });
    expect(deniedItem.status).toBe(403);
    expect(await fingerprint(ctx.companyId)).toEqual(before);

    const supplier = await agent.post("/api/suppliers").send({ legalName: "CO Clean Supplier" });
    expect([200, 201]).toContain(supplier.status);
    const customer = await agent.post("/api/customers").send({ legalName: "CO Clean Customer" });
    expect([200, 201]).toContain(customer.status);
    const item = await agent
      .post("/api/stock-items")
      .send({ code: "CO-NEW", name: "Create Only item", uom: "PCS", stockGroupId: ctx.stockGroupId });
    expect([200, 201]).toContain(item.status);

    // Records the user just created are still immutable for this role.
    const ownChanges = [
      await agent.put(`/api/suppliers/${supplier.body.id}`).send({ legalName: "Renamed" }),
      await agent.delete(`/api/suppliers/${supplier.body.id}`),
      await agent.put(`/api/customers/${customer.body.id}`).send({ legalName: "Renamed" }),
      await agent.patch(`/api/stock-items/${item.body.id}`).send({ name: "Renamed" }),
      await agent.delete(`/api/stock-items/${item.body.id}`),
    ];
    for (const response of ownChanges) expect(response.status).toBe(403);
    const [stored] = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.body.id));
    expect(stored.legalName).toBe("CO Clean Customer");
  });

  it("refuses a create that names another company", async () => {
    const response = await agent
      .post("/api/customers")
      .send({ legalName: "Cross company", companyId: otherCtx.companyId });
    expect(response.status).toBe(403);
    const leaked = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, otherCtx.companyId), eq(schema.customers.legalName, "Cross company")));
    expect(leaked).toHaveLength(0);
  });

  it("stops an older session once the database role becomes Create Only", async () => {
    const staleAgent = await signIn(staleCtx, STALE_PREFIX);
    const created = await staleAgent.post("/api/customers").send({ legalName: "Before demotion" });
    expect([200, 201]).toContain(created.status);
    // Change the role directly, without the normal session invalidation, to
    // prove the canonical membership check does not trust the session role.
    await setRole(staleCtx, "Create Only");
    const before = await fingerprint(staleCtx.companyId);
    const edit = await staleAgent.put(`/api/customers/${created.body.id}`).send({ legalName: "After demotion" });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("BUSINESS_ACTION_NOT_VERIFIED");
    expect(await fingerprint(staleCtx.companyId)).toEqual(before);
  });
});
