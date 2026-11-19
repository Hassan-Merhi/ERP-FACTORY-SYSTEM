/**
 * The HTTP gate in front of the Supplier Partner migration routes, through the
 * real app: the session company must be a Supplier Partner company, the route
 * requires the Developer role, and the SP access layer demands its own exact
 * confirmation for every migration write.
 *
 * Known defect pinned here: the SP access layer (spAccessControl.ts,
 * sensitiveRequirement) requires `confirmation: "RUN SP MIGRATION"` on every
 * /api/sp/migration write, while each cutover handler requires its own phrase
 * in the same field ("CANCEL CUTOVER", "PREPARE CUTOVER", "MIGRATE", ...). No
 * request can satisfy both, so the cutover and Phase 2 writes are unreachable
 * over HTTP.
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

  it("cannot satisfy both the gate's and the handler's confirmation", async () => {
    await setRole("Developer");
    const cutoverId = await insertCutover(pair, "prepared");
    const body = { cutoverId, companyNameConfirm: pair.sourceName, reason: "coverage of the gate" };

    const handlerPhrase = await agent
      .post("/api/sp/migration/cutover/cancel")
      .set("Idempotency-Key", `${PREFIX}-1`)
      .send({ ...body, confirmation: "CANCEL CUTOVER" });
    expect(handlerPhrase.status).toBe(400);
    expect(handlerPhrase.body.code).toBe("SP_EXACT_CONFIRMATION_REQUIRED");

    const gatePhrase = await agent
      .post("/api/sp/migration/cutover/cancel")
      .set("Idempotency-Key", `${PREFIX}-2`)
      .send({ ...body, confirmation: "RUN SP MIGRATION" });
    expect(gatePhrase.status).toBe(400);
    expect(gatePhrase.body.message).toBe('Requires confirmation = "CANCEL CUTOVER"');

    const row = await pool.query(`SELECT status FROM sp_migration_cutovers WHERE id = $1`, [cutoverId]);
    expect(row.rows[0].status).toBe("prepared");
  });
});
