/**
 * User administration routes: global user accounts, password resets and
 * company role assignments. Every refusal (role, wrong company, Developer
 * protection, self change, last administrator) is checked to leave the stored
 * rows unchanged. One rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PASSWORD = "rolledback-pass-123";

async function addUser(w: FactoryWorld, suffix: string, companyId: number | null, role = "Manager") {
  const [user] = await w.q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`, [
    `${w.tag.toLowerCase()}_${suffix}`,
    await bcrypt.hash(PASSWORD, 4),
  ]);
  let roleId: number | null = null;
  if (companyId !== null) {
    roleId = await w.one(
      `INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3) RETURNING id`,
      [user.id, companyId, role]
    );
  }
  return { id: String(user.id), roleId: roleId as number, username: `${w.tag.toLowerCase()}_${suffix}` };
}

async function otherCompany(w: FactoryWorld) {
  return w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}X`]);
}

/** Make the world's user a Developer and refresh the session's cached role. */
async function asDeveloper(w: FactoryWorld) {
  await w.setRole("Developer");
  const res = await w.agent.post("/api/auth/set-company").send({ companyId: w.companyId });
  expect(res.status).toBe(200);
}

const hashOf = async (w: FactoryWorld, id: string) =>
  (await w.q<{ password: string }>(`SELECT password FROM users WHERE id = $1`, [id]))[0]?.password;
const rolesOf = (w: FactoryWorld, id: string) =>
  w.q<{ company_id: number; role: string }>(
    `SELECT company_id, role FROM user_company_roles WHERE user_id = $1 ORDER BY company_id`,
    [id]
  );

describe("global user accounts", () => {
  it("lists only this company's non-Developer users and refuses non-admins", async () => {
    await withFactoryWorld(async (w) => {
      const colleague = await addUser(w, "colleague", w.companyId);
      const developer = await addUser(w, "dev", w.companyId, "Developer");
      const outsider = await addUser(w, "outsider", await otherCompany(w));
      const res = await w.agent.get("/api/users");
      expect(res.status).toBe(200);
      const ids = res.body.map((user: { id: string }) => user.id);
      expect(ids).toEqual(expect.arrayContaining([w.userId, colleague.id]));
      expect(ids).not.toContain(developer.id);
      expect(ids).not.toContain(outsider.id);
      expect(res.body.every((user: Record<string, unknown>) => !("password" in user))).toBe(true);

      const manager = await w.agentFor("Manager");
      expect((await manager.get("/api/users")).status).toBe(403);
    });
  });

  it("creates users, refusing duplicates and invalid bodies", async () => {
    await withFactoryWorld(async (w) => {
      const username = `${w.tag.toLowerCase()}_new`;
      const created = await w.agent.post("/api/users").send({ username, password: "secret-123" });
      expect(created.status).toBe(201);
      expect(created.body.password).toBeUndefined();
      expect(await bcrypt.compare("secret-123", await hashOf(w, created.body.id))).toBe(true);

      const duplicate = await w.agent.post("/api/users").send({ username, password: "secret-123" });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.message).toBe("Username already exists");
      expect((await w.agent.post("/api/users").send({ password: "x" })).status).toBe(400);
      const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE username = $1`, [username]);
      expect(n).toBe(1);
    });
  });

  it("updates a company user, rotates passwords and refuses users of another company", async () => {
    await withFactoryWorld(async (w) => {
      const colleague = await addUser(w, "colleague", w.companyId);
      const renamed = await w.agent.patch(`/api/users/${colleague.id}`).send({ active: false });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ id: colleague.id, active: false });
      expect(renamed.body.password).toBeUndefined();

      const before = await hashOf(w, colleague.id);
      const rotated = await w.agent.patch(`/api/users/${colleague.id}`).send({ password: "rotated-123" });
      expect(rotated.status).toBe(200);
      expect(await hashOf(w, colleague.id)).not.toBe(before);
      expect(await bcrypt.compare("rotated-123", await hashOf(w, colleague.id))).toBe(true);

      // Own password through the admin route keeps this session alive.
      const self = await w.agent.patch(`/api/users/${w.userId}`).send({ password: "self-rotated-1" });
      expect(self.status).toBe(200);
      expect((await w.agent.get("/api/auth/me")).status).toBe(200);

      const outsider = await addUser(w, "outsider", await otherCompany(w));
      const outsiderHash = await hashOf(w, outsider.id);
      const refused = await w.agent.patch(`/api/users/${outsider.id}`).send({ active: false, password: "taken-over" });
      expect(refused.status).toBe(404);
      const [row] = await w.q<{ active: boolean }>(`SELECT active FROM users WHERE id = $1`, [outsider.id]);
      expect(row.active).toBe(true);
      expect(await hashOf(w, outsider.id)).toBe(outsiderHash);
    });
  });

  it("answers 404 for a missing user when the actor may address any account", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const res = await w.agent.patch(`/api/users/00000000-0000-0000-0000-000000000000`).send({});
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("User not found");
    });
  });

  it("refuses deleting yourself, a Developer, another company's user or a last administrator", async () => {
    await withFactoryWorld(async (w) => {
      const self = await w.agent.delete(`/api/users/${w.userId}`);
      expect(self.status).toBe(400);
      expect(self.body.message).toBe("Cannot delete your own account");

      const developer = await addUser(w, "dev", w.companyId, "Developer");
      expect((await w.agent.delete(`/api/users/${developer.id}`)).status).toBe(404);
      const outsider = await addUser(w, "outsider", await otherCompany(w));
      expect((await w.agent.delete(`/api/users/${outsider.id}`)).status).toBe(404);
      expect(await rolesOf(w, developer.id)).toHaveLength(1);
      expect(await rolesOf(w, outsider.id)).toHaveLength(1);

      const colleague = await addUser(w, "colleague", w.companyId);
      const deleted = await w.agent.delete(`/api/users/${colleague.id}`);
      expect(deleted.status).toBe(200);
      expect(await w.q(`SELECT 1 FROM users WHERE id = $1`, [colleague.id])).toEqual([]);
    });
  });

  it("lets a Developer delete accounts but never a company's last administrator", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const companyId = await otherCompany(w);
      const soleAdmin = await addUser(w, "soleadmin", companyId, "Admin");
      const res = await w.agent.delete(`/api/users/${soleAdmin.id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("LAST_COMPANY_ADMINISTRATOR");
      expect(await rolesOf(w, soleAdmin.id)).toEqual([{ company_id: companyId, role: "Admin" }]);

      const developer = await addUser(w, "dev", w.companyId, "Developer");
      expect((await w.agent.delete(`/api/users/${developer.id}`)).status).toBe(200);
    });
  });
});

