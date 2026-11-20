/**
 * GET /api/stock-items/:id/vouchers/:year/:month
 * (server/routes/handleGetStockItemsIdVouchersYearMonthStep1.ts) over HTTP
 * against PostgreSQL, one rolled-back company per test.
 *
 * Pinned: an unknown item is 404; a month with no history has no opening row
 * and zero totals; the opening balance sums prior purchases, adjustments and
 * sales; the month lists purchases, both legs of each transfer (with
 * "Unknown" for a missing source or destination name), production and
 * consumption adjustments, and POS sales named after the voucher's location
 * name, its location row, or "Cash"; outward rows are valued at the running
 * weighted average. Another company's movements never appear, and another
 * company's item id is 404.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item, nextSeq, otherCompany, voucher } from "./helpers/voucherReadFixture";

async function purchase(w: FactoryWorld, stockItemId: number, createdAt: string, qty: string, total: string) {
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, email, legal_name) VALUES ($1, $2, '', 'Supplier') RETURNING id`,
    [w.companyId, `${w.tag}S${nextSeq()}`]
  );
  const container = await w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id)
     VALUES ($1, $2, '2026-01-01', $3) RETURNING id`,
    [w.companyId, `${w.tag}C${nextSeq()}`, supplier]
  );
  const po = await w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, container, `${w.tag}PO${nextSeq()}`, supplier, createdAt]
  );
  await w.q(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'Item', $3, $4::numeric / NULLIF($3::numeric, 0), $4)`,
    [po, stockItemId, qty, total]
  );
  return { po, container };
}

async function adjustment(w: FactoryWorld, stockItemId: number, date: string, qty: string, total: string) {
  const v = await voucher(w, "Stock Adjustment", { date });
  const adj = await w.one(
    `INSERT INTO stock_adjustment_vouchers (voucher_id, adjustment_type, location_id) VALUES ($1, 'production', $2) RETURNING id`,
    [v, w.locationId]
  );
  await w.q(
    `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount)
     VALUES ($1, $2, $3, abs($4::numeric / NULLIF($3::numeric, 0)), $4)`,
    [adj, stockItemId, qty, total]
  );
}

async function sale(
  w: FactoryWorld,
  stockItemId: number,
  date: string,
  qty: string,
  where: { locationId?: number | null; locationName?: string | null } = {},
  companyId = w.companyId
) {
  const v = await voucher(w, "Sales", { date, locationId: where.locationId ?? null, companyId });
  await w.q(`UPDATE vouchers SET location_name = $2 WHERE id = $1`, [v, where.locationName ?? null]);
  await w.q(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, total_sales, cost_price, total_cost, profit)
     VALUES ($1, $2, $3, 15, $3::numeric * 15, 10, $3::numeric * 10, $3::numeric * 5)`,
    [v, stockItemId, qty]
  );
}

async function transfer(w: FactoryWorld, stockItemId: number, date: string, source: number | null, dest: number) {
  const v = await voucher(w, "Stock Transfer", { date });
  const t = await w.one(
    `INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2) RETURNING id`,
    [v, dest]
  );
  await w.q(
    `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount, source_location_id)
     VALUES ($1, $2, 2, 10, 20, $3)`,
    [t, stockItemId, source]
  );
}

const url = (id: number, year = 2026, month = 5) => `/api/stock-items/${id}/vouchers/${year}/${month}`;

describe("stock item monthly vouchers", () => {
  it("answers 404 for an unknown item and an empty month without an opening row", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(url(999999999))).status).toBe(404);
      const id = await item(w, "Quiet");
      const res = await w.agent.get(url(id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ year: 2026, month: 5, monthName: "May", transactions: [] });
      expect(res.body.openingBalance).toEqual({ qty: 0, rate: 0, value: 0 });
      expect(res.body.totals).toMatchObject({ inwardQty: 0, inwardRate: 0, outwardRate: 0, closingRate: 0 });
    }));

  it("builds the opening balance and every movement kind for the month", () =>
    withFactoryWorld(async (w) => {
      const id = await item(w, "Bales");
      const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
        w.companyId,
        `${w.tag}SH`,
      ]);
      // Prior to May: +10 purchased (100), +5 produced (60), -3 consumed (-30), 2 sold (cost 20).
      await purchase(w, id, "2026-03-10", "10", "100");
      await adjustment(w, id, "2026-04-01", "5", "60");
      await adjustment(w, id, "2026-04-02", "-3", "-30");
      await sale(w, id, "2026-04-03", "2");
      // May movements.
      await purchase(w, id, "2026-05-02 10:00", "4", "48");
      await transfer(w, id, "2026-05-03", w.locationId, shop);
      // A blank-named destination and a missing source both read "Unknown".
      const blank = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, '') RETURNING id`, [
        w.companyId,
        `${w.tag}BL`,
      ]);
      await transfer(w, id, "2026-05-04", null, blank);
      await adjustment(w, id, "2026-05-05", "2", "20");
      await adjustment(w, id, "2026-05-06", "-1", "-11");
      await sale(w, id, "2026-05-07", "1", { locationName: "Front Desk" });
      await sale(w, id, "2026-05-08", "1", { locationId: shop });
      await sale(w, id, "2026-05-09", "1");
      // Another company's sale of the same item id never appears.
      await sale(w, id, "2026-05-10", "50", {}, await otherCompany(w));

      const res = await w.agent.get(url(id));
      expect(res.status).toBe(200);
      expect(res.body.openingBalance).toEqual({ qty: 10, rate: 11, value: 110 });
      const rows = res.body.transactions.map((t: Record<string, unknown>) => [t.particulars, t.vchType]);
      expect(rows).toEqual([
        ["Opening Balance", ""],
        [expect.stringContaining(w.tag), "PURCHASE IMPORT"],
        ["To Shop", "Stock Transfer - Yard"],
        ["From Yard", "Stock Transfer - Shop"],
        ["To Unknown", "Stock Transfer - Unknown"],
        ["From Unknown", "Stock Transfer - Unknown"],
        ["Yard", "Production"],
        ["Yard", "Consumption"],
        ["Front Desk", "POS - Front Desk"],
        ["Shop", "POS - Shop"],
        ["Cash", "POS - Cash"],
      ]);
      const consumption = res.body.transactions[7];
      expect(consumption).toMatchObject({ inwardQty: 0, outwardQty: 1 });
      const pos = res.body.transactions[8];
      expect(pos).toMatchObject({ isPOS: true, posSellingRate: 15, posSellingValue: 15, outwardQty: 1 });
      // Closing: opening 10 + inward 10 (4 bought, 4 transferred in, 2 produced) - outward 8 = 12.
      expect(res.body.totals.closingQty).toBe(12);
      expect(res.body.totals.inwardQty).toBe(10);
      expect(res.body.totals.outwardQty).toBe(8);
      expect(res.body.totals.inwardRate).toBeGreaterThan(0);
      expect(res.body.totals.outwardRate).toBeGreaterThan(0);
      expect(res.body.totals.closingValue).toBeCloseTo(12 * res.body.totals.closingRate, 6);
    }));

  it("drives the running quantity negative and reports zero rates", () =>
    withFactoryWorld(async (w) => {
      const id = await item(w, "Oversold");
      await sale(w, id, "2026-04-03", "2");
      const res = await w.agent.get(url(id));
      expect(res.body.openingBalance).toEqual({ qty: -2, rate: 0, value: -20 });
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.totals).toMatchObject({ closingQty: -2, closingRate: 0 });
    }));
});

describe("company scope", () => {
  it("answers 404 for another company's item id", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Foreign Secret', 'PCS') RETURNING id`,
        [other, `${w.tag}FI`]
      );
      await sale(w, foreign, "2026-05-07", "3", {}, other);
      const res = await w.agent.get(url(foreign));
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Foreign Secret");
    }));
});
