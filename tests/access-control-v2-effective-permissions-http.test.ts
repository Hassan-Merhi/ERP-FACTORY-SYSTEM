/**
 * Effective permission engine, activation switch and administrator safety
 * rules through the real application and PostgreSQL.
 *
 * Proves over HTTP:
 *   - /api/permissions-v2/me uses canonical membership; a forged company id,
 *     role header or body cannot change the answer;
 *   - only company administrators can read another member's effective
 *     permissions, and never for a person outside the company;
 *   - activation is refused until the operator switch is on, stale revisions
 *     get 409, rollback always works, and every change is audited;
 *   - with the company active and enforcement on, a V2 deny refuses the write
 *     and leaves business data unchanged; with either off, legacy behaviour is
 *     unchanged; a V2 allow never lifts a hard restriction;
 *   - the last company Admin cannot be demoted or deleted, and a person cannot
 *     change their own role; two Admins demoting each other at once cannot
 *     both succeed.
 */
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { db, pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "v2effhttp";
const OTHER_PREFIX = "v2effother";

type Agent = request.SuperAgentTest;

async function addMember(ctx: TestContext, suffix: string, role: string): Promise<{ id: string; roleRowId: number }> {
  const bcrypt = await import("bcryptjs");
  const [user] = await db
    .insert(schema.users)
    .values({ username: `${PREFIX}_${suffix}`, password: await bcrypt.hash("testpassword123", 10) })
    .returning();
  const [row] = await db
    .insert(schema.userCompanyRoles)
    .values({ userId: user.id, companyId: ctx.companyId, role })
    .returning();
  return { id: user.id, roleRowId: row.id };
}

async function signIn(ctx: TestContext, username: string, companyId = ctx.companyId): Promise<Agent> {
  const agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({ username, password: "testpassword123" });
  expect(login.status).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId });
  expect(company.status).toBe(200);
  return agent;
}

