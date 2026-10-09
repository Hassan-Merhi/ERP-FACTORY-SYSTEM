/**
 * The stock-item merge preview adds inventory exactly, as the merge itself
 * does: 0.1 and 0.2 of value at one location preview as a combined 0.3 (the
 * float path showed 0.30000000000000004).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mergepx";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("stock-item merge preview", () => {
  it("previews combined quantity and value exactly", async () => {
    const [kept, duplicate] = ctx.stockItemIds;
    await pool.query(`DELETE FROM inventory WHERE company_id = $1 AND stock_item_id = ANY($2)`, [
      ctx.companyId,
      [kept, duplicate],
    ]);
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, 0.1, 1, 0.1), ($1, $2, $4, 0.2, 1, 0.2)`,
      [ctx.companyId, ctx.locationId, kept, duplicate]
    );

    const res = await agent.get(`/api/stock-items/${kept}/merge-preview`).query({ duplicateId: duplicate });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.inventoryImpact).toEqual([
      expect.objectContaining({ action: "combine", combinedQty: 0.3, combinedValue: 0.3, combinedRate: 1 }),
    ]);
    expect(res.body).toMatchObject({ totalValueBefore: 0.3, totalValueAfter: 0.3 });
  });
});
