/**
 * POST /api/admin/rebuild-inventory over real HTTP in one rolled-back
 * transaction per test. Seeds every replayed source (offload items, offload
 * PO-line fallback, transfers with item / header / no source, consumption /
 * production / other adjustments, sales, credit and debit notes) plus stale
 * transfer flags, then pins the dry-run report, the applied rebuild (update
 * and insert), name fallbacks, the role refusal and the cut-over refusal.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/admin/rebuild-inventory";
let seq = 0;

/** The apply path is a privileged operation: a confirmed password and the company's token. */
async function apply(w: FactoryWorld) {
  await w.agent.post("/api/auth/confirm-password").send({ password: "rolledback-pass-123" });
  return w.agent.post(URL).send({
    dryRun: false,
    confirmationToken: `REBUILD-INVENTORY:${w.companyId}`,
    reason: "coverage rebuild",
    idempotencyKey: `${w.tag}-rebuild-${++seq}`,
    sourceId: `${w.tag}-rebuild-${seq}`,
  });
}

async function seed(w: FactoryWorld) {
  const loc2 = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}L2`,
  ]);
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cream', 'KG') RETURNING id`,
    [w.companyId, `${w.tag}I`]
  );
  const voucher = (type: string, optional = false, locationId: number | null = null) =>
    w.one(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, optional, location_id)
       VALUES ($1, $2, $3, '2026-02-01', 0, $4, $5) RETURNING id`,
      [w.companyId, type, `${w.tag}V${++seq}`, optional, locationId]
    );
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', '') RETURNING id`,
    [w.companyId, `${w.tag}S`]
  );
  const container = async (n: string) =>
    w.one(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-01-01', $3) RETURNING id`,
      [w.companyId, `${w.tag}${n}`, supplier]
    );
  const offload = (containerId: number) =>
    w.one(
      `INSERT INTO container_offloads (container_id, location_id, additional_cost_per_bale, total_bales) VALUES ($1, $2, 0, 1) RETURNING id`,
      [containerId, w.locationId]
    );
  // Offload with items (one zero-quantity line ignored).
  const withItems = await offload(await container("C1"));
  await w.q(
    `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value) VALUES ($1, $2, 100, 2, 200), ($1, $2, 0, 2, 0)`,
    [withItems, item]
  );
  // Offload without items falls back to its container's PO lines.
  const c2 = await container("C2");
  await offload(c2);
  const po = await w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, c2, `${w.tag}PO`, supplier]
  );
  await w.q(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Cream', 10, 2, 20), ($1, $2, 'Cream', 0, 2, 0)`,
    [po, item]
  );
  // Transfers: header source, item source override, no source; zero line skipped.
  const transfer = async (source: number | null, applied: boolean, optional = false) => {
    const v = await voucher("Stock Transfer", optional);
    return w.one(
      `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id, inventory_applied) VALUES ($1, $2, $3, $4) RETURNING id`,
      [v, source, loc2, applied]
    );
  };
  const t1 = await transfer(w.locationId, false);
  await w.q(
    `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount, source_location_id)
     VALUES ($1, $2, 5, 2, 10, NULL), ($1, $2, 0, 2, 0, NULL), ($1, $2, 1, 2, 2, $3)`,
    [t1, item, w.locationId]
  );
  const t2 = await transfer(null, true);
  await w.q(
    `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 2, 2, 4)`,
    [t2, item]
  );
  await transfer(w.locationId, true, true);
  // Adjustments.
  for (const [type, qty] of [
    ["Consumption", 3],
    ["Production", -4],
    ["Other", 1],
    ["Other", 0],
  ] as const) {
    const v = await voucher("Stock Adjustment");
    const adj = await w.one(
      `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, $3) RETURNING id`,
      [v, w.locationId, type]
    );
    await w.q(
      `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, $3, 2, 0)`,
      [adj, item, qty]
    );
  }
  // Sales.
  const sale = await voucher("Sales", false, w.locationId);
  await w.q(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
     VALUES ($1, $2, 2, 5, 2, 10, 4, 6), ($1, $2, 0, 5, 2, 0, 0, 0)`,
    [sale, item]
  );
  // Credit and debit notes.
  for (const type of ["Credit Note", "Debit Note"]) {
    const v = await voucher(type);
    await w.q(
      `INSERT INTO credit_note_items (voucher_id, stock_item_id, location_id, quantity, rate, total_value, inventory_cost)
       VALUES ($1, $2, $3, 1, 2, 2, 2), ($1, $2, $3, 0, 2, 0, 2)`,
      [v, item, w.locationId]
    );
  }
  // Current inventory: one wrong row to update, one orphan row with no sources.
  const orphanItem = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Orphan', 'KG') RETURNING id`,
    [w.companyId, `${w.tag}O`]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate) VALUES ($1, $2, $3, 1, 1, 1), ($1, $4, $5, 3, 6, 2)`,
    [w.companyId, w.locationId, item, loc2, orphanItem]
  );
  return { loc2, item, orphanItem };
}

describe("rebuild inventory", () => {
  it("reports stale flags and discrepancies on a dry run without writing", () =>
    withFactoryWorld(async (w) => {
      const { loc2, item, orphanItem } = await seed(w);
      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        dryRun: true,
        staleFlagsFound: 2,
        staleFlagsFixed: 0,
        staleFlagDetails: { optionalWithAppliedTrue: 1, nonOptionalWithAppliedFalse: 1 },
        totalInventoryRecords: 2,
        fixesApplied: 0,
      });
      const byKey = Object.fromEntries(
        res.body.discrepancies.map((d: Record<string, unknown>) => [`${d.locationId}-${d.stockItemId}`, d])
      );
      // Yard: 100 + 10 - 5 - 1 (transfers out) - 3 + 4 + 1 (adjustments) - 2 (sale) + 1 - 1 (notes) = 104
      expect(byKey[`${w.locationId}-${item}`]).toMatchObject({ expectedQty: 104, currentQty: 1, locationName: "Yard" });
      expect(byKey[`${loc2}-${item}`]).toMatchObject({ expectedQty: 8, currentQty: 0, locationName: "Shop" });
      expect(byKey[`${loc2}-${orphanItem}`]).toMatchObject({ expectedQty: 0, stockItemName: "Orphan" });
      const [inv] = await w.q(`SELECT quantity FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
        w.locationId,
        item,
      ]);
      expect(Number(inv.quantity)).toBe(1);
    }));

  it("applies the rebuild, fixing flags and updating or inserting rows", () =>
    withFactoryWorld(async (w) => {
      const { loc2, item } = await seed(w);
      const res = await apply(w);
      expect(res.body).toMatchObject({ dryRun: false, staleFlagsFixed: 2, fixesApplied: 3 });
      const rows = await w.q<{ location_id: number; quantity: string }>(
        `SELECT location_id, quantity FROM inventory WHERE stock_item_id = $1 ORDER BY location_id`,
        [item]
      );
      expect(rows.map((r) => [r.location_id, Number(r.quantity)])).toEqual(
        [
          [w.locationId, 104],
          [loc2, 8],
        ].sort((a, b) => a[0] - b[0])
      );
      const flags = await w.q(
        `SELECT inventory_applied FROM stock_transfer_vouchers stv JOIN vouchers v ON v.id = stv.voucher_id
        WHERE v.company_id = $1 ORDER BY stv.id`,
        [w.companyId]
      );
      expect(flags.map((f) => f.inventory_applied)).toEqual([true, true, false]);
      const again = await apply(w);
      expect(again.body).toMatchObject({ staleFlagsFound: 0, discrepanciesFound: 0, fixesApplied: 0 });
    }));

  it("falls back to id labels for locations and items outside the company", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}OC`]
      );
      const foreignLoc = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
        [other, `${w.tag}FL`]
      );
      const foreignItem = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Far Item', 'KG') RETURNING id`,
        [other, `${w.tag}FI`]
      );
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value) VALUES ($1, $2, $3, 2, 2)`,
        [w.companyId, foreignLoc, foreignItem]
      );
      const res = await w.agent.post(URL).send({ dryRun: true });
      expect(res.body.discrepancies).toEqual([
        expect.objectContaining({
          locationName: `Location #${foreignLoc}`,
          stockItemName: `Item #${foreignItem}`,
          stockItemCode: "",
        }),
      ]);
    }));

  it("refuses an unconfirmed apply and non-admin roles", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post(URL).send({ dryRun: false })).status).toBe(403);
      const clerk = await w.agentFor("Accountant");
      expect((await clerk.post(URL).send({ dryRun: false })).status).toBe(403);
    }));

  it("refuses to apply after the perpetual-inventory cut-over but still allows a dry run", () =>
    withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-01-01', '{}'::jsonb, 'test')`,
        [w.companyId]
      );
      const refused = await apply(w);
      expect([refused.status, refused.body.action]).toEqual([409, "rebuild-inventory"]);
      expect((await w.agent.post(URL).send({ dryRun: true })).status).toBe(200);
    }));
});