async function clearPolicy(companyId: number): Promise<void> {
  for (const table of [
    "access_policy_change_audit",
    "access_user_overrides",
    "access_role_rules",
    "access_role_templates",
    "access_policy_versions",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
  }
}

async function supplierCount(companyId: number): Promise<number> {
  const result = await pool.query("SELECT count(*)::int AS n FROM suppliers WHERE company_id = $1", [companyId]);
  return result.rows[0].n as number;
}

async function revision(agent: Agent): Promise<number> {
  const status = await agent.get("/api/permissions-v2/activation");
  expect(status.status).toBe(200);
  return status.body.revision as number;
}

function withEnv<T>(values: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return work().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("Permissions V2 effective engine over HTTP", () => {
  let ctx: TestContext;
  let otherCtx: TestContext;
  let admin: Agent;
  let createOnly: { id: string; roleRowId: number };

  beforeAll(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE $1", [`${PREFIX}\\_%`]).catch(() => undefined);
    ctx = await seedTestData(PREFIX, { productionWriteGuards: true });
    otherCtx = await seedTestData(OTHER_PREFIX, { productionWriteGuards: true });
    await clearPolicy(ctx.companyId);
    createOnly = await addMember(ctx, "createonly", "Create Only");
    await addMember(ctx, "manager", "Manager");
    admin = await signIn(ctx, `${PREFIX}_testuser`);
  }, 120_000);

  afterAll(async () => {
    await clearPolicy(ctx.companyId);
    await clearPolicy(otherCtx.companyId);
    await cleanupTestData(PREFIX);
    await cleanupTestData(OTHER_PREFIX);
    await closeTestServer();
  });

  it("answers /me from canonical membership, ignoring forged company and role input", async () => {
    const agent = await signIn(ctx, `${PREFIX}_createonly`);
    const me = await agent.get("/api/permissions-v2/me").set("X-Role", "Admin");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ companyId: ctx.companyId, role: "Create Only", mode: "shadow", enforced: false });
    expect(me.body.decisions["erp.suppliers"].create.allowed).toBe(true);
    expect(me.body.decisions["erp.suppliers"].edit.allowed).toBe(false);
    expect(me.body.decisions["erp.vouchers"].create.allowed).toBe(false);
    expect(me.body.decisions["system.users"].view.allowed).toBe(false);

    const forged = await agent.get(`/api/permissions-v2/me?companyId=${otherCtx.companyId}`);
    expect(forged.status === 200 ? forged.body.companyId : ctx.companyId).toBe(ctx.companyId);
    if (forged.status !== 200) expect(forged.status).toBeGreaterThanOrEqual(400);

    const adminMe = await admin.get("/api/permissions-v2/me");
    expect(adminMe.status).toBe(200);
    expect(adminMe.body.role).toBe("Admin");
    expect(adminMe.body.decisions["erp.vouchers"].reverse.source).toBe("system_role");
  });

  it("lets only company administrators preview another member, and never outside the company", async () => {
    const preview = await admin.get(`/api/permissions-v2/users/${createOnly.id}/effective`);
    expect(preview.status).toBe(200);
    expect(preview.body.role).toBe("Create Only");
    const outsider = await admin.get(`/api/permissions-v2/users/${otherCtx.userId}/effective`);
    expect(outsider.status).toBe(404);
    expect(outsider.body.code).toBe("USER_NOT_IN_COMPANY");
    const managerAgent = await signIn(ctx, `${PREFIX}_manager`);
    const refused = await managerAgent.get(`/api/permissions-v2/users/${createOnly.id}/effective`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("POLICY_ADMIN_REQUIRED");
    const activation = await managerAgent.put("/api/permissions-v2/activation").send({
      mode: "rolled_back",
      expectedRevision: 0,
      reason: "Manager trying to roll back",
    });
    expect(activation.status).toBe(403);
  });

  it("refuses activation until approved, rejects stale revisions and audits every mode change", async () => {
    const status = await admin.get("/api/permissions-v2/activation");
    expect(status.body).toMatchObject({ mode: "shadow", activationAuthorized: false, enforced: false });
    const start = status.body.revision as number;

    const refused = await admin
      .put("/api/permissions-v2/activation")
      .send({ mode: "active", expectedRevision: start, reason: "Activation without operator approval" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED");
    expect(await revision(admin)).toBe(start);

    await withEnv({ PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" }, async () => {
      const stale = await admin
        .put("/api/permissions-v2/activation")
        .send({ mode: "active", expectedRevision: start + 5, reason: "Activation from a stale screen" });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("POLICY_STALE_REVISION");
      const forgedCompany = await admin
        .put("/api/permissions-v2/activation")
        .send({ mode: "active", expectedRevision: start, reason: "Forged company id", companyId: otherCtx.companyId });
      expect(forgedCompany.status).toBeGreaterThanOrEqual(400);
      const active = await admin
        .put("/api/permissions-v2/activation")
        .send({ mode: "active", expectedRevision: start, reason: "Approved activation for the test" });
      expect(active.status).toBe(200);
      expect(active.body).toMatchObject({ mode: "active", previousMode: "shadow", revision: start + 1 });
    });

    const back = await admin
      .put("/api/permissions-v2/activation")
      .send({ mode: "shadow", expectedRevision: start + 1, reason: "Return to shadow after the test" });
    expect(back.status).toBe(200);
    const audit = await admin.get("/api/permissions-v2/audit?limit=100");
    const modes = audit.body.records.filter((row: { subjectType: string }) => row.subjectType === "policy_mode");
    expect(modes.map((row: { subjectKey: string }) => row.subjectKey)).toEqual(
      expect.arrayContaining(["active", "shadow"])
    );
    const other = await pool.query("SELECT count(*)::int AS n FROM access_policy_change_audit WHERE company_id=$1", [
      otherCtx.companyId,
    ]);
    expect(other.rows[0].n).toBe(0);
  });

  it("enforces a V2 deny only when the company is active and enforcement is on", async () => {
    const start = await revision(admin);
    const saved = await admin.put("/api/permissions-v2/role-rules").send({
      roleKey: "Manager",
      expectedRevision: start,
      reason: "Managers may not add suppliers",
      changes: [{ resource: "erp.suppliers", action: "create", decision: "deny" }],
    });
    expect(saved.status).toBe(200);
    const managerAgent = await signIn(ctx, `${PREFIX}_manager`);

    // Shadow mode with enforcement on: legacy behaviour unchanged.
    await withEnv({ PERMISSIONS_V2_ENFORCEMENT: "enabled" }, async () => {
      const allowed = await managerAgent.post("/api/suppliers").send({ legalName: "V2 Shadow Supplier" });
      expect([200, 201]).toContain(allowed.status);
    });

    await withEnv({ PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" }, async () => {
      const active = await admin
        .put("/api/permissions-v2/activation")
        .send({ mode: "active", expectedRevision: start + 1, reason: "Approved pilot activation" });
      expect(active.status).toBe(200);
    });

    // Active but the enforcement switch off: still legacy.
    const offSwitch = await managerAgent.post("/api/suppliers").send({ legalName: "V2 Switch Off Supplier" });
    expect([200, 201]).toContain(offSwitch.status);

    // Active and enforcement on: refused, nothing written.
    await withEnv({ PERMISSIONS_V2_ENFORCEMENT: "enabled" }, async () => {
      const before = await supplierCount(ctx.companyId);
      const denied = await managerAgent.post("/api/suppliers").send({ legalName: "V2 Denied Supplier" });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("PERMISSION_V2_DENIED");
      expect(await supplierCount(ctx.companyId)).toBe(before);
      // Other operations and other roles are unaffected.
      const customer = await managerAgent.post("/api/customers").send({ legalName: "V2 Allowed Customer" });
      expect([200, 201]).toContain(customer.status);
      const adminSupplier = await admin.post("/api/suppliers").send({ legalName: "V2 Admin Supplier" });
      expect([200, 201]).toContain(adminSupplier.status);
      const me = await managerAgent.get("/api/permissions-v2/me");
      expect(me.body).toMatchObject({ enforced: true });
      expect(me.body.decisions["erp.suppliers"].create).toMatchObject({ allowed: false, source: "v2_active" });
    });

    // Rollback restores legacy access immediately, without a deploy.
    const rolledBack = await admin
      .put("/api/permissions-v2/activation")
      .send({ mode: "rolled_back", expectedRevision: start + 2, reason: "Rollback drill for the test" });
    expect(rolledBack.status).toBe(200);
    await withEnv({ PERMISSIONS_V2_ENFORCEMENT: "enabled" }, async () => {
      const restored = await managerAgent.post("/api/suppliers").send({ legalName: "V2 Restored Supplier" });
      expect([200, 201]).toContain(restored.status);
    });
  });

  it("never lets a V2 allow lift a hard restriction", async () => {
    await admin.put("/api/permissions-v2/activation").send({
      mode: "shadow",
      expectedRevision: await revision(admin),
      reason: "Back to shadow to stage rules",
    });
    const start = await revision(admin);
    const escalate = await admin.put("/api/permissions-v2/user-overrides").send({
      userId: createOnly.id,
      expectedRevision: start,
      reason: "Try to let Create Only edit",
      changes: [{ resource: "erp.suppliers", action: "edit", decision: "allow" }],
    });
    expect(escalate.status).toBe(403);
    expect(escalate.body.code).toBe("CREATE_ONLY_IMMUTABLE");
    const vouchers = await admin.put("/api/permissions-v2/user-overrides").send({
      userId: createOnly.id,
      expectedRevision: start,
      reason: "Allow Create Only to add vouchers",
      changes: [{ resource: "erp.vouchers", action: "create", decision: "allow" }],
    });
    expect(vouchers.status).toBe(200);
    await withEnv({ PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled", PERMISSIONS_V2_ENFORCEMENT: "enabled" }, async () => {
      await admin
        .put("/api/permissions-v2/activation")
        .send({ mode: "active", expectedRevision: start + 1, reason: "Activate to test hard limits" });
      const agent = await signIn(ctx, `${PREFIX}_createonly`);
      const me = await agent.get("/api/permissions-v2/me");
      expect(me.body.decisions["erp.vouchers"].create).toMatchObject({ allowed: false, source: "hard_restriction" });
      const voucher = await agent.post("/api/vouchers").send({});
      expect(voucher.status).toBe(403);
    });
    await admin
      .put("/api/permissions-v2/activation")
      .send({ mode: "shadow", expectedRevision: start + 2, reason: "Return to shadow after hard limits" });
    const self = await admin.put("/api/permissions-v2/user-overrides").send({
      userId: ctx.userId,
      expectedRevision: start + 3,
      reason: "Grant myself more access",
      changes: [{ resource: "erp.vouchers", action: "view", decision: "allow" }],
    });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("SELF_ESCALATION_FORBIDDEN");
  });

  it("protects the last company administrator and refuses self role changes", async () => {
    const [ownRow] = await db
      .select({ id: schema.userCompanyRoles.id })
      .from(schema.userCompanyRoles)
      .where(and(eq(schema.userCompanyRoles.userId, ctx.userId), eq(schema.userCompanyRoles.companyId, ctx.companyId)));
    const selfDemote = await admin.patch(`/api/user-company-roles/${ownRow.id}`).send({ role: "Manager" });
    expect(selfDemote.status).toBe(403);
    expect(selfDemote.body.code).toBe("SELF_ROLE_CHANGE_FORBIDDEN");
    const selfDelete = await admin.delete(`/api/user-company-roles/${ownRow.id}`);
    expect(selfDelete.status).toBe(403);

    // Two Admins demoting each other at the same time: one must fail.
    const second = await addMember(ctx, "admin2", "Admin");
    const secondAgent = await signIn(ctx, `${PREFIX}_admin2`);
    const results = await Promise.all([
      admin.patch(`/api/user-company-roles/${second.roleRowId}`).send({ role: "Manager" }),
      secondAgent.patch(`/api/user-company-roles/${ownRow.id}`).send({ role: "Manager" }),
    ]);
    const admins = await pool.query(
      "SELECT count(*)::int AS n FROM user_company_roles WHERE company_id=$1 AND role='Admin'",
      [ctx.companyId]
    );
    expect(admins.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);

    // A Developer cannot remove the last Admin either.
    const developer = await addMember(ctx, "developer", "Developer");
    const devAgent = await signIn(ctx, `${PREFIX}_developer`);
    const remaining = await pool.query(
      "SELECT id, user_id FROM user_company_roles WHERE company_id=$1 AND role='Admin' ORDER BY id",
      [ctx.companyId]
    );
    expect(remaining.rows).toHaveLength(1);
    const lastRowId = remaining.rows[0].id as number;
    const lastUserId = remaining.rows[0].user_id as string;
    const removeLast = await devAgent.delete(`/api/user-company-roles/${lastRowId}`);
    expect(removeLast.status).toBe(409);
    expect(removeLast.body.code).toBe("LAST_COMPANY_ADMINISTRATOR");
    const demoteLast = await devAgent.patch(`/api/user-company-roles/${lastRowId}`).send({ role: "Owner" });
    expect(demoteLast.status).toBe(409);
    const deleteAccount = await devAgent.delete(`/api/users/${lastUserId}`);
    expect(deleteAccount.status).toBe(409);
    const stillThere = await pool.query("SELECT role FROM user_company_roles WHERE id=$1", [lastRowId]);
    expect(stillThere.rows[0].role).toBe("Admin");
    expect(developer.id).toBeTruthy();
  });
});
