/**
 * Phase 21 backend coverage — company, role, POS mapping and permission matrix.
 *
 * Exercises the real HTTP middleware/route stack against PostgreSQL. The suite
 * deliberately starts as a tenant Admin, proves cross-company writes are denied,
 * then elevates the fixture actor to Developer and proves Developer can switch
 * into another authorized company and administer it without weakening active-
 * company isolation or resource ownership validation.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `p21perm-${Date.now().toString(36)}`;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let targetUserId = "";
let targetRoleId = 0;
let secondCompanyId = 0;
let secondLocationId = 0;
let secondCashAccountId = 0;
let permissionA = "";
let permissionB = "";

async function grantPermission(userId: string, companyId: number, permission: string) {
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     VALUES ($1, $2, $3, $1)
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [userId, companyId, permission]
  );
}

async function roleRows(userId: string) {
  const result = await pool.query<{ id: number; company_id: number; role: string; assigned_location_id: number | null }>(
    `SELECT id, company_id, role, assigned_location_id
       FROM user_company_roles
      WHERE user_id = $1
      ORDER BY company_id`,
    [userId]
  );
  return result.rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app) as request.SuperAgentTest;

  // The permission-management route is intentionally capability-gated even for
  // Admin/Developer. Give the fixture Admin that named capability explicitly.
  await grantPermission(ctx.userId, ctx.companyId, "security.permissions.manage");

  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);
}, 120_000);

afterAll(async () => {
  if (targetUserId) {
    await pool.query(`DELETE FROM user_location_cash_accounts WHERE user_id = $1`, [targetUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_locations WHERE user_id = $1`, [targetUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_security_permissions WHERE user_id = $1`, [targetUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_company_roles WHERE user_id = $1`, [targetUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM users WHERE id = $1`, [targetUserId]).catch(() => undefined);
  }
  if (secondCompanyId) {
    await pool.query(`DELETE FROM user_location_cash_accounts WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_locations WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_security_permissions WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM audit_log WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM login_history WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM locations WHERE company_id = $1`, [secondCompanyId]).catch(() => undefined);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [secondCompanyId]).catch(() => undefined);
  }
  if (ctx) {
    await pool.query(`DELETE FROM user_security_permissions WHERE user_id = $1 AND company_id = $2`, [ctx.userId, ctx.companyId]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

describe("Phase 21 company/role/permission backend", () => {
  it("requires an explicit parent decision and creates a standalone company", async () => {
    const missingDecision = await agent.post("/api/companies").send({
      code: `P21BAD-${Date.now()}`,
      name: `${PREFIX} Missing Parent Decision`,
      companyType: "erp",
      baseCurrency: "USD",
    });
    expect(missingDecision.status).toBe(400);
    expect(missingDecision.body.message).toMatch(/parent company|Standalone/i);

    const response = await agent.post("/api/companies").send({
      code: `P21-${Date.now().toString(36)}`,
      name: `${PREFIX} Second Company`,
      companyType: "erp",
      baseCurrency: "USD",
      parentCompanyId: null,
      active: true,
    });
    expect(response.status, response.text).toBe(201);
    secondCompanyId = Number(response.body.id);
    expect(secondCompanyId).toBeGreaterThan(0);
    expect(response.body.parentCompanyId ?? null).toBeNull();

    const location = await pool.query<{ id: number }>(
      `INSERT INTO locations (company_id, code, name, active)
       VALUES ($1, $2, $3, true)
       RETURNING id`,
      [secondCompanyId, `P21L-${secondCompanyId}`, `${PREFIX} Location`]
    );
    secondLocationId = location.rows[0].id;

    const cash = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
       VALUES ($1, $2, $3, 'Cash', '0', true)
       RETURNING id`,
      [secondCompanyId, `P21C-${secondCompanyId}`, `${PREFIX} Cash`]
    );
    secondCashAccountId = cash.rows[0].id;
  });

  it("creates a user and assigns a POS role only inside the active tenant", async () => {
    const created = await agent.post("/api/users").send({
      username: `${PREFIX}_target`,
      password: "targetpassword123",
      active: true,
    });
    expect(created.status, created.text).toBe(201);
    targetUserId = String(created.body.id);
    expect(targetUserId).toBeTruthy();
    expect(created.body.password).toBeUndefined();

    const missingLocation = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: ctx.companyId,
      role: "POS",
    });
    expect(missingLocation.status).toBe(400);
    expect(missingLocation.body.message).toMatch(/assigned location/i);

    const role = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: ctx.companyId,
      role: "POS",
      assignedLocationId: ctx.locationId,
      canSellNegativeStock: false,
      canAccessCustomers: true,
    });
    expect(role.status, role.text).toBe(201);
    targetRoleId = Number(role.body.id);
    expect(targetRoleId).toBeGreaterThan(0);

    const duplicate = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: ctx.companyId,
      role: "Manager",
    });
    expect(duplicate.status).toBe(409);
  });

  it("writes POS location and cash mappings only with company-owned resources", async () => {
    const locations = await agent
      .put(`/api/user-locations/${targetUserId}/${ctx.companyId}`)
      .send({ locationIds: [ctx.locationId, ctx.location2Id] });
    expect(locations.status, locations.text).toBe(200);
    expect(locations.body).toHaveLength(2);

    const mappings = await agent
      .put(`/api/user-location-cash-accounts/${targetUserId}/${ctx.companyId}`)
      .send({ mappings: [{ locationId: ctx.locationId, cashAccountId: ctx.cashAccountId, posStation: 1 }] });
    expect(mappings.status, mappings.text).toBe(200);

    const foreignLocation = await agent
      .put(`/api/user-locations/${targetUserId}/${ctx.companyId}`)
      .send({ locationIds: [secondLocationId] });
    expect(foreignLocation.status).toBe(400);

    const foreignCash = await agent
      .put(`/api/user-location-cash-accounts/${targetUserId}/${ctx.companyId}`)
      .send({ mappings: [{ locationId: ctx.locationId, cashAccountId: secondCashAccountId }] });
    expect(foreignCash.status).toBe(400);

    const rows = await pool.query<{ location_id: number; cash_account_id: number }>(
      `SELECT location_id, cash_account_id
         FROM user_location_cash_accounts
        WHERE user_id = $1 AND company_id = $2`,
      [targetUserId, ctx.companyId]
    );
    expect(rows.rows).toEqual([{ location_id: ctx.locationId, cash_account_id: ctx.cashAccountId }]);
  });

  it("lets Admin replace named permissions for in-company users", async () => {
    const catalog = await agent.get("/api/admin/security-permissions/catalog");
    expect(catalog.status, catalog.text).toBe(200);
    const permissions = catalog.body.permissions as string[];
    permissionA = permissions.find((value) => value !== "security.permissions.manage") ?? permissions[0];
    permissionB = permissions.find((value) => value !== "security.permissions.manage" && value !== permissionA) ?? permissionA;
    expect(permissionA).toBeTruthy();

    const response = await agent
      .put(`/api/admin/users/${targetUserId}/security-permissions`)
      .send({ permissions: [permissionA] });
    expect(response.status, response.text).toBe(200);
    expect(response.body.permissions).toEqual([permissionA]);

    const saved = await pool.query<{ permission: string }>(
      `SELECT permission FROM user_security_permissions
        WHERE user_id = $1 AND company_id = $2
        ORDER BY permission`,
      [targetUserId, ctx.companyId]
    );
    expect(saved.rows.map((row) => row.permission)).toEqual([permissionA]);
  });

  it("blocks tenant Admin from cross-company roles, mappings and Developer assignment", async () => {
    const crossRole = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: secondCompanyId,
      role: "Manager",
    });
    expect(crossRole.status).toBe(403);

    const developerRole = await agent.patch(`/api/user-company-roles/${targetRoleId}`).send({ role: "Developer" });
    expect(developerRole.status).toBe(403);

    const crossLocations = await agent
      .put(`/api/user-locations/${targetUserId}/${secondCompanyId}`)
      .send({ locationIds: [secondLocationId] });
    expect(crossLocations.status).toBe(404);

    expect((await roleRows(targetUserId)).map((row) => row.company_id)).toEqual([ctx.companyId]);
  });

  it("keeps Developer writes active-company scoped while allowing an authorized company switch", async () => {
    await pool.query(
      `UPDATE user_company_roles SET role = 'Developer' WHERE user_id = $1 AND company_id = $2`,
      [ctx.userId, ctx.companyId]
    );
    await pool.query(
      `INSERT INTO user_company_roles (user_id, company_id, role)
       VALUES ($1, $2, 'Developer')`,
      [ctx.userId, secondCompanyId]
    );
    await grantPermission(ctx.userId, secondCompanyId, "security.permissions.manage");

    // Refresh the session role after the fixture role change. Even Developer is
    // not allowed to override the active primary company in a write payload.
    const refresh = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    expect(refresh.status, refresh.text).toBe(200);

    const blockedCrossRole = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: secondCompanyId,
      role: "POS",
      assignedLocationId: secondLocationId,
      canSellNegativeStock: true,
    });
    expect(blockedCrossRole.status).toBe(403);
    expect(blockedCrossRole.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");

    // Switch the canonical active company first; writes then run under that
    // company's tenant/RLS context and remain ownership-checked.
    const selected = await agent.post("/api/auth/set-company").send({ companyId: secondCompanyId });
    expect(selected.status, selected.text).toBe(200);

    const role = await agent.post("/api/user-company-roles").send({
      userId: targetUserId,
      companyId: secondCompanyId,
      role: "POS",
      assignedLocationId: secondLocationId,
      canSellNegativeStock: true,
    });
    expect(role.status, role.text).toBe(201);

    const locations = await agent
      .put(`/api/user-locations/${targetUserId}/${secondCompanyId}`)
      .send({ locationIds: [secondLocationId] });
    expect(locations.status, locations.text).toBe(200);

    const mappings = await agent
      .put(`/api/user-location-cash-accounts/${targetUserId}/${secondCompanyId}`)
      .send({ mappings: [{ locationId: secondLocationId, cashAccountId: secondCashAccountId, posStation: 2 }] });
    expect(mappings.status, mappings.text).toBe(200);

    // Developer is global, but resource ownership remains target-company strict.
    const wrongCompanyResource = await agent
      .put(`/api/user-locations/${targetUserId}/${secondCompanyId}`)
      .send({ locationIds: [ctx.locationId] });
    expect(wrongCompanyResource.status).toBe(400);

    const roles = await agent.get(`/api/users/${targetUserId}/company-roles`);
    expect(roles.status, roles.text).toBe(200);
    const companyIds = (roles.body as Array<{ companyId: number }>).map((row) => Number(row.companyId)).sort((a, b) => a - b);
    expect(companyIds).toEqual([ctx.companyId, secondCompanyId].sort((a, b) => a - b));
  });

  it("keeps named permissions tenant-scoped when Developer switches companies", async () => {
    const selected = await agent.post("/api/auth/set-company").send({ companyId: secondCompanyId });
    expect(selected.status, selected.text).toBe(200);

    const response = await agent
      .put(`/api/admin/users/${targetUserId}/security-permissions`)
      .send({ permissions: [permissionB] });
    expect(response.status, response.text).toBe(200);
    expect(response.body.companyId).toBe(secondCompanyId);
    expect(response.body.permissions).toEqual([permissionB]);

    const scoped = await pool.query<{ company_id: number; permission: string }>(
      `SELECT company_id, permission
         FROM user_security_permissions
        WHERE user_id = $1
        ORDER BY company_id, permission`,
      [targetUserId]
    );
    expect(scoped.rows).toEqual([
      { company_id: ctx.companyId, permission: permissionA },
      { company_id: secondCompanyId, permission: permissionB },
    ]);
  });
});