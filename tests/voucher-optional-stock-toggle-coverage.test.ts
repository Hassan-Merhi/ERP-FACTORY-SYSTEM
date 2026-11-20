/**
 * The stock side of suspending/activating a voucher
 * (server/routes/vouchers/sales-update/optionalStockToggle.ts), driven through
 * PATCH /api/vouchers/:id/optional, one rolled-back transaction per test.
 *
 * Pinned: a suspended transfer gives the destination's stock back to the
 * source exactly and activation moves it again; a transfer created optional
 * is applied on activation; production, mixed and consumption adjustments and
 * credit/debit notes reverse and re-apply to the same quantity and value; a
 * stocked sale with no location is refused without touching anything; another
 * company's voucher and a non-admin role are refused.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

interface StockWorld {
  shop: number;
  item: number;
  cash: number;
}

async function stockWorld(w: FactoryWorld): Promise<StockWorld> {
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}S`,
  ]);
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Bale', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}IT`]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 10, 2, 20)`,
    [w.companyId, w.locationId, item]
  );
  const cash = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Till', 'Cash') RETURNING id`,
    [w.companyId, `${w.tag}CA`]
  );
  return { shop, item, cash };
}

async function stock(w: FactoryWorld, locationId: number, item: number) {
  const [row] = await w.q<{ q: string; v: string }>(
    `SELECT quantity::numeric::text AS q, total_value::numeric::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, item]
  );
  return row ? [Number(row.q), Number(row.v)] : [0, 0];
}

const toggle = (w: FactoryWorld, voucherId: number, optional: boolean) =>
  w.agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional });

async function transfer(w: FactoryWorld, s: StockWorld, optional = false) {
  const res = await w.agent.post("/api/stock-transfers").send({
    sourceLocationId: w.locationId,
    destinationLocationId: s.shop,
    items: [{ stockItemId: s.item, quantity: "4" }],
    optional,
  });
  expect(res.status, res.text).toBe(201);
  return Number(res.body.voucher.id);
}

async function adjustment(w: FactoryWorld, s: StockWorld, type: string, items: { quantity: number; rate: number }[]) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, location_id)
     VALUES ($1, $2, $3, CURRENT_DATE, 0, 'USD', $4) RETURNING id`,
    [w.companyId, `${w.tag}${type.slice(0, 3)}${Math.floor(Math.random() * 1e6)}`, type, w.locationId]
  );
  const res = await w.agent.post("/api/stock-adjustments").send({
    voucherId,
    locationId: w.locationId,
    adjustmentType: type,
    notes: type,
    items: items.map((line) => ({ stockItemId: s.item, ...line })),
  });
  expect(res.status, res.text).toBe(201);
  return voucherId;
}

describe("optional toggle of stock transfers", () => {
  it("suspends a posted transfer exactly and activates it again", async () => {
    await withFactoryWorld(async (w) => {
      const s = await stockWorld(w);
      const voucherId = await transfer(w, s);
      expect([await stock(w, w.locationId, s.item), await stock(w, s.shop, s.item)]).toEqual([
        [6, 12],
        [4, 8],
      ]);
      const suspended = await toggle(w, voucherId, true);
      expect(suspended.status, suspended.text).toBe(200);
      expect([await stock(w, w.locationId, s.item), await stock(w, s.shop, s.item)]).toEqual([
        [10, 20],
        [0, 0],
      ]);
      const [flag] = await w.q(`SELECT inventory_applied FROM stock_transfer_vouchers WHERE voucher_id = $1`, [
        voucherId,
      ]);
      expect(flag.inventory_applied).toBe(false);
      expect((await toggle(w, voucherId, false)).status).toBe(200);
      expect([await stock(w, w.locationId, s.item), await stock(w, s.shop, s.item)]).toEqual([
        [6, 12],
        [4, 8],
      ]);
      const moves = await w.q(
        `SELECT source_type FROM canonical_stock_movements WHERE company_id = $1 AND source_type LIKE 'voucher-optional-toggle-transfer%' ORDER BY id`,
        [w.companyId]
      );
      expect(moves.map((m) => m.source_type)).toEqual([
        "voucher-optional-toggle-transfer-reverse",
        "voucher-optional-toggle-transfer-reverse",
        "voucher-optional-toggle-transfer-apply",
        "voucher-optional-toggle-transfer-apply",
      ]);
    });
  });

  it("applies a transfer created optional when it is activated", async () => {
    await withFactoryWorld(async (w) => {
      const s = await stockWorld(w);
      const voucherId = await transfer(w, s, true);
      expect(await stock(w, s.shop, s.item)).toEqual([0, 0]);
      expect((await toggle(w, voucherId, false)).status).toBe(200);
      expect(await stock(w, s.shop, s.item)).toEqual([4, 8]);
      const [line] = await w.q(
        `SELECT sti.value_moved::numeric::text AS v FROM stock_transfer_items sti
           JOIN stock_transfer_vouchers st ON st.id = sti.transfer_id WHERE st.voucher_id = $1`,
        [voucherId]
      );
      expect(Number(line.v)).toBe(8);
    });
  });
});

describe("optional toggle of stock adjustments", () => {
  it.each([
    ["Production", [{ quantity: 5, rate: 3 }], [15, 35]],
    [
      "Mixed",
      [
        { quantity: 2, rate: 4 },
        { quantity: -3, rate: 0 },
      ],
      [9, 22],
    ],
    ["Consumption", [{ quantity: 4, rate: 0 }], [6, 12]],
  ] as const)("reverses and re-applies a %s adjustment to the same stock", async (type, lines, posted) => {
    await withFactoryWorld(async (w) => {
      const s = await stockWorld(w);
      const voucherId = await adjustment(w, s, type, [...lines]);
      const after = await stock(w, w.locationId, s.item);
      expect(after[0]).toBe(posted[0]);
      const suspended = await toggle(w, voucherId, true);
      expect(suspended.status, suspended.text).toBe(200);
      expect(await stock(w, w.locationId, s.item)).toEqual([10, 20]);
      expect((await toggle(w, voucherId, false)).status).toBe(200);
      expect((await stock(w, w.locationId, s.item))[0]).toBe(posted[0]);
    });
  });
});

describe("optional toggle of credit and debit notes", () => {
  it.each(["Credit Note", "Debit Note"])("reverses and re-applies a %s", async (noteType) => {
    await withFactoryWorld(async (w) => {
      const s = await stockWorld(w);
      const note = await w.agent.post("/api/credit-notes").send({
        noteType,
        voucherDate: new Date().toISOString().slice(0, 10),
        cashAccountId: s.cash,
        cashAccountType: "ledger",
        items: [{ stockItemId: s.item, locationId: w.locationId, quantity: 2, refundRate: 6, inventoryCost: 2 }],
      });
      expect(note.status, note.text).toBe(200);
      const posted = await stock(w, w.locationId, s.item);
      expect(posted[0]).toBe(noteType === "Credit Note" ? 12 : 8);
      const suspended = await toggle(w, note.body.voucherId, true);
      expect(suspended.status, suspended.text).toBe(200);
      expect(await stock(w, w.locationId, s.item)).toEqual([10, 20]);
      expect((await toggle(w, note.body.voucherId, false)).status).toBe(200);
      expect(await stock(w, w.locationId, s.item)).toEqual(posted);
    });
  });
});

describe("optional toggle refusals", () => {
  it("refuses a stocked sale with no location, another company's voucher and a non-admin role", async () => {
    await withFactoryWorld(async (w) => {
      const s = await stockWorld(w);
      const sale = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
         VALUES ($1, $2, 'Sales', CURRENT_DATE, 0, 'USD') RETURNING id`,
        [w.companyId, `${w.tag}SL`]
      );
      await w.q(
        `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit) VALUES ($1, $2, 1, 0, 0, 0, 0, 0)`,
        [sale, s.item]
      );
      const noLocation = await toggle(w, sale, true);
      expect(noLocation.status, noLocation.text).toBe(409);
      expect(noLocation.body.message).toMatch(/without its original stock location/);
      const [flag] = await w.q(`SELECT optional FROM vouchers WHERE id = $1`, [sale]);
      expect(flag.optional).toBe(false);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount) VALUES ($1, $2, 'Journal', CURRENT_DATE, 0) RETURNING id`,
        [other, `${w.tag}TV`]
      );
      // A path-scope guard answers another company's voucher id before the handler.
      expect((await toggle(w, theirs, true)).status).toBe(404);

      const voucherId = await transfer(w, s);
      const manager = await w.agentFor("Manager");
      expect((await manager.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: true })).status).toBe(403);
      expect(await stock(w, s.shop, s.item)).toEqual([4, 8]);
    });
  });
});
