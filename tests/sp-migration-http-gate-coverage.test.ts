/**
 * The HTTP gate in front of the Supplier Partner migration routes, through the
 * real app: the session company must be a Supplier Partner company, the route
 * requires the Developer role, and every migration write needs an exact typed
 * confirmation, a reason and an idempotency key. For writes whose handler
 * checks its own action phrase ("CANCEL CUTOVER", "MIGRATE", ...), the gate
 * asks for that same phrase; other migration writes keep "RUN SP MIGRATION".
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertCutover,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_http";
const PAIR_PREFIX = "spmigcov_httppair";
let ctx: TestContext;
let pair: SpMigrationPair;
let agent: request.SuperAgentTest;

async function setRole(role: string): Promise<void> {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    pair.targetId,
  ]);
  const switched = await agent.post("/api/auth/set-company").send({ companyId: pair.targetId });
  expect(switched.status).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  pair = await createSpMigrationPair(PAIR_PREFIX);
  await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Developer')`, [
    ctx.userId,
    pair.targetId,
  ]);
  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PAIR_PREFIX);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe("SP migration HTTP gate", () => {
  it("refuses a session whose company is not a Supplier Partner company", async () => {
    const response = await agent
      .get("/api/sp/migration/final-verification")
      .query({ sourceCompanyId: pair.sourceId, targetCompanyId: pair.targetId });
    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Not a supplier_partner company");
  });

  it("refuses non-Developer roles on the migration routes", async () => {
    await setRole("Admin");
    const query = { sourceCompanyId: pair.sourceId, targetCompanyId: pair.targetId };
    // Without membership in the named source company the tenant boundary refuses first.
    const foreign = await agent.get("/api/sp/migration/cutover/status").query(query);
    expect(foreign.status).toBe(403);
    expect(foreign.body.message).toBe("No access to one or more companies");

    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
      ctx.userId,
      pair.sourceId,
    ]);
    const response = await agent.get("/api/sp/migration/cutover/status").query(query);
    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Forbidden");
  });

  it("accepts a cutover write that carries the handler's phrase, a reason and an idempotency key", async () => {
    await setRole("Developer");
    const cutoverId = await insertCutover(pair, "prepared");
    const body = { cutoverId, companyNameConfirm: pair.sourceName, reason: "coverage of the gate" };
    const cancel = (key: string | null, extra: Record<string, unknown>) => {
      const req = agent.post("/api/sp/migration/cutover/cancel");
      if (key) req.set("Idempotency-Key", key);
      return req.send({ ...body, ...extra });
    };
    const status = async () =>
      (await pool.query(`SELECT status FROM sp_migration_cutovers WHERE id = $1`, [cutoverId])).rows[0].status;

    const generic = await cancel(`${PREFIX}-1`, { confirmation: "RUN SP MIGRATION" });
    expect(generic.status).toBe(400);
    expect(generic.body).toMatchObject({
      code: "SP_EXACT_CONFIRMATION_REQUIRED",
      message: "Type exactly: CANCEL CUTOVER",
    });
    const missing = await cancel(`${PREFIX}-2`, {});
    expect(missing.body.code).toBe("SP_EXACT_CONFIRMATION_REQUIRED");
    const noReason = await cancel(`${PREFIX}-3`, { confirmation: "CANCEL CUTOVER", reason: "no" });
    expect(noReason.body.code).toBe("SP_REASON_REQUIRED");
    const noKey = await cancel(null, { confirmation: "CANCEL CUTOVER" });
    expect(noKey.body.code).toBe("SP_IDEMPOTENCY_KEY_REQUIRED");
    expect(await status()).toBe("prepared");

    const accepted = await cancel(`${PREFIX}-4`, { confirmation: "CANCEL CUTOVER" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.success).toBe(true);
    expect(await status()).toBe("cancelled");
  });

  it("derives the phrase from the dispatcher action and keeps the generic phrase elsewhere", async () => {
    await setRole("Developer");
    const dispatched = await agent
      .post("/api/sp/migration/cutover")
      .set("Idempotency-Key", `${PREFIX}-5`)
      .send({ action: "rollback", cutoverId: 2147480001, confirmation: "ROLLBACK CUTOVER", reason: "coverage run" });
    expect(dispatched.status).toBe(404);
    expect(dispatched.body.message).toBe("Cutover not found");

    const wrongAction = await agent
      .post("/api/sp/migration/cutover")
      .set("Idempotency-Key", `${PREFIX}-6`)
      .send({ action: "rollback", cutoverId: 2147480001, confirmation: "CANCEL CUTOVER", reason: "coverage run" });
    expect(wrongAction.body).toMatchObject({
      code: "SP_EXACT_CONFIRMATION_REQUIRED",
      message: "Type exactly: ROLLBACK CUTOVER",
    });

    const reviewPath = "/api/sp/migration/gc-suspense-review/2147480001/map";
    const reviewWrong = await agent
      .post(reviewPath)
      .set("Idempotency-Key", `${PREFIX}-7`)
      .send({ confirmation: "MIGRATE", reason: "coverage run" });
    expect(reviewWrong.body).toMatchObject({
      code: "SP_EXACT_CONFIRMATION_REQUIRED",
      message: "Type exactly: RUN SP MIGRATION",
    });
    const reviewRight = await agent
      .post(reviewPath)
      .set("Idempotency-Key", `${PREFIX}-8`)
      .send({ confirmation: "RUN SP MIGRATION", reason: "coverage run" });
    expect(reviewRight.status).toBe(400);
    expect(reviewRight.body.message).toBe("sourceCompanyId and targetCompanyId are required");
  });
});
