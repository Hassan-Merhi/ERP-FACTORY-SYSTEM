/**
 * Reports under perpetual inventory (wave 8.5).
 *
 * Before a company's cut-over, net position adds the stock it values outside
 * the ledger (location stock in hand). Once the cut-over is applied, the
 * opening journal puts that stock in the ledger's Inventory account and the
 * reports read it from there: the stock is counted once, so the net position
 * does not change, and the reconciliation finds the ledger and the stock
 * sub-ledger in agreement.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { applyOpeningInventoryJournal } from "../server/services/accounting/perpetualInventory/openingJournal";
import { reconcilePerpetualInventory } from "../server/services/accounting/perpetualInventory/reconciliation";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "pirep";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;

const stockLines = (snapshot: Awaited<ReturnType<typeof calculateNetPositionAsOf>>) =>
  snapshot.forUsLines
    .filter((line) => line.label === "Stock In Hand (Inventory)" || /inventory/i.test(line.label))
    .map((line) => [line.label, line.value]);

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await db
    .insert(schema.inventory)
    .values({
      companyId: ctx.companyId,
      locationId: ctx.locationId,
      stockItemId: ctx.stockItemIds[0],
      quantity: "100.000",
      averageRate: "10.00",
      totalValue: "1000.00",
    })
    .onConflictDoNothing();
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("reports under perpetual inventory", () => {
  it("counts the stock once, from the ledger, after the cut-over", async () => {
    const before = await calculateNetPositionAsOf(ctx.companyId, today);
    const [[, stock]] = stockLines(before);
    expect(stockLines(before)).toEqual([["Stock In Hand (Inventory)", stock]]);
    expect(Number(stock)).toBeGreaterThanOrEqual(1000);
    const dashboardBefore = await agent.get("/api/stats/net-profit");
    expect(dashboardBefore.status).toBe(200);

    const applied = await applyOpeningInventoryJournal(ctx.companyId, today, "test", { postingReady: true, today });
    expect(Number(applied.plan.lines.find((line) => line.accountCode === "INVENTORY")?.amount)).toBeCloseTo(
      Number(stock),
      2
    );

    // The opening journal is dated the eve; net position as of today reads the ledger.
    const after = await calculateNetPositionAsOf(ctx.companyId, today);
    expect(after.forUsLines.find((line) => line.label === "Stock In Hand (Inventory)")).toBeUndefined();
    expect(stockLines(after).reduce((sum, [, value]) => sum + Number(value), 0)).toBeCloseTo(Number(stock), 2);
    expect(after.netPosition).toBeCloseTo(before.netPosition, 2);

    const dashboardAfter = await agent.get(`/api/stats/net-profit?toDate=${today}`);
    expect(dashboardAfter.status).toBe(200);
    expect(dashboardAfter.body.netPosition).toBeCloseTo(dashboardBefore.body.netPosition, 2);

    const reconciliation = await reconcilePerpetualInventory(db, ctx.companyId, today);
    expect(reconciliation.lines.find((line) => line.accountCode === "INVENTORY")).toMatchObject({
      ledger: Number(stock).toFixed(2),
      subLedger: Number(stock).toFixed(2),
      difference: "0.00",
    });
    expect(reconciliation.reconciled).toBe(true);
  }, 120_000);
});
