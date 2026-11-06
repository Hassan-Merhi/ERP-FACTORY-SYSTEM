/**
 * Phase 10 operator buttons on the factory LAN server (plan batch 1): pause
 * and resume of LAN -> cloud delivery through POST
 * /api/edge/operator/sync-control and its DBA-owned database function. Admin
 * or Owner of the active company, the password again and a reason; the log
 * names the user from the database, never from the request.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";

const SITE = randomUUID();
const edge = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase10SyncControlSchema } from "../server/edge/phase10SyncControl.mjs";
import {
  ensurePhase10SyncControlFunction,
  recordPhase10OperatorSyncControl,
} from "../server/edge/phase10OperatorControls.mjs";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p10sync";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

function control(body: Record<string, unknown>) {
  return agent.post("/api/edge/operator/sync-control").send({ password: "testpassword123", ...body });
}

beforeAll(async () => {
  // A factory LAN server that is not (yet) the writer: the route is reachable,
  // every business write stays refused.
  edge.config = { mode: "lan", primary: false, siteId: SITE, writeMode: "read-only" };
  ctx = await seedTestData(PREFIX);
  await ensurePhase10SyncControlSchema(pool);
  await ensurePhase10SyncControlFunction(pool);
  agent = request.agent(await setupTestApp({ edgeBoundary: true }));
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await pool.query("ALTER TABLE factory_edge_sync_control_log DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_sync_control_log WHERE site_id = $1::uuid", [SITE]);
  await pool.query("ALTER TABLE factory_edge_sync_control_log ENABLE TRIGGER USER");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 10 pause / resume on the factory LAN server", () => {
  it("pauses and resumes delivery as the signed-in Admin, with a reason", async () => {
    const paused = await control({ action: "pause", reason: "cloud restore in progress" });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      paused: true,
      operatorName: `${PREFIX}_testuser`,
      reason: "cloud restore in progress",
    });
    const resumed = await control({ action: "resume", reason: "cloud restore finished" });
    expect(resumed.body).toMatchObject({ paused: false, operatorName: `${PREFIX}_testuser` });
  });

  it("refuses a wrong password, a missing reason and an unknown action", async () => {
    const wrong = await control({ password: "nope", action: "pause", reason: "cloud restore in progress" });
    expect(wrong.status).toBe(401);
    expect((await control({ action: "pause", reason: "short" })).status).toBe(400);
    expect((await control({ action: "stop", reason: "cloud restore in progress" })).status).toBe(400);
  });

  it("refuses a user who is not Admin/Owner, both in the route and in the database function", async () => {
    await pool.query("UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      const refused = await control({ action: "pause", reason: "a manager tries to pause" });
      expect(refused.status).toBe(403);
      await expect(
        recordPhase10OperatorSyncControl(pool, {
          siteId: SITE,
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: "pause",
          reason: "a manager tries to pause",
        })
      ).rejects.toThrow("PHASE10_OPERATOR_NOT_AUTHORIZED");
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
    }
  });
});
