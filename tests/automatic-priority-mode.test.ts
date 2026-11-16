/**
 * Phase 1 regression contract: company-scoped, OFF-by-default automatic
 * priority mode. Tests are intentionally committed without being run;
 * CI and integration verification are delegated to Claude.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "aprmode";
const ENDPOINT = "/api/factory/automatic-priority-mode";

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function setRole(role: string) {
  await pool.query("UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3", [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  const response = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [ctx.companyId]);
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
    ctx.userId,
    ctx.companyId,
  ]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status}`);
}, 120000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Automatic Priority Printing company switch (Phase 1)", () => {
  it("defaults OFF for a company with no prior setting and exposes editability", async () => {
    const response = await agent.get(ENDPOINT);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ enabled: false, canEdit: true });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("requires an exact boolean payload and rejects cross-company body fields", async () => {
    for (const body of [
      { enabled: "true" },
      { enabled: 1 },
      { enabled: true, companyId: ctx.companyId + 1 },
      { enabled: true, arbitrary: "value" },
      {},
    ]) {
      const response = await agent.put(ENDPOINT).send(body);
      // A foreign companyId is stopped earlier by the shared tenant guard (403);
      // every other malformed payload is rejected by the route itself (400).
      expect(response.status).toBe("companyId" in body ? 403 : 400);
    }
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);
  });

  it("persists ON, records an audit event and does not repeat audit on no-op", async () => {
    const on = await agent.put(ENDPOINT).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, changed: true });

    const again = await agent.put(ENDPOINT).send({ enabled: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ enabled: true, changed: false });

    const stored = await pool.query<{ value: string }>(
      `SELECT extra_settings->>'automaticPriorityPrintingEnabled' AS value
       FROM factory_settings WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(stored.rows[0]?.value).toBe("true");
    // Creating the mode flag must not silently turn off the existing Factory
    // intelligence features when the settings row did not yet exist.
    const defaults = await pool.query<{ dashboardEnabled: boolean; rolesEnabled: boolean }>(
      'SELECT dashboard_enabled AS "dashboardEnabled", roles_enabled AS "rolesEnabled" FROM factory_settings WHERE company_id = $1',
      [ctx.companyId]
    );
    expect(defaults.rows[0]).toMatchObject({ dashboardEnabled: true, rolesEnabled: true });
    const audit = await pool.query<{ changes: Record<string, { old: boolean; new: boolean }> }>(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND action = 'settings_change'
       AND record_identifier = 'automaticPriorityPrintingEnabled'`,
      [ctx.companyId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes.automaticPriorityPrintingEnabled).toEqual({ old: false, new: true });
  });

  it("cannot be changed by ordinary settings saves or bulk option updates", async () => {
    const forbidden = await agent.put("/api/factory/settings").send({
      automaticPriorityPrintingEnabled: false,
    });
    expect(forbidden.status).toBe(403);

    const normal = await agent.put("/api/factory/settings").send({
      dashboardEnabled: false,
      productionWorkerMatrixWhatsappGroupId: "phase1-flag-safe-update",
    });
    expect(normal.status).toBe(200);
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(true);

    // An ordinary settings request must merge only the keys it writes, even
    // when racing an operational flag change.
    const [bulkSave, modeChange] = await Promise.all([
      agent.put("/api/factory/settings").send({ supplierReportEnabled: false }),
      agent.put(ENDPOINT).send({ enabled: false }),
    ]);
    expect(bulkSave.status).toBe(200);
    expect(modeChange.status).toBe(200);
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);
  });

  it("does not let a non-privileged company user enable the feature", async () => {
    await setRole("Manager");
    const read = await agent.get(ENDPOINT);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ enabled: false, canEdit: false });

    const denied = await agent.put(ENDPOINT).send({ enabled: true });
    expect(denied.status).toBe(403);
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);
    await setRole("Admin");
  });

  it("follows the Factory Settings page owner: Developer may edit, Owner may only read", async () => {
    try {
      // Factory Settings is an admin-level page (Admin/Developer) in the
      // Factory access registry, so Owner can read the state but the backend
      // access boundary refuses the write.
      await setRole("Owner");
      expect((await agent.get(ENDPOINT)).body).toMatchObject({ enabled: false, canEdit: false });
      const owner = await agent.put(ENDPOINT).send({ enabled: true });
      expect(owner.status).toBe(403);
      expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);

      await setRole("Developer");
      expect((await agent.get(ENDPOINT)).body.canEdit).toBe(true);
      expect((await agent.put(ENDPOINT).send({ enabled: true })).status).toBe(200);
      expect((await agent.put(ENDPOINT).send({ enabled: false })).status).toBe(200);
    } finally {
      await setRole("Admin");
    }
  });

  it("keeps OFF until explicitly re-enabled and audits the state transition", async () => {
    const off = await agent.put(ENDPOINT).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.changed).toBe(false);
    const on = await agent.put(ENDPOINT).send({ enabled: true });
    expect(on.status).toBe(200);
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(true);

    const offAgain = await agent.put(ENDPOINT).send({ enabled: false });
    expect(offAgain.status).toBe(200);
    expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);

    const audits = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND action = 'settings_change'
         AND record_identifier = 'automaticPriorityPrintingEnabled' ORDER BY id ASC`,
      [ctx.companyId]
    );
    expect(audits.rows).toHaveLength(6);
  });
  it("isolates independent ON/OFF state for two factory companies", async () => {
    const another = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
         VALUES ('APRMODEALT', '${PREFIX}-other-company', 'USD', 'factory') RETURNING id`
    );
    const otherCompanyId = another.rows[0].id;
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
      ctx.userId,
      otherCompanyId,
    ]);
    try {
      const changed = await agent.post("/api/auth/set-company").send({ companyId: otherCompanyId });
      expect(changed.status).toBe(200);
      expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);
      expect((await agent.put(ENDPOINT).send({ enabled: true })).status).toBe(200);

      const original = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      expect(original.status).toBe(200);
      expect((await agent.get(ENDPOINT)).body.enabled).toBe(false);
    } finally {
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    }
  });
});
