/**
 * A posted stock transfer inside a rolled-back factory world, for the stock
 * transfer revision route suites: Yard -> Shop, two items, and another
 * company with its own location, item and transfer for wrong-company checks.
 */
import { expect } from "vitest";

import type { FactoryWorld } from "./rolledBackFactoryApp";

export interface RevisionWorld {
  transferId: number;
  voucherId: number;
  shop: number;
  itemA: number;
  itemB: number;
  foreignLocation: number;
  foreignItem: number;
  foreignTransferId: number;
}

export async function revisionWorld(w: FactoryWorld): Promise<RevisionWorld> {
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}S`,
  ]);
  const itemA = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Bale A', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}A`]
  );
  const itemB = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Bale B', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}B`]
  );
  for (const item of [itemA, itemB]) {
    await w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 10, 2, 20)`,
      [w.companyId, w.locationId, item]
    );
  }
  const created = await w.agent.post("/api/stock-transfers").send({
    sourceLocationId: w.locationId,
    destinationLocationId: shop,
    items: [
      { stockItemId: itemA, quantity: "4" },
      { stockItemId: itemB, quantity: "2" },
    ],
  });
  expect(created.status, created.text).toBe(201);

  const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}O`,
  ]);
  const foreignLocation = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other') RETURNING id`,
    [other, `${w.tag}OL`]
  );
  const foreignItem = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Other', 'PCS', true) RETURNING id`,
    [other, `${w.tag}OI`]
  );
  const foreignVoucher = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Stock Transfer', CURRENT_DATE, 0) RETURNING id`,
    [other, `${w.tag}OV`]
  );
  const foreignTransferId = await w.one(
    `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id, inventory_applied)
     VALUES ($1, $2, $2, false) RETURNING id`,
    [foreignVoucher, foreignLocation]
  );
  return {
    transferId: Number(created.body.transfer.id),
    voucherId: Number(created.body.voucher.id),
    shop,
    itemA,
    itemB,
    foreignLocation,
    foreignItem,
    foreignTransferId,
  };
}

export function line(
  w: FactoryWorld,
  stockItemId: number,
  originalQuantity: number,
  newQuantity: number,
  sourceLocationId = w.locationId
) {
  return { stockItemId, stockItemName: `Item ${stockItemId}`, sourceLocationId, originalQuantity, newQuantity };
}

export async function transferQuantities(w: FactoryWorld, transferId: number) {
  const rows = await w.q<{ stock_item_id: number; q: string }>(
    `SELECT stock_item_id, quantity::numeric::text AS q FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY stock_item_id`,
    [transferId]
  );
  return rows.map((row) => Number(row.q));
}

export async function revisionCount(w: FactoryWorld, transferId: number) {
  const [row] = await w.q<{ n: number }>(
    `SELECT count(*)::int AS n FROM stock_transfer_revisions WHERE transfer_id = $1`,
    [transferId]
  );
  return row.n;
}
