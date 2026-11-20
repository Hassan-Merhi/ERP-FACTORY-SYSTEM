/**
 * Factory user management (server/routes/factory/docs-users/registerFactoryUsersAccessRoutes.ts),
 * security paths: manager-only access, password step-up, Developer accounts
 * hidden from and protected against tenant Admins, global credentials
 * changeable only by a Developer, another company's user id on PUT/DELETE,
 * self-removal, and my-access for full and restricted users.
 */
import { describe, expect, it } from "vitest";

import { FACTORY_SETTINGS_PAGES } from "../shared/factoryAccessRegistry";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PASSWORD = "rolledback-pass-123";
const PAGE = FACTORY_SETTINGS_PAGES[0].key;
let ipSeq = 0;
/** The privileged-mutation limiter keys on the client address. */
const ip = () => `10.77.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;

type Agent = FactoryWorld["agent"];

async function confirm(agent: Agent) {
  const res = await agent.post("/api/auth/confirm-password").send({ password: PASSWORD });
  expect(res.status).toBe(200);
}

const userIdOf = async (w: FactoryWorld, suffix: string) =>
  String((await w.q(`SELECT id FROM users WHERE username = $1`, [`${w.tag.toLowerCase()}_${suffix}`]))[0].id);

async function member(w: FactoryWorld, name: string, role: string, companyId = w.companyId) {
  const [{ id }] = await w.q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
    `${w.tag}_${name}`,
  ]);
  await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [id, companyId, role]);
  return id;
}

describe("GET /api/factory/users", () => {
  it("refuses non-managers and hides Developer accounts from tenant Admins", async () => {
    await withFactoryWorld(async (w) => {
      const normal = await w.agentFor("Normal User");
      expect((await normal.get("/api/factory/users")).status).toBe(403);

      const dev = await member(w, "dev", "Developer");
      const worker = await member(w, "worker", "Normal User");
      await w.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, has_erp_access, hide_all_costs) VALUES ($1, $2, 'Worky', false, true)`,
        [w.companyId, worker]
      );
      await w.q(`INSERT INTO factory_user_page_access (company_id, user_id, page_key) VALUES ($1, $2, $3)`, [
        w.companyId,
        worker,
        PAGE,
      ]);
      const list = await w.agent.get("/api/factory/users");
      expect(list.status).toBe(200);
      const ids = list.body.map((u: { id: string }) => u.id);
      expect(ids).not.toContain(dev);
      expect(list.body.find((u: { id: string }) => u.id === worker)).toMatchObject({
        displayName: "Worky",
        hasErpAccess: false,
        hasFactoryAccess: true,
        hideAllCosts: true,
        pageAccess: [PAGE],
      });
      expect(list.body.find((u: { id: string }) => u.id === w.userId)).toMatchObject({
        displayName: null,
        pageAccess: [],
      });

      const developer = await w.agentFor("Developer");
      const devList = await developer.get("/api/factory/users");
      expect(devList.body.map((u: { id: string }) => u.id)).toContain(dev);
    });
  });
});

