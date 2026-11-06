/**
 * Plan batch 5 (owner-approved 2026-11-05): a choice about an entry from the
 * old browser offline queues (re-entered or discarded) is recorded in the
 * audit log with the signed-in user's name. The route writes nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p5legacyq";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

const decision = {
  entryId: "ls:1700000000000-abcde",
  decision: "discarded",
  kind: "Payment / Receipt",
  recordedAt: "2023-11-14T22:13:20.000Z",
  amount: "42.50",
  source: "localStorage",
};

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await deleteAuditLogRowsForTests(pool, "table_name = 'offline_legacy_queue_entries' AND company_id = $1", [
    ctx.companyId,
  ]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("POST /api/offline/legacy-queue/decisions", () => {
  it("records the choice with the user's name", async () => {
    const response = await agent.post("/api/offline/legacy-queue/decisions").send(decision);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const audit = await pool.query(
      `SELECT username, action, record_identifier, changes FROM audit_log
        WHERE table_name = 'offline_legacy_queue_entries' AND company_id = $1`,
      [ctx.companyId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      username: `${PREFIX}_testuser`,
      action: "delete",
      record_identifier: decision.entryId,
    });
    expect(JSON.stringify(audit.rows[0].changes)).toContain("discarded");
  });

  it("refuses an incomplete or extended body, and a request without a session", async () => {
    expect(
      (await agent.post("/api/offline/legacy-queue/decisions").send({ ...decision, decision: "sent" })).status
    ).toBe(400);
    expect(
      (await agent.post("/api/offline/legacy-queue/decisions").send({ ...decision, body: { anything: 1 } })).status
    ).toBe(400);
    expect((await request(ctx.app).post("/api/offline/legacy-queue/decisions").send(decision)).status).toBe(401);
  });
});
