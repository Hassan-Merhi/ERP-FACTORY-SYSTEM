/**
 * Wave 11 (inventory fidelity), agent A: stock value = inventory.total_value
 * everywhere (owner decision 1).
 *
 *   - the stock-value readers (net profit stock in hand, the historical net
 *     position, the raw balance, the import-cycle balance, the stock reports)
 *     equal stockValuation, whose policy they all share: non-deleted
 *     locations, active or inactive, stored total_value, negative stock not
 *     subtracting; quantity × average_rate (which would drift) is never used;
 *   - a rounding residual never drifts: 10,000 units bought for 3,749.00 (true
 *     rate 0.3749) issued in lots of 7 keep a stored value within half a cent
 *     of quantity × 0.3749 at every step, and the issues relieve exactly
 *     3,749.00 in all;
 *   - the reconciliation honours its date: as of a past date it compares the
 *     ledger then (by effective date) with the sub-ledger replayed back to it.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { adjustInventory } from "../server/inventoryHelper";
import { computeRawBalance } from "../server/routes/admin/userManagementRoutes";
import { computeStockInHand } from "../server/routes/stats/netProfitStockSection";
import { reconcilePerpetualInventory } from "../server/services/accounting/perpetualInventory/reconciliation";
import {
  companyStockValuation,
  companyStockValuationAsOf,
  companyStockValue,
} from "../server/services/inventory/stockValuation";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const TEST_PREFIX = "w11val";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let inactiveLocationId: number;

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  inactiveLocationId = (
    await pool.query<{ id: number }>(
      `INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2::varchar, $2::text, false) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-INACTIVE`]
    )
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM locations WHERE id = $1`, [inactiveLocationId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("stock value readers", () => {
  it("equal stockValuation (total_value, the one location policy, negatives not subtracting)", async () => {
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
    const [itemA, itemB, itemC] = ctx.stockItemIds;
    const put = (locationId: number, stockItemId: number, quantity: string, rate: string, value: string) =>
      pool.query(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.companyId, locationId, stockItemId, quantity, rate, value]
      );
    // 3 units holding 10.00: quantity × a 2dp rate would say 9.99.
    await put(ctx.locationId, itemA, "3", "3.33", "10.00");
    // Negative stock at its provisional value: reported, never subtracted.
    await put(ctx.locationId, itemB, "-2", "5.00", "-10.00");
    // An inactive location's stock is still the company's.
    await put(inactiveLocationId, itemC, "7", "1.43", "10.01");
    await put(ctx.location2Id, itemC, "1", "2.50", "2.50");

    const valuation = await companyStockValuation(db, ctx.companyId);
    expect(valuation.total).toBe("22.51");
    expect(valuation.excluded.shortageValue).toBe("-10.00");
    expect(valuation.subLedgerTotal).toBe("12.51");
    expect(valuation.inactiveLocationValue).toBe("10.01");

    expect(await computeStockInHand(ctx.companyId, null)).toBe(22.51);
    expect(await computeStockInHand(ctx.companyId, today)).toBe(22.51);
    expect(await companyStockValue(db, ctx.companyId, today)).toBe("22.51");

    const netPosition = await calculateNetPositionAsOf(ctx.companyId, today);
    expect(netPosition.forUsLines.find((line) => line.label === "Stock In Hand (Inventory)")?.value).toBe(22.51);

    // The raw balance takes stock on floor with the same figure: moving the
    // stock value by 1.00 moves the raw balance by exactly 1.00.
    const rawBefore = await computeRawBalance(ctx.companyId);
    await pool.query(
      `UPDATE inventory SET total_value = total_value + 1 WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, itemA]
    );
    expect(Number(((await computeRawBalance(ctx.companyId)) - rawBefore).toFixed(2))).toBe(1);
    expect(await companyStockValue(db, ctx.companyId)).toBe("23.51");

    const importCycle = await agent.get("/api/stats/import-cycle-balance");
    expect(importCycle.status, JSON.stringify(importCycle.body).slice(0, 300)).toBe(200);
    expect(findKey(importCycle.body, "stockOnFloorValue")).toBe(23.51);

    const movement = await agent.get("/api/reports/stock-movement");
    expect(movement.status).toBe(200);
    expect(movement.body.summary.grandTotalValue).toBe(23.51);

    const opening = await agent.get("/api/reports/opening-stock-summary");
    expect(opening.status).toBe(200);
    expect(opening.body.grandTotal.closing.value).toBe(23.51);
  }, 120_000);
});

describe("rounding residual", () => {
  it("never drifts: true rate 0.3749 issued in lots of 7", async () => {
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
    const item = ctx.stockItemIds[0];
    const trueRate = 0.3749;
    let relieved = 0n; // cents
    await db.transaction(async (tx) => {
      await adjustInventory(tx, ctx.locationId, item, 10_000, ctx.companyId, trueRate);
      let quantity = 10_000;
      let worst = 0;
      while (quantity > 0) {
        const lot = Math.min(7, quantity);
        const issued = await adjustInventory(tx, ctx.locationId, item, -lot, ctx.companyId);
        relieved += BigInt(Math.round(-Number(issued.valueDelta) * 100));
        quantity -= lot;
        worst = Math.max(worst, Math.abs(issued.newTotalValue - quantity * trueRate));
      }
      expect(worst).toBeLessThanOrEqual(0.005 + 1e-9);
    });
    expect(relieved).toBe(374_900n);
    const { rows } = await pool.query(
      `SELECT quantity::text AS q, total_value::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, item]
    );
    expect(rows[0]).toEqual({ q: "0.000", v: "0.00" });
  }, 300_000);
});

describe("as-of reconciliation", () => {
  it("compares the ledger as of the date with the sub-ledger replayed to it", async () => {
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, '2026-01-01', '{}'::jsonb, 'test') ON CONFLICT (company_id) DO NOTHING`,
      [ctx.companyId]
    );
    const [itemA] = ctx.stockItemIds;
    // Production of 4 at 2.50 three days ago, posted with its inventory line;
    // its voucher's effective date is two days ago, which is the date it is booked on.
    await withFixtureTransaction(async (client) => {
      const inventoryAccount = (
        await client.query(
          `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'INVENTORY' AND deleted_at IS NULL LIMIT 1`,
          [ctx.companyId]
        )
      ).rows[0]?.id as number | undefined;
      const inventoryId =
        inventoryAccount ??
        ((
          await client.query(
            `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
             VALUES ($1, 'INVENTORY', 'Inventory', 'Asset', 0, 'Dr') RETURNING id`,
            [ctx.companyId]
          )
        ).rows[0].id as number);
      const voucher = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount, location_id)
           VALUES ($1, $2, 'Production', $3, $4, 10, $5) RETURNING id`,
          [ctx.companyId, `${TEST_PREFIX}-PROD`, day(-3), day(-2), ctx.locationId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, 10, 0, 'Inventory - stock adjustment'), ($1, $3, 0, 10, 'Production')`,
        [voucher, inventoryId, ctx.salesAccountId]
      );
      const adjustment = (
        await client.query(
          `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type)
           VALUES ($1, $2, 'Production') RETURNING id`,
          [voucher, ctx.locationId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount, value_moved)
         VALUES ($1, $2, 4, 2.50, 10, 10)`,
        [adjustment, itemA]
      );
      await client.query(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, 4, 2.5, 10)`,
        [ctx.companyId, ctx.locationId, itemA]
      );
    });

    const inventoryLine = async (asOf: string) =>
      (await reconcilePerpetualInventory(db, ctx.companyId, asOf)).lines.find(
        (line) => line.accountCode === "INVENTORY"
      )!;
    // Booked on its effective date (two days ago) on both sides: the ledger
    // books the voucher on it, and since wave 15 (M1) the sub-ledger replay
    // dates a document line by its voucher's effective date too.
    expect(await inventoryLine(today)).toMatchObject({ ledger: "10.00", subLedger: "10.00", difference: "0.00" });
    expect(await inventoryLine(day(-2))).toMatchObject({ ledger: "10.00", subLedger: "10.00", difference: "0.00" });
    expect(await inventoryLine(day(-4))).toMatchObject({ ledger: "0.00", subLedger: "0.00", difference: "0.00" });
    // Between the voucher date and the effective date neither side holds it yet
    // (before wave 15 the replay used the voucher date and showed -10.00 here).
    expect(await inventoryLine(day(-3))).toMatchObject({ ledger: "0.00", subLedger: "0.00", difference: "0.00" });
    expect((await companyStockValuationAsOf(db, ctx.companyId, day(-4))).subLedgerTotal).toBe("0.00");
  }, 120_000);
});
