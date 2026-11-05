/**
 * Phase 10 operator buttons on the cloud operator console (plan batch 1):
 * the conflict list and approve/reject routes, and the DBA-owned database
 * function behind them, on the full application schema. Decisions need an
 * active Admin/Developer of the conflict's company, the password again and a
 * reason; approve is only for conflict codes the stream registry allows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null, writeMode: "fenced" } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9CloudEventSchema } from "../server/edge/phase9CloudEventStore.mjs";
import {
  decidePhase10Conflict,
  ensurePhase10ConflictDecisionFunction,
} from "../server/edge/phase10OperatorControls.mjs";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p10dec";
const SITE = randomUUID();
const ENV_KEYS = [
  "FACTORY_SYNC_RECEIVE_ENABLED",
  "FACTORY_PHASE9_APPLY_ENABLED",
  "FACTORY_PHASE8_APPLY_ACK",
  "FACTORY_SYNC_SITE_ID",
  "FACTORY_PHASE8_BASELINE_SHA256",
  "FACTORY_PHASE8_COMPANY_ID",
  "FACTORY_CLOUD_WRITER_EPOCH",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

async function conflict(sequence: number, code: string) {
  await pool.query(
    `INSERT INTO factory_edge_event_conflicts
       (site_id, stream, sequence, operation_id, company_id, operation_kind, code, detail)
     VALUES ($1::uuid, 'stock', $2, $3::uuid, $4, 'stock.quick-adjust.v1', $5, '{"available":"2"}'::jsonb)`,
    [SITE, sequence, randomUUID(), ctx.companyId, code]
  );
}

function decide(body: Record<string, unknown>) {
  return agent.post("/api/edge/operator/conflicts/decide").send({ password: "testpassword123", ...body });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensurePhase9CloudEventSchema(pool);
  await ensurePhase10ConflictDecisionFunction(pool);
  await conflict(1, "PHASE9_STOCK_WOULD_GO_NEGATIVE");
  await conflict(2, "PHASE9_STOCK_ITEM_MISSING");
  await conflict(3, "PHASE9_STOCK_WOULD_GO_NEGATIVE");
  agent = request.agent(await setupTestApp({ edgeBoundary: true }));
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await pool.query("ALTER TABLE factory_edge_event_conflict_decisions DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_event_conflict_decisions WHERE site_id = $1::uuid", [SITE]);
  await pool.query("ALTER TABLE factory_edge_event_conflict_decisions ENABLE TRIGGER USER");
  await pool.query("ALTER TABLE factory_edge_event_conflicts DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_event_conflicts WHERE site_id = $1::uuid", [SITE]);
  await pool.query("ALTER TABLE factory_edge_event_conflicts ENABLE TRIGGER USER");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 10 conflict decisions on the cloud operator console", () => {
  it("is disabled on an ordinary cloud instance", async () => {
    expect((await agent.get("/api/edge/operator/conflicts")).status).toBe(404);
    const refused = await decide({
      stream: "stock",
      sequence: "1",
      decision: "reject-event",
      reason: "not on console",
    });
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe("EDGE_OPERATOR_CONSOLE_DISABLED");
  });

  it("lists held events with whether they may be approved, once the console is configured", async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, {
      FACTORY_SYNC_RECEIVE_ENABLED: "1",
      FACTORY_PHASE9_APPLY_ENABLED: "1",
      FACTORY_PHASE8_APPLY_ACK: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
      FACTORY_SYNC_SITE_ID: SITE,
      FACTORY_PHASE8_BASELINE_SHA256: "a".repeat(64),
      FACTORY_PHASE8_COMPANY_ID: String(ctx.companyId),
      FACTORY_CLOUD_WRITER_EPOCH: "2",
    });
    const listed = await agent.get("/api/edge/operator/conflicts");
    expect(listed.status).toBe(200);
    expect(
      listed.body.conflicts.map((c: { sequence: string; canApprove: boolean }) => [c.sequence, c.canApprove])
    ).toEqual([
      ["1", true],
      ["2", false],
      ["3", true],
    ]);
  });

  it("needs the password again and a real reason", async () => {
    const wrong = await decide({
      password: "wrong-password",
      stream: "stock",
      sequence: "1",
      decision: "approve-override",
      reason: "cloud stock recount confirmed",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("EDGE_OPERATOR_PASSWORD_INVALID");
    const short = await decide({ stream: "stock", sequence: "1", decision: "approve-override", reason: "ok" });
    expect(short.status).toBe(400);
  });

  it("approves an overridable conflict and refuses to approve one that may only be rejected", async () => {
    const approved = await decide({
      stream: "stock",
      sequence: "1",
      decision: "approve-override",
      reason: "cloud stock recount confirmed",
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ stream: "stock", sequence: "1", decision: "approve-override" });
    const row = await pool.query(
      "SELECT decision, decided_by FROM factory_edge_event_conflict_decisions WHERE site_id = $1::uuid AND sequence = 1",
      [SITE]
    );
    expect(row.rows).toEqual([{ decision: "approve-override", decided_by: `${PREFIX}_testuser` }]);

    const notOverridable = await decide({
      stream: "stock",
      sequence: "2",
      decision: "approve-override",
      reason: "please apply it anyway",
    });
    expect(notOverridable.status).toBe(409);
    expect(notOverridable.body.code).toBe("PHASE9_CONFLICT_NOT_OVERRIDABLE");

    const rejected = await decide({
      stream: "stock",
      sequence: "2",
      decision: "reject-event",
      reason: "item was retired in the cloud",
    });
    expect(rejected.status).toBe(200);
    const again = await decide({
      stream: "stock",
      sequence: "2",
      decision: "reject-event",
      reason: "item was retired in the cloud",
    });
    expect(again.status).toBe(409);
    const listed = await agent.get("/api/edge/operator/conflicts");
    expect(listed.body.conflicts.map((c: { sequence: string }) => c.sequence)).toEqual(["3"]);
  });

  it("the database function itself refuses a user who is not an active Admin/Developer of that company", async () => {
    await pool.query("UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      await expect(
        decidePhase10Conflict(pool, {
          siteId: SITE,
          stream: "stock",
          sequence: "3",
          decision: "reject-event",
          userId: ctx.userId,
          reason: "a manager cannot decide this",
        })
      ).rejects.toThrow("PHASE9_REVIEWER_NOT_AUTHORIZED");
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
    }
    await expect(
      decidePhase10Conflict(pool, {
        siteId: SITE,
        stream: "stock",
        sequence: "99",
        decision: "reject-event",
        userId: ctx.userId,
        reason: "no such held event here",
      })
    ).rejects.toThrow("PHASE9_CONFLICT_NOT_FOUND");
  });
});
