/**
 * Phase 3 stock valuation against PostgreSQL in a rolled-back transaction:
 * the one-time baseline and movement cutoff per company, and the snapshot
 * that rebuilds stock value from that baseline plus later canonical
 * movements, skipping deleted locations.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { db, pool } from "../server/db";
import {
  ensurePhase3InventoryValuationBaselines,
  loadPhase3InventoryValuationSnapshot,
} from "../server/services/accounting/phase3InventoryValuation";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const PREFIX = `P3V${Date.now().toString(36).toUpperCase()}`;
let seq = 0;

async function world(client: PoolClient) {
  const tag = `${PREFIX}${++seq}`;
  const companyId = (
    await client.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type) VALUES ($1::varchar, $1::text, 'USD', 'retail') RETURNING id`,
      [tag]
    )
  ).rows[0].id;
  const location = async (code: string) =>
    (
      await client.query<{ id: number }>(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
        [companyId, `${tag}${code}`]
      )
    ).rows[0].id;
  const item = async (code: string) =>
    (
      await client.query<{ id: number }>(
        `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2::varchar, $2::text, 'PCS', true) RETURNING id`,
        [companyId, `${tag}${code}`]
      )
    ).rows[0].id;
  const stock = (locationId: number, itemId: number, qty: string, avg: string, value: string) =>
    client.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, locationId, itemId, qty, avg, value]
    );
  const move = async (locationId: number, itemId: number, delta: string, cost: string) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO canonical_stock_movements
           (company_id, stock_item_id, location_id, quantity_delta, unit_cost, movement_kind,
            source_type, source_id, idempotency_key, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'adjustment', 'test', $6, $6, now()) RETURNING id::text`,
        [companyId, itemId, locationId, delta, cost, `${tag}-${++seq}`]
      )
    ).rows[0].id;
  return { companyId, location, item, stock, move };
}

const cutover = async (client: PoolClient, companyId: number) =>
  (
    await client.query(
      `SELECT movement_cutoff_id::text AS cutoff FROM phase3_inventory_valuation_cutovers WHERE company_id = $1`,
      [companyId]
    )
  ).rows;
const snapshot = (companyId: number) => db.transaction((tx) => loadPhase3InventoryValuationSnapshot({ tx, companyId }));

describe("ensurePhase3InventoryValuationBaselines", () => {
  it("snapshots live-location stock once, with the company's last movement as the cutoff", async () => {
    await withRolledBackPool(async (client) => {
      // Give every existing company its cutover first so the counts below are ours.
      await ensurePhase3InventoryValuationBaselines(pool);
      const w = await world(client);
      const main = await w.location("M");
      const closed = await w.location("C");
      const bales = await w.item("B");
      await w.stock(main, bales, "10", "4.00", "40.00");
      await w.stock(closed, bales, "5", "4.00", "20.00");
      const lastBefore = await w.move(main, bales, "10", "4");
      await client.query(`UPDATE locations SET deleted_at = now() WHERE id = $1`, [closed]);

      expect(await ensurePhase3InventoryValuationBaselines(pool)).toBe(1);
      expect(await cutover(client, w.companyId)).toEqual([{ cutoff: lastBefore }]);
      const baselines = await client.query(
        `SELECT location_id::int, quantity::text, total_value::text FROM phase3_inventory_valuation_baselines
          WHERE company_id = $1`,
        [w.companyId]
      );
      expect(baselines.rows).toEqual([{ location_id: main, quantity: "10.000", total_value: "40.00" }]);

      // Running again keeps the original cutoff and baseline.
      await w.move(main, bales, "1", "4");
      await w.stock(await w.location("N"), bales, "1", "1", "1");
      expect(await ensurePhase3InventoryValuationBaselines(pool)).toBe(0);
      expect(await cutover(client, w.companyId)).toEqual([{ cutoff: lastBefore }]);
    });
  });

  it("uses a zero cutoff for a company without movements and rolls back a failed company", async () => {
    await withRolledBackPool(async (client) => {
      await ensurePhase3InventoryValuationBaselines(pool);
      const w = await world(client);
      expect(await ensurePhase3InventoryValuationBaselines(pool)).toBe(1);
      expect(await cutover(client, w.companyId)).toEqual([{ cutoff: "0" }]);

      const failing = await world(client);
      await client.query(`SAVEPOINT before_failure`);
      // Make this company's cutover insert fail: its step is rolled back and the error surfaces.
      await client.query(
        `ALTER TABLE phase3_inventory_valuation_cutovers ADD CONSTRAINT p3v_test_block CHECK (company_id <> ${failing.companyId})`
      );
      await expect(ensurePhase3InventoryValuationBaselines(pool)).rejects.toThrow(/p3v_test_block/);
      await client.query(`ROLLBACK TO SAVEPOINT before_failure`);
      expect(await cutover(client, failing.companyId)).toEqual([]);
    });
  });
});

describe("loadPhase3InventoryValuationSnapshot", () => {
  it("rebuilds value from the baseline plus later movements and compares with live stock", async () => {
    await withRolledBackPool(async (client) => {
      await ensurePhase3InventoryValuationBaselines(pool);
      const w = await world(client);
      const main = await w.location("M");
      const spare = await w.location("S");
      const closed = await w.location("C");
      const bales = await w.item("B");
      const shoes = await w.item("S");
      await w.stock(main, bales, "10", "4.00", "40.00");
      await w.move(main, bales, "10", "4");
      await ensurePhase3InventoryValuationBaselines(pool);

      // After the cutoff: buy 10 bales at 6, sell 5, and receive shoes in a
      // new location; movements in a deleted location are ignored.
      await w.move(main, bales, "10", "6");
      await w.move(main, bales, "-5", "0");
      await w.move(spare, shoes, "2", "12.50");
      await w.move(closed, shoes, "100", "1");
      await w.stock(closed, shoes, "100", "1.00", "100.00");
      await client.query(`UPDATE locations SET deleted_at = now() WHERE id = $1`, [closed]);
      await client.query(`UPDATE inventory SET total_value = '99.99' WHERE company_id = $1`, [w.companyId]);
      await w.stock(spare, shoes, "2", "12.50", "25.00");

      // 10 @ 4 + 10 @ 6 = 100 for 20 (rate 5); -5 leaves 75; shoes 25.
      expect(await snapshot(w.companyId)).toEqual({
        companyId: w.companyId,
        operationalInventoryValue: "124.99",
        accountingInventoryValue: "100.00",
        accountingInventoryAccountCount: 1,
      });
    });
  });

  it("reports zero stock and refuses a missing or invalid cutover", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await expect(snapshot(w.companyId)).rejects.toMatchObject({
        code: "PHASE3_STOCK_BASELINE_MISSING",
        message: `Company ${w.companyId} has no Phase 3 inventory valuation cutover`,
      });
      await client.query(
        `INSERT INTO phase3_inventory_valuation_cutovers (company_id, movement_cutoff_id) VALUES ($1, 0)`,
        [w.companyId]
      );
      expect(await snapshot(w.companyId)).toMatchObject({
        operationalInventoryValue: "0",
        accountingInventoryValue: "0.00",
      });
      await client.query(
        `UPDATE phase3_inventory_valuation_cutovers SET movement_cutoff_id = -1 WHERE company_id = $1`,
        [w.companyId]
      );
      await expect(snapshot(w.companyId)).rejects.toMatchObject({
        code: "PHASE3_STOCK_BASELINE_INVALID",
        message: `Company ${w.companyId} cutoff is invalid`,
      });
    });
  });

  it("refuses a baseline value that is not a finite decimal", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const main = await w.location("M");
      const bales = await w.item("B");
      await client.query(
        `INSERT INTO phase3_inventory_valuation_cutovers (company_id, movement_cutoff_id) VALUES ($1, 0)`,
        [w.companyId]
      );
      await client.query(
        `INSERT INTO phase3_inventory_valuation_baselines
           (company_id, stock_item_id, location_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, 'NaN', 1, 1)`,
        [w.companyId, bales, main]
      );
      await expect(snapshot(w.companyId)).rejects.toMatchObject({
        code: "PHASE3_STOCK_VALUATION_INVALID",
        message: "baseline.quantity is not a finite decimal",
      });
    });
  });
});
