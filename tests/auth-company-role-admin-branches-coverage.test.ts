/**
 * Company role assignment routes (/api/user-company-roles and the per-user
 * role listing). Refusals for wrong company, Developer escalation, Create Only,
 * POS without a location, duplicates, self changes and last-administrator
 * removal are each checked to leave the role rows and audit log unchanged.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function addUser(w: FactoryWorld, suffix: string, companyId: number | null, role = "Manager") {
  const [user] = await w.q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`, [
    `${w.tag.toLowerCase()}_${suffix}`,
    await bcrypt.hash("pw-123456", 4),
  ]);
  const roleId =
    companyId === null
      ? 0
      : await w.one(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3) RETURNING id`, [
          user.id,
          companyId,
          role,
        ]);
  return { id: String(user.id), roleId };
}

/** Make the world's user a Developer and refresh the session's cached role. */
async function asDeveloper(w: FactoryWorld) {
  await w.setRole("Developer");
  const res = await w.agent.post("/api/auth/set-company").send({ companyId: w.companyId });
  expect(res.status).toBe(200);
}

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}X`]);
const rolesOf = (w: FactoryWorld, id: string) =>
  w.q<{ company_id: number; role: string }>(
    `SELECT company_id, role FROM user_company_roles WHERE user_id = $1 ORDER BY company_id`,
    [id]
  );
const roleAudits = (w: FactoryWorld) =>
  w.q<{ action: string; record_identifier: string; changes: unknown }>(
    `SELECT action, record_identifier, changes FROM audit_log WHERE table_name = 'user_company_roles' AND company_id = $1 ORDER BY id`,
    [w.companyId]
  );

describe("GET /api/users/:userId/company-roles", () => {
  it("shows only this company's roles and hides other companies' users", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const shared = await addUser(w, "shared", w.companyId);
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
        shared.id,
        other,
      ]);
      const res = await w.agent.get(`/api/users/${shared.id}/company-roles`);
      expect(res.status).toBe(200);
      expect(res.body.map((row: { companyId: number }) => row.companyId)).toEqual([w.companyId]);

      const outsider = await addUser(w, "outsider", other);
      expect((await w.agent.get(`/api/users/${outsider.id}/company-roles`)).status).toBe(404);
    });
  });
});

describe("POST /api/user-company-roles", () => {
  it("refuses wrong company, Developer, Create Only, POS without location, duplicates and bad bodies", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const target = await addUser(w, "target", null);
      const post = (body: Record<string, unknown>) => w.agent.post("/api/user-company-roles").send(body);

      const cross = await post({ userId: target.id, companyId: other, role: "Admin" });
      expect(cross.status).toBe(403);
      expect((await post({ userId: target.id, companyId: w.companyId, role: "Developer" })).status).toBe(403);
      const createOnly = await post({ userId: target.id, companyId: w.companyId, role: "Create Only" });
      expect(createOnly.status).toBe(409);
      expect(createOnly.body.code).toBe("CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED");
      const pos = await post({ userId: target.id, companyId: w.companyId, role: "POS" });
      expect(pos.status).toBe(400);
      expect(pos.body.message).toContain("assigned location");
      expect((await post({ companyId: w.companyId, role: "Manager" })).status).toBe(400);

      const developer = await addUser(w, "dev", null, "Developer");
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Developer')`, [
        developer.id,
        other,
      ]);
      expect((await post({ userId: developer.id, companyId: w.companyId, role: "Manager" })).status).toBe(404);

      expect(await rolesOf(w, target.id)).toEqual([]);
      const existing = await addUser(w, "existing", w.companyId);
      const dup = await post({ userId: existing.id, companyId: w.companyId, role: "View Only" });
      expect(dup.status).toBe(409);
      expect(await rolesOf(w, existing.id)).toEqual([{ company_id: w.companyId, role: "Manager" }]);
      expect(await roleAudits(w)).toEqual([]);
    });
  });

  it("creates a role with its audit row and seeds ERP Tester page access", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await addUser(w, "mgr", null);
      const created = await w.agent
        .post("/api/user-company-roles")
        .send({ userId: manager.id, companyId: w.companyId, role: "Manager" });
      expect(created.status).toBe(201);
      expect(await rolesOf(w, manager.id)).toEqual([{ company_id: w.companyId, role: "Manager" }]);

      const tester = await addUser(w, "tester", null);
      const res = await w.agent
        .post("/api/user-company-roles")
        .send({ userId: tester.id, companyId: w.companyId, role: "ERP Tester" });
      expect(res.status).toBe(201);
      const [{ n }] = await w.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM erp_user_page_access WHERE user_id = $1 AND company_id = $2`,
        [tester.id, w.companyId]
      );
      expect(n).toBeGreaterThan(0);
      const audits = await roleAudits(w);
      expect(audits.map((row) => row.action)).toEqual(["create", "create"]);
      expect(audits[1].record_identifier).toContain("role:ERP Tester");
    });
  });
});

describe("PATCH /api/user-company-roles/:id", () => {
  it("refuses POS without location, Developer, Create Only, self change and another company's row", async () => {
    await withFactoryWorld(async (w) => {
      const colleague = await addUser(w, "colleague", w.companyId);
      const patch = (id: number, body: Record<string, unknown>) =>
        w.agent.patch(`/api/user-company-roles/${id}`).send(body);
      expect((await patch(colleague.roleId, { role: "POS" })).status).toBe(400);
      expect((await patch(colleague.roleId, { role: "Developer" })).status).toBe(403);
      expect((await patch(colleague.roleId, { role: "Create Only" })).body.code).toBe(
        "CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED"
      );

      const [own] = await w.q<{ id: number }>(`SELECT id FROM user_company_roles WHERE user_id = $1`, [w.userId]);
      const self = await patch(own.id, { role: "Manager" });
      expect(self.status).toBe(403);
      expect(self.body.code).toBe("SELF_ROLE_CHANGE_FORBIDDEN");

      const outsider = await addUser(w, "outsider", await otherCompany(w));
      expect((await patch(outsider.roleId, { role: "View Only" })).status).toBe(404);
      expect((await patch(999999999, { role: "View Only" })).status).toBe(404);

      expect(await rolesOf(w, colleague.id)).toEqual([{ company_id: w.companyId, role: "Manager" }]);
      expect(await rolesOf(w, w.userId)).toEqual([{ company_id: w.companyId, role: "Admin" }]);
      expect(await roleAudits(w)).toEqual([]);
    });
  });

  it("changes a role with audited field changes, keeps own row when unchanged, and reseeds ERP Tester pages", async () => {
    await withFactoryWorld(async (w) => {
      const colleague = await addUser(w, "colleague", w.companyId);
      const res = await w.agent.patch(`/api/user-company-roles/${colleague.roleId}`).send({ role: "View Only" });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("View Only");

      const [own] = await w.q<{ id: number }>(`SELECT id FROM user_company_roles WHERE user_id = $1`, [w.userId]);
      const same = await w.agent.patch(`/api/user-company-roles/${own.id}`).send({ role: "Admin" });
      expect(same.status).toBe(200);

      const tester = await w.agent.patch(`/api/user-company-roles/${colleague.roleId}`).send({ role: "ERP Tester" });
      expect(tester.status).toBe(200);
      const [{ n }] = await w.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM erp_user_page_access WHERE user_id = $1`,
        [colleague.id]
      );
      expect(n).toBeGreaterThan(0);

      const audits = await roleAudits(w);
      expect(audits).toHaveLength(3);
      expect(audits[0].changes).toEqual({ role: { old: "Manager", new: "View Only" } });
      expect(audits[1].changes).toBeNull();
    });
  });

  it("refuses demoting a company's last administrator, even for a Developer", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const admin = await addUser(w, "soleadmin", w.companyId, "Admin");
      const res = await w.agent.patch(`/api/user-company-roles/${admin.roleId}`).send({ role: "Manager" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("LAST_COMPANY_ADMINISTRATOR");
      expect(await rolesOf(w, admin.id)).toEqual([{ company_id: w.companyId, role: "Admin" }]);
    });
  });

  it("refuses moving a company's last administrator row to another company", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const other = await otherCompany(w);
      await addUser(w, "otheradmin", other, "Admin");
      const admin = await addUser(w, "soleadmin", w.companyId, "Admin");
      const res = await w.agent
        .patch(`/api/user-company-roles/${admin.roleId}`)
        .send({ companyId: other, role: "Admin" });
      expect(res.status).toBe(409);
      expect(await rolesOf(w, admin.id)).toEqual([{ company_id: w.companyId, role: "Admin" }]);
    });
  });

  it("does not let a tenant Admin move a role row into another company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const colleague = await addUser(w, "colleague", w.companyId);
      const res = await w.agent
        .patch(`/api/user-company-roles/${colleague.roleId}`)
        .send({ companyId: other, role: "Admin" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");
      expect(await rolesOf(w, colleague.id)).toEqual([{ company_id: w.companyId, role: "Manager" }]);
      expect(await roleAudits(w)).toEqual([]);
    });
  });

  it("refuses moving a role row to another user, including a Developer that POST refuses", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const developer = await addUser(w, "dev", other, "Developer");
      const refused = await w.agent
        .post("/api/user-company-roles")
        .send({ userId: developer.id, companyId: w.companyId, role: "Manager" });
      expect(refused.status).toBe(404);

      const colleague = await addUser(w, "colleague", w.companyId);
      const res = await w.agent
        .patch(`/api/user-company-roles/${colleague.roleId}`)
        .send({ userId: developer.id, role: "Admin" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("ROLE_ASSIGNMENT_USER_IMMUTABLE");
      expect(await rolesOf(w, developer.id)).toEqual([{ company_id: other, role: "Developer" }]);
      expect(await rolesOf(w, colleague.id)).toEqual([{ company_id: w.companyId, role: "Manager" }]);

      // The settings screen echoes the row's own userId on every edit; that still works.
      const echoed = await w.agent
        .patch(`/api/user-company-roles/${colleague.roleId}`)
        .send({ userId: colleague.id, role: "View Only" });
      expect(echoed.status).toBe(200);
      expect(await rolesOf(w, colleague.id)).toEqual([{ company_id: w.companyId, role: "View Only" }]);
    });
  });
});

