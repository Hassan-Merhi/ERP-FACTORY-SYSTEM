/**
 * The access boundary end to end, against the real route stack and database.
 *
 * Each case goes through the committed manifest, the boundary, the route's own
 * guards and the handler, so it fails if any of them stops agreeing with the
 * others: authentication, company isolation, record ownership, module and
 * operational permissions, role rules, the Factory company pin and the
 * privileged-maintenance policy.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "accbnd";
const PASSWORD = "testpassword123";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let memberCompanyId: number;
let foreignCompanyId: number;
let factoryCompanyId: number;
let foreignLocationId: number;

async function createCompany(code: string, name: string, type: "erp" | "factory"): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, $3, true, 'USD') RETURNING id`,
    [code, name, type]
  );
  return result.rows[0].id;
}

async function addMembership(companyId: number, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_company_roles (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, $3, true, true)`,
    [ctx.userId, companyId, role]
  );
}

/** Sets the user's role in every company and re-selects one (the session copies the role). */
async function actAs(role: string, companyId = ctx.companyId): Promise<void> {
  await db.update(schema.userCompanyRoles).set({ role }).where(eq(schema.userCompanyRoles.userId, ctx.userId));
  expect((await agent.post("/api/auth/set-company").send({ companyId })).status).toBe(200);
}

async function setFeature(role: string, featureKey: string, enabled: boolean | null): Promise<void> {
  await pool.query(`DELETE FROM role_feature_permissions WHERE company_id = $1 AND role = $2 AND feature_key = $3`, [
    ctx.companyId,
    role,
    featureKey,
  ]);
  if (enabled !== null) {
    await pool.query(
      `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled) VALUES ($1, $2, $3, $4)`,
      [ctx.companyId, role, featureKey, enabled]
    );
  }
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: PASSWORD });
  expect(login.status).toBe(200);

  memberCompanyId = await createCompany("ACCBNDM", `${PREFIX}_MemberCompany`, "erp");
  foreignCompanyId = await createCompany("ACCBNDX", `${PREFIX}_ForeignCompany`, "erp");
  factoryCompanyId = await createCompany("ACCBNDF", `${PREFIX}_FactoryCompany`, "factory");
  await addMembership(memberCompanyId, "Admin");

  const location = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [foreignCompanyId, "ACCBNDX-LOC", `${PREFIX}_ForeignLocation`]
  );
  foreignLocationId = location.rows[0].id;
}, 120000);

