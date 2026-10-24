/**
 * Production boots with the bulk startup pass disabled (RUN_STARTUP_MIGRATIONS=false)
 * and never runs migrations/*.sql, so the Zambia native-Kwacha purchase columns
 * must come from the always-on guard. Reproduce purchase tables that predate
 * them in a throwaway schema (the guard uses unqualified names, so search_path
 * points it there), repair them, and prove the repair is idempotent and leaves
 * existing rows untouched.
 */
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureZambiaHistoricalPurchaseCost } from "../server/startup/ensureZambiaHistoricalPurchaseCost";

const schema = `zambia_guard_test_${process.pid}`;
let client: PoolClient;

const PURCHASE_ORDER_COLUMNS = [
  "historical_exchange_rate",
  "historical_rate_date",
  "native_discount",
  "native_document_charges",
  "native_freight",
  "native_fumigation",
  "native_items_total",
  "native_line_count",
  "native_other_charges",
  "native_surcharge",
];
const LINE_COLUMNS = ["native_line_total", "native_rate"];

async function columns(table: string, names: string[]): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3) ORDER BY column_name`,
    [schema, table, names]
  );
  return result.rows.map((row) => row.column_name);
}

async function constraint(): Promise<{ conname: string; convalidated: boolean }[]> {
  const result = await client.query<{ conname: string; convalidated: boolean }>(
    `SELECT c.conname, c.convalidated FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = $1 AND c.conname = 'purchase_orders_zmw_historical_rate_ck'`,
    [schema]
  );
  return result.rows;
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  // The shape production has before the guard runs: USD purchase orders with
  // none of the native-Kwacha columns.
  await client.query(`
    CREATE TABLE purchase_orders (
      id SERIAL PRIMARY KEY,
      currency TEXT NOT NULL DEFAULT 'USD',
      items_total NUMERIC(12,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE po_line_items (
      id SERIAL PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL,
      rate NUMERIC(12,2) NOT NULL DEFAULT 0
    );
    INSERT INTO purchase_orders (currency, items_total) VALUES ('USD', 125.50);
    INSERT INTO po_line_items (purchase_order_id, rate) VALUES (1, 125.50);
  `);
});

afterAll(async () => {
  await client.query(`SET search_path TO DEFAULT`);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
});

describe("Zambia purchase cost runtime schema guard", () => {
  it("adds the native-Kwacha columns and the NOT VALID constraint to tables that predate them", async () => {
    expect(await columns("purchase_orders", PURCHASE_ORDER_COLUMNS)).toEqual([]);
    expect(await columns("po_line_items", LINE_COLUMNS)).toEqual([]);
    expect(await constraint()).toEqual([]);

    await ensureZambiaHistoricalPurchaseCost(client as unknown as Pool);

    expect(await columns("purchase_orders", PURCHASE_ORDER_COLUMNS)).toEqual(PURCHASE_ORDER_COLUMNS);
    expect(await columns("po_line_items", LINE_COLUMNS)).toEqual(LINE_COLUMNS);
    expect(await constraint()).toEqual([{ conname: "purchase_orders_zmw_historical_rate_ck", convalidated: false }]);
    // Existing USD rows keep their values and simply carry NULL native evidence.
    const rows = await client.query(
      `SELECT currency, items_total, native_items_total, historical_exchange_rate FROM purchase_orders`
    );
    expect(rows.rows).toEqual([
      { currency: "USD", items_total: "125.50", native_items_total: null, historical_exchange_rate: null },
    ]);
  });

  it("is a no-op when run again and still refuses a Kwacha order without its evidence", async () => {
    await ensureZambiaHistoricalPurchaseCost(client as unknown as Pool);
    expect(await columns("purchase_orders", PURCHASE_ORDER_COLUMNS)).toEqual(PURCHASE_ORDER_COLUMNS);
    expect(await constraint()).toHaveLength(1);
    await expect(client.query(`INSERT INTO purchase_orders (currency) VALUES ('ZMW')`)).rejects.toThrow(
      /purchase_orders_zmw_historical_rate_ck/
    );
  });

  it("defers when the purchase tables do not exist yet", async () => {
    const empty = `${schema}_empty`;
    await client.query(`CREATE SCHEMA ${empty}`);
    await client.query(`SET search_path TO ${empty}`);
    try {
      await expect(ensureZambiaHistoricalPurchaseCost(client as unknown as Pool)).resolves.toBeUndefined();
      const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [
        empty,
      ]);
      expect(tables.rows).toEqual([]);
    } finally {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`DROP SCHEMA ${empty} CASCADE`);
    }
  });
});