describe("password changes", () => {
  it("validates the self-service change and keeps the hash on refusal", async () => {
    await withFactoryWorld(async (w) => {
      const before = await hashOf(w, w.userId);
      const bad: Array<[Record<string, unknown>, number]> = [
        [{ newPassword: "abcdefg" }, 400],
        [{ currentPassword: PASSWORD, newPassword: "abc" }, 400],
        [{ currentPassword: "wrong", newPassword: "abcdefg" }, 400],
      ];
      for (const [body, status] of bad) {
        expect((await w.agent.post("/api/user/change-password").send(body)).status).toBe(status);
      }
      expect(await hashOf(w, w.userId)).toBe(before);
      const ok = await w.agent
        .post("/api/user/change-password")
        .send({ currentPassword: PASSWORD, newPassword: "changed-123" });
      expect(ok.status).toBe(200);
      expect(await bcrypt.compare("changed-123", await hashOf(w, w.userId))).toBe(true);
      expect((await w.agent.get("/api/auth/me")).status).toBe(200);
    });
  });

  it("resets a company user's password and refuses invalid input or another company's user", async () => {
    await withFactoryWorld(async (w) => {
      const colleague = await addUser(w, "colleague", w.companyId);
      expect((await w.agent.post(`/api/admin/reset-password/${colleague.id}`).send({})).status).toBe(400);
      expect(
        (await w.agent.post(`/api/admin/reset-password/${colleague.id}`).send({ newPassword: "abc" })).status
      ).toBe(400);
      const ok = await w.agent.post(`/api/admin/reset-password/${colleague.id}`).send({ newPassword: "reset-123" });
      expect(ok.status).toBe(200);
      expect(ok.body.message).toContain(colleague.username);
      expect(await bcrypt.compare("reset-123", await hashOf(w, colleague.id))).toBe(true);

      const outsider = await addUser(w, "outsider", await otherCompany(w));
      const before = await hashOf(w, outsider.id);
      expect(
        (await w.agent.post(`/api/admin/reset-password/${outsider.id}`).send({ newPassword: "takeover-1" })).status
      ).toBe(404);
      expect(await hashOf(w, outsider.id)).toBe(before);

      const manager = await w.agentFor("Manager");
      expect(
        (await manager.post(`/api/admin/reset-password/${colleague.id}`).send({ newPassword: "x-123456" })).status
      ).toBe(403);
    });
  });

  it("answers 404 when a Developer resets a missing account", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      const res = await w.agent
        .post(`/api/admin/reset-password/00000000-0000-0000-0000-000000000000`)
        .send({ newPassword: "reset-123" });
      expect(res.status).toBe(404);
    });
  });
});