afterAll(async () => {
  const extra = [memberCompanyId, foreignCompanyId, factoryCompanyId].filter(Boolean);
  if (extra.length) {
    await pool.query(`DELETE FROM locations WHERE company_id = ANY($1::int[])`, [extra]);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = ANY($1::int[])`, [extra]);
    await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [extra]);
  }
  if (ctx) await pool.query(`DELETE FROM role_feature_permissions WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("authentication", () => {
  it("answers a signed-out request with 401 from the route's own guard", async () => {
    const response = await request(ctx.app).get("/api/stock-items");
    expect(response.status).toBe(401);
  });

  it("serves a public route without a session", async () => {
    expect((await request(ctx.app).get("/api/health")).status).toBe(200);
  });

  it("refuses an undeclared API URL with 404, signed in or not", async () => {
    for (const client of [request(ctx.app), agent]) {
      const response = await client.get("/api/this-route-is-not-declared");
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("API_ROUTE_NOT_FOUND");
    }
    const mutation = await agent.post("/api/this-route-is-not-declared").send({});
    expect(mutation.status).toBe(404);
  });

  it("does not reach a handler through a differently-cased URL", async () => {
    expect((await agent.get("/api/STOCK-ITEMS")).status).toBe(404);
    expect((await agent.get("/API/stock-items")).status).toBe(404);
  });
});

describe("company isolation", () => {
  it("serves the active company and refuses a caller-supplied foreign company", async () => {
    await actAs("Admin");
    expect((await agent.get("/api/stock-items")).status).toBe(200);
    expect((await agent.get("/api/stock-items").query({ companyId: ctx.companyId })).status).toBe(200);

    const foreign = await agent.get("/api/stock-items").query({ companyId: foreignCompanyId });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");

    // Membership of another company does not widen an ordinary route either.
    const member = await agent.get("/api/stock-items").query({ companyId: memberCompanyId });
    expect(member.status).toBe(403);
    expect(member.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");
  });

  it("rejects malformed and conflicting company IDs", async () => {
    const malformed = await agent.get("/api/stock-items").query({ companyId: "abc" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("COMPANY_ID_INVALID");
  });

  it("bounds the declared cross-company reference read by role and membership", async () => {
    await actAs("Admin");
    // A company the Admin is not a member of is refused by the boundary.
    const foreign = await agent.get("/api/locations").query({ companyId: foreignCompanyId });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("COMPANY_ACCESS_DENIED");

    // A member company passes the boundary's reference-read allowance. The
    // route's own requireAuth then applies its explicit-company check, as it
    // always has; the boundary must not be what refuses it.
    const member = await agent.get("/api/locations").query({ companyId: memberCompanyId });
    expect(member.body.code).not.toBe("COMPANY_ACCESS_DENIED");
    expect(member.body.code).not.toBe("CROSS_COMPANY_REFERENCE_FORBIDDEN");

    await actAs("Manager");
    const manager = await agent.get("/api/locations").query({ companyId: memberCompanyId });
    expect(manager.status).toBe(403);
    expect(manager.body.code).toBe("CROSS_COMPANY_REFERENCE_FORBIDDEN");
  });

  it("refuses a foreign company in a :companyId URL parameter", async () => {
    await actAs("Admin");
    const foreign = await agent.get(`/api/company-accounts/${foreignCompanyId}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");

    const own = await agent.get(`/api/company-accounts/${ctx.companyId}`);
    expect(own.status).not.toBe(403);
    expect(own.status).not.toBe(404);

    const invalid = await agent.get("/api/company-accounts/not-a-number");
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("COMPANY_ID_INVALID");
  });

  it("hides a record that belongs to another company", async () => {
    await actAs("Admin");
    const own = await agent.get(`/api/locations/${ctx.locationId}`);
    expect(own.status).not.toBe(403);
    expect(own.status).not.toBe(404);

    const foreign = await agent.get(`/api/locations/${foreignLocationId}`);
    expect([403, 404]).toContain(foreign.status);
    const mutation = await agent.patch(`/api/locations/${foreignLocationId}`).send({ name: "taken over" });
    expect([403, 404]).toContain(mutation.status);
    const untouched = await pool.query<{ name: string }>(`SELECT name FROM locations WHERE id = $1`, [
      foreignLocationId,
    ]);
    expect(untouched.rows[0].name).toBe(`${PREFIX}_ForeignLocation`);
  });
});

describe("module and operational permissions", () => {
  it("refuses a role whose module permission is disabled and restores it when re-enabled", async () => {
    await actAs("Manager");
    expect((await agent.get("/api/stock-items")).status).toBe(200);

    await setFeature("Manager", "mod_inventory", false);
    const refused = await agent.get("/api/stock-items");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ key: "mod_inventory", permType: "module" });
    // HEAD is answered by the GET route and needs the same permission.
    expect((await agent.head("/api/stock-items")).status).toBe(403);

    await setFeature("Manager", "mod_inventory", null);
    expect((await agent.get("/api/stock-items")).status).toBe(200);
  });

  it("does not let Admin be restricted through role-feature rows", async () => {
    await setFeature("Admin", "mod_inventory", false);
    await actAs("Admin");
    expect((await agent.get("/api/stock-items")).status).toBe(200);
    await setFeature("Admin", "mod_inventory", null);
  });

  it("applies deny-by-default to Normal User", async () => {
    await actAs("Normal User");
    const refused = await agent.get("/api/stock-items");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ key: "mod_inventory" });

    await setFeature("Normal User", "mod_inventory", true);
    expect((await agent.get("/api/stock-items")).status).not.toBe(403);
    await setFeature("Normal User", "mod_inventory", null);
  });

  it("refuses imports to POS and View Only but keeps the POS sales-import exception", async () => {
    await actAs("POS");
    const ordinary = await agent.post("/api/po-import/import").send({});
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.code).toBe("OPERATIONAL_ROLE_DENIED");

    // The POS sales import is open to POS even with the import key disabled.
    await setFeature("POS", "act_import_data", false);
    const posImport = await agent.post("/api/pos-import/validate").send({});
    expect(posImport.body.code).not.toBe("OPERATIONAL_ROLE_DENIED");
    expect(posImport.body.key).not.toBe("act_import_data");
    await setFeature("POS", "act_import_data", null);

    await actAs("View Only");
    const viewOnly = await agent.post("/api/pos-import/validate").send({});
    expect(viewOnly.status).toBe(403);
  });

  it("opens the all-company export center to Developer only", async () => {
    await actAs("Admin");
    const admin = await agent.get("/api/export/settings");
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe("GLOBAL_EXPORT_DEVELOPER_REQUIRED");
  });
});

describe("privileged maintenance", () => {
  it("admits an Admin holding the repair permission and refuses lower roles before the handler", async () => {
    await actAs("Manager");
    const manager = await agent.post("/api/admin/fix-sales-inventory").send({});
    expect(manager.status).toBe(403);
    expect(manager.body.code).toBe("PRIVILEGED_MAINTENANCE_ROLE_REQUIRED");

    for (const role of ["Owner", "POS", "View Only"]) {
      await actAs(role);
      const refused = await agent.post("/api/admin/fix-sales-inventory").send({});
      expect(refused.status, role).toBe(403);
    }

    await actAs("Admin");
    const admin = await agent.post("/api/admin/fix-sales-inventory").send({});
    expect(admin.status).toBe(200);
  });
});

describe("Factory company", () => {
  it("refuses Factory routes to a user with no Factory company and serves them once assigned", async () => {
    await actAs("Admin");
    const refused = await agent.get("/api/factory/bales");
    expect(refused.status).toBe(403);

    await addMembership(factoryCompanyId, "Admin");
    await actAs("Admin", factoryCompanyId);
    const allowed = await agent.get("/api/factory/bales");
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);
    expect(allowed.status).not.toBe(404);
  });
});