describe("DELETE /api/user-company-roles/:id", () => {
  it("refuses removing your own role or another company's row, then deletes with an audit row", async () => {
    await withFactoryWorld(async (w) => {
      const [own] = await w.q<{ id: number }>(`SELECT id FROM user_company_roles WHERE user_id = $1`, [w.userId]);
      const self = await w.agent.delete(`/api/user-company-roles/${own.id}`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe("SELF_ROLE_CHANGE_FORBIDDEN");

      const outsider = await addUser(w, "outsider", await otherCompany(w));
      expect((await w.agent.delete(`/api/user-company-roles/${outsider.roleId}`)).status).toBe(404);
      expect(await rolesOf(w, outsider.id)).toHaveLength(1);

      const colleague = await addUser(w, "colleague", w.companyId);
      expect((await w.agent.delete(`/api/user-company-roles/${colleague.roleId}`)).status).toBe(204);
      expect(await rolesOf(w, colleague.id)).toEqual([]);
      expect((await roleAudits(w)).map((row) => row.action)).toEqual(["delete"]);
    });
  });

  it("refuses removing the last administrator row, even for a Developer", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const admin = await addUser(w, "soleadmin", w.companyId, "Admin");
      const res = await w.agent.delete(`/api/user-company-roles/${admin.roleId}`);
      expect(res.status).toBe(409);
      expect(await rolesOf(w, admin.id)).toHaveLength(1);
    });
  });
});