describe("POST /api/factory/users", () => {
  it("requires password step-up and a manager, then validates the new user", async () => {
    await withFactoryWorld(async (w) => {
      const post = (agent: Agent, body: Record<string, unknown>) =>
        agent.post("/api/factory/users").set("X-Forwarded-For", ip()).send(body);
      const unconfirmed = await post(w.agent, { username: "x", password: "abcd" });
      expect(unconfirmed.status).toBe(403);
      expect(unconfirmed.body.message).toBe("Password confirmation required");

      const normal = await w.agentFor("Normal User");
      await confirm(normal);
      expect((await post(normal, { username: "x", password: "abcd" })).status).toBe(403);

      await confirm(w.agent);
      expect((await post(w.agent, { username: "x" })).body.message).toBe("Username and password are required");
      expect((await post(w.agent, { username: "x", password: "abc" })).body.message).toBe(
        "Password must be at least 4 characters"
      );
      expect((await post(w.agent, { username: w.username, password: "abcd" })).body.message).toBe(
        "Username already exists"
      );

      const username = `${w.tag}_new`;
      const created = await post(w.agent, {
        username,
        password: "abcd",
        pageAccess: [PAGE, "not-a-page"],
        hasErpAccess: false,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ username, displayName: username, hasErpAccess: false, pageAccess: [PAGE] });
      expect(created.body.password).toBeUndefined();
      const [role] = await w.q(`SELECT role FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [
        created.body.id,
        w.companyId,
      ]);
      expect(role.role).toBe("Normal User");

      const bare = await post(w.agent, { username: `${w.tag}_bare`, password: "abcd", displayName: "Bare" });
      expect(bare.body).toMatchObject({ displayName: "Bare", hasFactoryAccess: true, pageAccess: [] });
    });
  });
});

describe("PUT /api/factory/users/:userId", () => {
  it("refuses another company's user, Developer targets, and credential changes by a tenant Admin", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await member(w, "foreign", "Normal User", other);
      const dev = await member(w, "dev", "Developer");
      const worker = await member(w, "worker", "Normal User");
      await confirm(w.agent);
      const put = (id: string, body: Record<string, unknown>) =>
        w.agent.put(`/api/factory/users/${id}`).set("X-Forwarded-For", ip()).send(body);

      expect((await put(foreign, { displayName: "pwned" })).status).toBe(404);
      expect((await w.q(`SELECT 1 FROM factory_user_profiles WHERE user_id = $1`, [foreign])).length).toBe(0);
      expect((await put(dev, { displayName: "x" })).body.message).toBe("Cannot modify this account");
      const cred = await put(worker, { password: "newpass" });
      expect(cred.status).toBe(403);
      expect(cred.body.message).toBe("Only Developer can change global user credentials");
      expect((await put(worker, { username: "renamed" })).status).toBe(403);

      const normal = await w.agentFor("Normal User");
      await confirm(normal);
      const self = await normal.put(`/api/factory/users/${worker}`).set("X-Forwarded-For", ip()).send({});
      expect(self.status).toBe(403);
    });
  });

  it("creates a missing profile, replaces page access and reports a tenant-only update", async () => {
    await withFactoryWorld(async (w) => {
      const worker = await member(w, "worker", "Normal User");
      await confirm(w.agent);
      const put = (body: Record<string, unknown>) =>
        w.agent.put(`/api/factory/users/${worker}`).set("X-Forwarded-For", ip()).send(body);

      const first = await put({ pageAccess: [PAGE], hiddenCostFields: ["inventory_avg_rate"], hideAllCosts: 1 });
      expect(first.body).toEqual({ message: "User access updated" });
      const [profile] = await w.q(
        `SELECT display_name, hide_all_costs, hidden_cost_fields FROM factory_user_profiles WHERE user_id = $1 AND company_id = $2`,
        [worker, w.companyId]
      );
      expect(profile).toMatchObject({ display_name: "User", hide_all_costs: true });

      const second = await put({
        displayName: "Named",
        hasErpAccess: false,
        hasFactoryAccess: false,
        hideAllCosts: false,
        hiddenCostFields: [],
        pageAccess: [],
      });
      expect(second.status).toBe(200);
      const [updated] = await w.q(
        `SELECT display_name, has_erp_access, has_factory_access, hide_all_costs FROM factory_user_profiles WHERE user_id = $1`,
        [worker]
      );
      expect(updated).toEqual({
        display_name: "Named",
        has_erp_access: false,
        has_factory_access: false,
        hide_all_costs: false,
      });
      expect(await w.q(`SELECT 1 FROM factory_user_page_access WHERE user_id = $1`, [worker])).toEqual([]);
    });
  });

  it("lets a Developer change credentials, refusing a short password or a taken username", async () => {
    await withFactoryWorld(async (w) => {
      const worker = await member(w, "worker", "Normal User");
      const dev = await member(w, "dev2", "Developer");
      const developer = await w.agentFor("Developer");
      await confirm(developer);
      const put = (id: string, body: Record<string, unknown>) =>
        developer.put(`/api/factory/users/${id}`).set("X-Forwarded-For", ip()).send(body);

      expect((await put(worker, { password: "abc" })).body.message).toBe("Password must be at least 4 characters");
      const taken = await put(worker, { username: w.username });
      expect(taken.status).toBe(500);
      expect(taken.body.message).toBe("Username already taken");

      const renamed = await put(worker, { username: `  ${w.tag}_renamed  `, password: "longer1" });
      expect(renamed.body).toEqual({ message: "User updated" });
      const [row] = await w.q(`SELECT username FROM users WHERE id = $1`, [worker]);
      expect(row.username).toBe(`${w.tag}_renamed`);
      expect((await put(dev, { displayName: "Dev" })).body).toEqual({ message: "User access updated" });
    });
  });
});

describe("DELETE /api/factory/users/:userId", () => {
  it("refuses self-removal, another company's user and Developer targets; removes only this company's rows", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await member(w, "foreign", "Normal User", other);
      const dev = await member(w, "dev", "Developer");
      const worker = await member(w, "worker", "Normal User");
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Normal User')`, [
        worker,
        other,
      ]);
      await w.q(`INSERT INTO factory_user_profiles (company_id, user_id, display_name) VALUES ($1, $2, 'W')`, [
        w.companyId,
        worker,
      ]);
      await confirm(w.agent);
      const del = (id: string) => w.agent.delete(`/api/factory/users/${id}`).set("X-Forwarded-For", ip());

      expect((await del(w.userId)).body.message).toBe("You cannot remove your own account");
      expect((await del(foreign)).status).toBe(404);
      expect((await del(dev)).body.message).toBe("Cannot remove this account");
      const removed = await del(worker);
      expect(removed.body).toEqual({ message: "User access removed from this company" });
      const roles = await w.q(`SELECT company_id FROM user_company_roles WHERE user_id = $1`, [worker]);
      expect(roles).toEqual([{ company_id: other }]);
      expect(await w.q(`SELECT 1 FROM users WHERE id = $1`, [worker])).toHaveLength(1);

      const normal = await w.agentFor("Normal User");
      await confirm(normal);
      expect((await normal.delete(`/api/factory/users/${foreign}`).set("X-Forwarded-For", ip())).status).toBe(403);
    });
  });
});

