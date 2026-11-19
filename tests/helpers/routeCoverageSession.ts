/**
 * Signed-in HTTP fixtures for route coverage suites: the seeded Admin agent,
 * extra users with a given role and explicitly denied permission keys, and a
 * second company (named after the prefix so cleanupTestData removes it) for
 * wrong-company checks.
 */
import request from "supertest";
import bcrypt from "bcryptjs";
import { pool } from "../../server/db";
import type { TestContext } from "../setup";

export type Agent = ReturnType<typeof request.agent>;

export async function signInAs(ctx: TestContext, username: string, companyId = ctx.companyId): Promise<Agent> {
  const agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({ username, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`login ${username} failed: ${login.status}`);
  const company = await agent.post("/api/auth/set-company").send({ companyId });
  if (company.status !== 200) throw new Error(`set-company ${username} failed: ${company.status}`);
  return agent;
}

export async function signInAdmin(ctx: TestContext, prefix: string): Promise<Agent> {
  return signInAs(ctx, `${prefix}_testuser`);
}

/**
 * A user with `role` in the fixture company. Each key in `deny` gets an
 * enabled=false row for that role, which restricts Owner/Manager/POS roles.
 */
export async function signInRole(
  ctx: TestContext,
  prefix: string,
  role: string,
  deny: string[] = [],
  extra: { assignedLocationId?: number } = {}
): Promise<Agent> {
  const { username } = await createRoleUser(ctx, prefix, role, deny, extra);
  return signInAs(ctx, username);
}

/** Creates the user behind signInRole without signing in. */
export async function createRoleUser(
  ctx: TestContext,
  prefix: string,
  role: string,
  deny: string[] = [],
  extra: { assignedLocationId?: number } = {}
): Promise<{ username: string; userId: string }> {
  const username = `${prefix}_${role.replace(/\s+/g, "").toLowerCase()}_${deny.length}_${Math.floor(Math.random() * 1e6)}`;
  const password = await bcrypt.hash("testpassword123", 4);
  const user = await pool.query<{ id: string }>("INSERT INTO users(username,password) VALUES($1,$2) RETURNING id", [
    username,
    password,
  ]);
  await pool.query("INSERT INTO user_company_roles(user_id,company_id,role,assigned_location_id) VALUES($1,$2,$3,$4)", [
    user.rows[0].id,
    ctx.companyId,
    role,
    extra.assignedLocationId ?? null,
  ]);
  for (const key of deny) {
    await pool.query(
      `INSERT INTO role_feature_permissions(company_id,role,feature_key,enabled) VALUES($1,$2,$3,false)
       ON CONFLICT DO NOTHING`,
      [ctx.companyId, role, key]
    );
  }
  return { username, userId: user.rows[0].id };
}

/** A second company with one location, cleaned up with the fixture prefix. */
export async function otherCompanyLocation(prefix: string): Promise<{ companyId: number; locationId: number }> {
  const code = `O${prefix
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 8)}${Math.floor(Math.random() * 1e5)}`;
  const company = await pool.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    code,
    `${prefix}_OtherCompany`,
  ]);
  const location = await pool.query<{ id: number }>(
    "INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id",
    [company.rows[0].id, `${code}-L`, `${prefix}_OtherLocation`]
  );
  return { companyId: company.rows[0].id, locationId: location.rows[0].id };
}
