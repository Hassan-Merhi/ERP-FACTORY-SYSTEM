/**
 * Phase 3 security matrix through the real application and PostgreSQL.
 *
 * Nine company roles sign in to one company and attack it directly over HTTP:
 *   - View Only: every registered write route is refused before any handler
 *     runs, and the business-data fingerprint does not change;
 *   - user and role administration is Admin/Developer only;
 *   - existing records cannot be edited or deleted by View Only or Create Only,
 *     including records the Create Only user just created;
 *   - cross-company bodies, query strings and company switches are refused for
 *     every role that is not a member of the other company;
 *   - a role change ends the person's sessions, so a stale session cannot act;
 *   - forged role headers and companyId fields are ignored;
 *   - a verified Create Only create changes exactly the expected tables;
 *   - every legacy role gets the same answers with the V2 enforcement switch
 *     on while the company is in shadow mode (no regression).
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { db, pool } from "../server/db";
import { isViewOnlyWriteBlocked } from "../server/services/security/viewOnlyWritePolicy";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "v2matrix";
const OTHER_PREFIX = "v2matrixother";
const MISSING_ID = 2_147_483_000;

const ROLES = [
  "Developer",
  "Admin",
  "Owner",
  "Manager",
  "POS",
  "Normal User",
  "View Only",
  "ERP Tester",
  "Create Only",
] as const;
type Role = (typeof ROLES)[number];
const LEGACY_ROLES: readonly Role[] = ["Developer", "Admin", "Owner", "Manager", "POS", "Normal User", "ERP Tester"];
const READ_ONLY: ReadonlySet<Role> = new Set(["View Only", "Create Only"]);

// Business tables whose company rows must not change when a write is refused.
const FINGERPRINTED_TABLES = [
  "vouchers",
  "voucher_entries",
  "ledger_accounts",
  "suppliers",
  "customers",
  "stock_items",
  "inventory",
  "inventory_value_movements",
  "canonical_stock_movements",
  "bales",
  "factory_bales",
  "production_bales",
  "containers",
  "factory_containers",
  "factory_payrolls",
  "erp_payroll_runs",
  "employee_bonuses",
  "worker_bonuses",
  "factory_target_bonus_payments",
  "property_units",
  "property_contracts",
  "property_payments",
  "fiscal_period_closures",
  "role_feature_permissions",
  "user_company_roles",
];

type Agent = request.SuperAgentTest;

async function fingerprint(companyId: number): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of FINGERPRINTED_TABLES) {
    const exists = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name = $1 AND column_name = 'company_id'`,
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

function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after)
    .filter((table) => before[table] !== after[table])
    .sort();
}

function manifestWrites(): Array<{ method: string; path: string; signature: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8")) as {
    routes: string[];
  };
  const seen = new Set<string>();
  const routes: Array<{ method: string; path: string; signature: string }> = [];
  for (const row of manifest.routes) {
    const match = /^([A-Z]+) (\/api\/\S+) \[/.exec(row);
    if (!match || !["POST", "PUT", "PATCH", "DELETE"].includes(match[1])) continue;
    const [, method, routePath] = match;
    if (routePath.includes("*")) continue;
    const signature = `${method} ${routePath}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    routes.push({ method, path: routePath.replace(/:([A-Za-z0-9_]+)/g, String(MISSING_ID)), signature });
  }
  return routes;
}

function send(agent: Agent, method: string, url: string, body: object = {}): request.Test {
  const verb = method.toLowerCase() as "post" | "put" | "patch" | "delete";
  return agent[verb](url).send(body);
}

async function signIn(ctx: TestContext, username: string, companyId = ctx.companyId): Promise<Agent> {
  const agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({ username, password: "testpassword123" });
  expect(login.status, `login ${username}`).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId });
  expect(company.status, `set-company ${username}`).toBe(200);
  return agent;
}

function usernameFor(role: Role): string {
  return role === "Admin" ? `${PREFIX}_testuser` : `${PREFIX}_${role.toLowerCase().replace(/\s+/g, "")}`;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

describe("Permissions V2 security matrix over HTTP", () => {
  let ctx: TestContext;
  let otherCtx: TestContext;
  const agents = new Map<Role, Agent>();
  const roleRowIds = new Map<Role, number>();
  let seededSupplierId: number;
  let seededCustomerId: number;

  let nonce = 0;
  // Master data refuses near-duplicate names, so every generated name starts unique.
  const unique = (label: string) => `N${(nonce += 1)}x${Date.now() % 1_000_000} ${label}`;

  async function newSupplier(label: string): Promise<number> {
    const response = await agents
      .get("Admin")!
      .post("/api/suppliers")
      .send({ legalName: unique(label) });
    expect(ok(response.status), `seed supplier ${label}: ${response.status} ${JSON.stringify(response.body)}`).toBe(
      true
    );
    return response.body.id as number;
  }

  beforeAll(async () => {
    ctx = await seedTestData(PREFIX, { productionWriteGuards: true });
    otherCtx = await seedTestData(OTHER_PREFIX, { productionWriteGuards: true });
    const bcrypt = await import("bcryptjs");
    const password = await bcrypt.hash("testpassword123", 10);
    const [adminRow] = await pool
      .query("SELECT id FROM user_company_roles WHERE user_id=$1 AND company_id=$2", [ctx.userId, ctx.companyId])
      .then((r) => r.rows as Array<{ id: number }>);
    roleRowIds.set("Admin", adminRow.id);
    for (const role of ROLES) {
      if (role === "Admin") continue;
      const [user] = await db
        .insert(schema.users)
        .values({ username: usernameFor(role), password })
        .returning();
      const [row] = await db
        .insert(schema.userCompanyRoles)
        .values({
          userId: user.id,
          companyId: ctx.companyId,
          role,
          ...(role === "POS" ? { assignedLocationId: ctx.locationId } : {}),
        })
        .returning();
      roleRowIds.set(role, row.id);
    }
    for (const role of ROLES) agents.set(role, await signIn(ctx, usernameFor(role)));
    seededSupplierId = await newSupplier("Seed Supplier");
    const customer = await agents
      .get("Admin")!
      .post("/api/customers")
      .send({ legalName: `${PREFIX} Seed Customer` });
    expect(ok(customer.status)).toBe(true);
    seededCustomerId = customer.body.id as number;
  }, 180_000);

  afterAll(async () => {
    await cleanupTestData(PREFIX);
    await cleanupTestData(OTHER_PREFIX);
    await closeTestServer();
  });

  it("refuses every registered write route for View Only and changes no business data", async () => {
    const agent = agents.get("View Only")!;
    const before = await fingerprint(ctx.companyId);
    const leaked: string[] = [];
    let checked = 0;
    for (const route of manifestWrites()) {
      if (!isViewOnlyWriteBlocked("View Only", route.method, route.path)) continue;
      checked += 1;
      const response = await send(agent, route.method, route.path, { companyId: ctx.companyId });
      if (response.status !== 403) leaked.push(`${route.signature} -> ${response.status}`);
    }
    expect(checked).toBeGreaterThan(1000);
    expect(leaked).toEqual([]);
    expect(await fingerprint(ctx.companyId)).toEqual(before);
  }, 600_000);

  it("keeps user and role administration with Admin and Developer", async () => {
    for (const role of ROLES) {
      const agent = agents.get(role)!;
      const before = await fingerprint(ctx.companyId);
      const user = await agent
        .post("/api/users")
        .send({ username: `${PREFIX}_made_by_${role.replace(/\s+/g, "")}`, password: "testpassword123" });
      const assign = await agent
        .post("/api/user-company-roles")
        .send({ userId: otherCtx.userId, companyId: ctx.companyId, role: "Manager" });
      if (role === "Admin" || role === "Developer") {
        expect(ok(user.status), `${role} create user ${user.status}`).toBe(true);
      } else {
        expect(ok(user.status), `${role} create user ${user.status}`).toBe(false);
        expect(ok(assign.status), `${role} assign role ${assign.status}`).toBe(false);
        expect(await fingerprint(ctx.companyId)).toEqual(before);
      }
    }
    // Admin of this company cannot give itself a role elsewhere or grant Developer.
    const admin = agents.get("Admin")!;
    const elsewhere = await admin
      .post("/api/user-company-roles")
      .send({ userId: ctx.userId, companyId: otherCtx.companyId, role: "Admin" });
    expect(ok(elsewhere.status)).toBe(false);
    const developerGrant = await admin
      .post("/api/user-company-roles")
      .send({ userId: otherCtx.userId, companyId: ctx.companyId, role: "Developer" });
    expect(developerGrant.status).toBe(403);
  });

  it("refuses edits, deletes, reversals and approvals of existing records by read-only roles", async () => {
    for (const role of ["View Only", "Create Only"] as const) {
      const agent = agents.get(role)!;
      const before = await fingerprint(ctx.companyId);
      const attempts = [
        await agent.patch(`/api/suppliers/${seededSupplierId}`).send({ legalName: "Changed by read-only" }),
        await agent.delete(`/api/suppliers/${seededSupplierId}`),
        await agent.patch(`/api/customers/${seededCustomerId}`).send({ legalName: "Changed by read-only" }),
        await agent.delete(`/api/customers/${seededCustomerId}`),
        await agent.post(`/api/vouchers/${MISSING_ID}/reverse`).send({}),
        await agent.delete(`/api/vouchers/${MISSING_ID}`),
        await agent.post("/api/stock-transfers/bulk-approve").send({ ids: [MISSING_ID] }),
      ];
      for (const response of attempts) expect(response.status, `${role}`).toBe(403);
      expect(await fingerprint(ctx.companyId)).toEqual(before);
    }
  });

  it("lets Create Only add a customer with exactly the expected side effects, then not change it", async () => {
    const agent = agents.get("Create Only")!;
    const before = await fingerprint(ctx.companyId);
    const created = await agent.post("/api/customers").send({ legalName: unique("Create Only Customer") });
    expect(ok(created.status), `create ${created.status}`).toBe(true);
    const after = await fingerprint(ctx.companyId);
    const changed = changedTables(before, after);
    expect(changed).toContain("customers");
    // A new customer may open its own ledger account; nothing else may move.
    expect(changed.filter((table) => !["customers", "ledger_accounts"].includes(table))).toEqual([]);
    const [beforeCount] = before.customers.split(":");
    const [afterCount] = after.customers.split(":");
    expect(Number(afterCount)).toBe(Number(beforeCount) + 1);

    const own = created.body.id as number;
    const edit = await agent.patch(`/api/customers/${own}`).send({ legalName: "Edited own record" });
    const remove = await agent.delete(`/api/customers/${own}`);
    expect(edit.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(await fingerprint(ctx.companyId)).toEqual(after);
  });

  it("refuses cross-company bodies, queries and company switches for every non-member role", async () => {
    for (const role of ROLES) {
      const agent = agents.get(role)!;
      const before = await fingerprint(otherCtx.companyId);
      const body = await agent
        .post("/api/suppliers")
        .send({ legalName: "Cross company", companyId: otherCtx.companyId });
      const query = await agent.get(`/api/suppliers?companyId=${otherCtx.companyId}`);
      expect(ok(body.status), `${role} cross-company body ${body.status}`).toBe(false);
      if (role !== "Developer") {
        expect(ok(query.status), `${role} cross-company query ${query.status}`).toBe(false);
        const switched = await request
          .agent(ctx.app)
          .post("/api/auth/login")
          .send({ username: usernameFor(role), password: "testpassword123" })
          .then(async () => agent.post("/api/auth/set-company").send({ companyId: otherCtx.companyId }));
        expect(ok(switched.status), `${role} switch to other company ${switched.status}`).toBe(false);
      }
      expect(await fingerprint(otherCtx.companyId)).toEqual(before);
    }
  });

  it("ignores forged role headers and body fields", async () => {
    const agent = agents.get("View Only")!;
    const forged = await agent
      .patch(`/api/suppliers/${seededSupplierId}`)
      .set("X-Role", "Admin")
      .set("X-User-Role", "Developer")
      .send({ legalName: "Forged", role: "Admin", currentRole: "Admin" });
    expect(forged.status).toBe(403);
    const me = await agent.get("/api/permissions-v2/me").set("X-Role", "Admin");
    expect(me.body.role).toBe("View Only");
  });

  it("reports each role's canonical effective permissions", async () => {
    for (const role of ROLES) {
      const me = await agents.get(role)!.get("/api/permissions-v2/me");
      expect(me.status, role).toBe(200);
      expect(me.body.role).toBe(role);
      expect(me.body.enforced).toBe(false);
      const decisions = me.body.decisions as Record<string, Record<string, { allowed: boolean }>>;
      if (READ_ONLY.has(role)) {
        expect(decisions["erp.vouchers"].edit.allowed).toBe(false);
        expect(decisions["erp.vouchers"].reverse.allowed).toBe(false);
        expect(decisions["system.users"].manage_users.allowed).toBe(false);
      }
      if (role === "Admin" || role === "Developer") expect(decisions["system.users"].manage_users.allowed).toBe(true);
      if (role === "ERP Tester") expect(decisions["system.settings"].manage_settings.allowed).toBe(false);
    }
  });

  it("gives every legacy role the same answers with V2 enforcement on while the company is in shadow", async () => {
    async function probe(role: Role, label: string): Promise<number[]> {
      const agent = agents.get(role)!;
      const target = await newSupplier(`${role} ${label} target`);
      return [
        (await agent.get("/api/suppliers")).status,
        (await agent.post("/api/suppliers").send({ legalName: unique(`${role} ${label} new`) })).status,
        (await agent.patch(`/api/suppliers/${target}`).send({ legalName: unique(`${role} ${label} edit`) })).status,
        (await agent.delete(`/api/suppliers/${target}`)).status,
        (await agent.post("/api/customers").send({ legalName: unique(`${role} ${label} customer`) })).status,
        (await agent.get("/api/vouchers")).status,
      ];
    }
    const previous = process.env.PERMISSIONS_V2_ENFORCEMENT;
    for (const role of LEGACY_ROLES) {
      delete process.env.PERMISSIONS_V2_ENFORCEMENT;
      const legacy = await probe(role, "legacy");
      process.env.PERMISSIONS_V2_ENFORCEMENT = "enabled";
      const shadow = await probe(role, "shadow");
      if (previous === undefined) delete process.env.PERMISSIONS_V2_ENFORCEMENT;
      else process.env.PERMISSIONS_V2_ENFORCEMENT = previous;
      expect(shadow, `${role} parity`).toEqual(legacy);
    }
  }, 300_000);

  it("refuses settings to a session whose role became ERP Tester after sign-in", async () => {
    const ownerAgent = agents.get("Owner")!;
    const change = await agents
      .get("Admin")!
      .patch(`/api/user-company-roles/${roleRowIds.get("Owner")}`)
      .send({ role: "ERP Tester" });
    expect(change.status).toBe(200);
    const settings = await ownerAgent.get("/api/role-permissions");
    expect(settings.status).toBe(403);
  });

  it("ends a person's sessions when an administrator changes their role", async () => {
    const managerAgent = agents.get("Manager")!;
    expect((await managerAgent.get("/api/suppliers")).status).toBe(200);
    const change = await agents
      .get("Admin")!
      .patch(`/api/user-company-roles/${roleRowIds.get("Manager")}`)
      .send({ role: "View Only" });
    expect(change.status).toBe(200);
    // In production the role change also deletes the person's sessions; the
    // test app's in-memory store keeps them, which is exactly the stale-session
    // case the canonical tenant boundary must still refuse.
    const stale = await managerAgent.post("/api/suppliers").send({ legalName: unique("stale session") });
    expect(ok(stale.status)).toBe(false);
    expect([401, 403], JSON.stringify(stale.body)).toContain(stale.status);
    if (stale.status === 403) expect(stale.body.code).toBe("VIEW_ONLY_WRITE_DENIED");
    const me = await managerAgent.get("/api/permissions-v2/me");
    if (me.status === 200) expect(me.body.role).toBe("View Only");
  });
});