describe("GET /api/factory/my-access", () => {
  it("gives managers full access, served from the pinned factory on the next call", async () => {
    await withFactoryWorld(async (w) => {
      const first = await w.agent.get("/api/factory/my-access");
      expect(first.body).toMatchObject({ fullAccess: true, companyId: w.companyId, companyName: w.tag });
      const second = await w.agent.get("/api/factory/my-access");
      expect(second.body).toMatchObject({ fullAccess: true, companyName: w.tag });
    });
  });

  it("restricts a user to their page keys and hides all cost fields when asked", async () => {
    await withFactoryWorld(async (w) => {
      const normal = await w.agentFor("Manager");
      const id = await userIdOf(w, "u1");
      const open = await normal.get("/api/factory/my-access");
      expect(open.body).toMatchObject({ fullAccess: true, pageKeys: [], hasErpAccess: true, hideAllCosts: false });
      expect(open.body.hiddenCostFields).not.toContain("inventory_avg_rate");

      await w.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, has_factory_access, hide_all_costs) VALUES ($1, $2, 'N', false, true)`,
        [w.companyId, id]
      );
      await w.q(`INSERT INTO factory_user_page_access (company_id, user_id, page_key) VALUES ($1, $2, $3)`, [
        w.companyId,
        id,
        PAGE,
      ]);
      const restricted = await normal.get("/api/factory/my-access");
      expect(restricted.body).toMatchObject({
        fullAccess: false,
        pageKeys: [PAGE],
        hasFactoryAccess: false,
        hideAllCosts: true,
      });
      expect(restricted.body.hiddenCostFields).toEqual(
        expect.arrayContaining(["inventory_avg_rate", "hide_proforma_price"])
      );
    });
  });
});
