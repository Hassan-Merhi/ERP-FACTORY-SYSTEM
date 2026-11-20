/**
 * Historical customer-order pipeline
 * (server/services/factory/netPositionHistoricalOrders.ts): the recorded
 * row-history path on and after the baseline (stage buckets, customer names,
 * unversioned lifecycle warning) and the inference path before it (known
 * state, scans and charges since the cutoff, unproven verification, unknown
 * scan times, untouched orders). One rolled-back transaction per test.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";
import { getHistoricalOrders } from "../server/services/factory/netPositionHistoricalOrders";
import { FACTORY_ROW_HISTORY_VERSION } from "../server/services/audit/factoryRowHistory";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const today = new Date().toISOString().slice(0, 10);
const scope = (asOf: string): FactoryNetPositionAsOf => ({
  asOf,
  businessToday: today,
  timeZone: "UTC",
  isHistorical: true,
  historyBasis: "known-at-cutoff",
});

let seq = 0;

async function world(client: PoolClient) {
  const tag = `HNO${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
  const one = async (text: string, params: unknown[]) => Number((await client.query(text, params)).rows[0].id);
  const companyId = await one(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
    [tag]
  );
  const locationId = await one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Yard') RETURNING id`, [
    companyId,
    `${tag}L`,
  ]);
  const customerId = await one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Hist Customer') RETURNING id`,
    [companyId, `${tag}C`]
  );
  const order = (status: string, fields: Record<string, string | null> = {}) =>
    one(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, grand_total, total_qty_bales,
         created_at, updated_at, loading_started_at, verified_at, finalized_at, freight_amount)
       VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        companyId,
        customerId,
        fields.orderDate ?? "2026-05-01",
        status,
        locationId,
        fields.grandTotal ?? "100",
        fields.createdAt ?? "2026-05-01T08:00:00Z",
        fields.updatedAt ?? "2026-05-02T08:00:00Z",
        fields.loadingStartedAt ?? null,
        fields.verifiedAt ?? null,
        fields.finalizedAt ?? null,
        fields.freight ?? "0",
      ]
    );
  const bale = async (orderId: number, price: string, scannedAt: string | null) => {
    const reference = `${tag}-B${++seq}`;
    const baleId = await one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status) VALUES ($1, $2, $2, 20, 'IN_STOCK') RETURNING id`,
      [companyId, reference]
    );
    await client.query(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, scanned_at) VALUES ($1, $2, $3, $4, 20, $5, $6)`,
      [orderId, baleId, reference, locationId, price, scannedAt]
    );
  };
  return { companyId, customerId, order, bale };
}

describe("getHistoricalOrders from recorded row history", () => {
  it("buckets recorded orders by status and warns about statuses it cannot place", async () => {
    await withRolledBackPool(async (client) => {
      // A DB another suite left without baselines must not hide the recorded path;
      // the surrounding transaction is rolled back, so nothing persists.
      await client.query(
        `INSERT INTO factory_row_history_baselines (table_name, version, baseline_at, snapshot_rows)
         VALUES ('customer_orders', $1, '2026-01-01', 0)
         ON CONFLICT ON CONSTRAINT factory_row_history_baselines_pkey DO NOTHING`,
        [FACTORY_ROW_HISTORY_VERSION]
      );
      const w = await world(client);
      const loading = await w.order("LOADING", { orderDate: today });
      const verified = await w.order("VERIFIED", { orderDate: today });
      const pending = await w.order("PENDING_VERIFICATION", { orderDate: today });
      await w.order("FINALIZED", { orderDate: today });
      await w.order("DRAFT", { orderDate: today });
      const result = await getHistoricalOrders(w.companyId, scope(today));
      expect(result.loadingOrders.map((o) => o.id)).toEqual([loading]);
      expect(result.verifiedOrders.map((o) => o.id)).toEqual([verified]);
      expect(result.pendingOrders).toEqual([
        { id: pending, customerName: "Hist Customer", orderDate: today, grandTotal: 100, totalQtyBales: 2 },
      ]);
      expect(result.warnings).toEqual(["HISTORICAL_ORDER_LIFECYCLE_UNVERSIONED"]);
    });
  });
});

describe("getHistoricalOrders before the row-history baseline", () => {
  const asOf = "2026-06-30";

  it("keeps the stored totals of orders untouched since the cutoff and drops finalized ones", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const loading = await w.order("LOADING", { grandTotal: "250" });
      const verified = await w.order("VERIFIED");
      const pending = await w.order("PENDING_VERIFICATION");
      await w.order("FINALIZED", { finalizedAt: "2026-05-02T07:00:00Z" });
      await w.order("LOADING", { orderDate: "2026-07-05", createdAt: "2026-07-05T08:00:00Z" });
      const result = await getHistoricalOrders(w.companyId, scope(asOf));
      expect(result.loadingOrders).toEqual([
        { id: loading, customerName: "Hist Customer", orderDate: "2026-05-01", grandTotal: 250, totalQtyBales: 2 },
      ]);
      expect(result.verifiedOrders.map((o) => o.id)).toEqual([verified]);
      expect(result.pendingOrders.map((o) => o.id)).toEqual([pending]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("values orders changed after the cutoff from their dated scans and warns about what it cannot date", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const changed = await w.order("LOADING", {
        updatedAt: "2026-08-01T08:00:00Z",
        loadingStartedAt: "2026-05-01T09:00:00Z",
        freight: "15",
      });
      await w.bale(changed, "40", "2026-05-03T08:00:00Z");
      await w.bale(changed, "60", "2026-07-10T08:00:00Z");
      const undated = await w.order("LOADING", {
        updatedAt: "2026-08-01T08:00:00Z",
        loadingStartedAt: "2026-05-01T09:00:00Z",
      });
      await w.bale(undated, "10", null);
      await w.order("PENDING_VERIFICATION", {
        updatedAt: "2026-08-01T08:00:00Z",
        loadingStartedAt: "2026-05-01T09:00:00Z",
        verifiedAt: "2026-05-05T09:00:00Z",
      });
      await w.order("LOADING", { updatedAt: "2026-08-01T08:00:00Z" });

      const result = await getHistoricalOrders(w.companyId, scope(asOf));
      const changedRow = result.loadingOrders.find((o) => o.id === changed);
      expect(changedRow).toMatchObject({ grandTotal: 40, totalQtyBales: 1 });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "HISTORICAL_ORDER_CHARGES_UNVERSIONED",
          "HISTORICAL_ORDER_SCAN_PRICE_EDITS_UNVERSIONED",
          "HISTORICAL_ORDER_BACKDATED_VERIFICATION_UNPROVEN",
        ])
      );
    });
  });
});
