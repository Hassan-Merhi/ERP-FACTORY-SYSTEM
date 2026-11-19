/**
 * The stock-item bulk routes (delete, assign category, update prices, import
 * opening balances, bale UOM fix, rename) against PostgreSQL in one
 * rolled-back transaction per test: empty and invalid id lists, items of
 * another company skipped, deletion refused while inventory exists, code and
 * alias lookups, and the audit rows written with each change.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

const post = (w: FactoryWorld, path: string, body: Record<string, unknown>) =>
  w.agent.post(`/api/stock-items/${path}`).send(body);

async function stockItem(w: FactoryWorld, fields: { name?: string; uom?: string; companyId?: number } = {}) {
  const n = nextSeq();
  const code = `${w.tag}-B${n}`;
  const id = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, selling_price) VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [fields.companyId ?? w.companyId, code, fields.name ?? `Bulk ${n}`, fields.uom ?? "PCS"]
  );
  return { id, code };
}
const row = async (w: FactoryWorld, id: number) =>
  (
    await w.q(
      `SELECT name, uom, category_id, selling_price::text AS price, opening_qty::text AS oq, opening_rate::text AS orate,
         opening_value::text AS ov, deleted_at FROM stock_items WHERE id = $1`,
      [id]
    )
  )[0];

describe("bulk delete", () => {
  it("validates ids, skips foreign items, refuses items with inventory and audits each delete", async () => {
    await withFactoryWorld(async (w) => {
      expect((await post(w, "bulk-delete", { ids: [] })).status).toBe(400);
      expect((await post(w, "bulk-delete", { ids: ["x", -1] })).body.message).toBe("No valid numeric IDs provided");
      const foreign = await stockItem(w, { companyId: await otherCompany(w) });
      expect((await post(w, "bulk-delete", { ids: [foreign.id] })).status).toBe(404);
      const stocked = await stockItem(w);
      await w.q(`INSERT INTO inventory (company_id, location_id, stock_item_id, quantity) VALUES ($1, $2, $3, 0)`, [
        w.companyId,
        w.locationId,
        stocked.id,
      ]);
      const blocked = await post(w, "bulk-delete", { ids: [stocked.id] });
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toContain(stocked.code);
      expect((await row(w, stocked.id)).deleted_at).toBeNull();
      const a = await stockItem(w);
      const b = await stockItem(w);
      const ok = await post(w, "bulk-delete", { ids: [a.id, String(b.id), foreign.id] });
      expect(ok.body).toMatchObject({ deleted: 2, skipped: 1 });
      expect(ok.body.message).toMatch(/1 item\(s\) were skipped/);
      const audits = await w.q(
        `SELECT record_id FROM audit_log WHERE table_name = 'stock_items' AND action = 'delete' AND record_id = ANY($1)`,
        [[a.id, b.id]]
      );
      expect(audits).toHaveLength(2);
      const solo = await stockItem(w);
      expect((await post(w, "bulk-delete", { ids: [solo.id] })).body.message).toBe(
        "Successfully deleted 1 stock item(s)"
      );
    });
  });
});

describe("bulk assign category", () => {
  it("validates ids, refuses unknown items and sets or clears the category", async () => {
    await withFactoryWorld(async (w) => {
      expect((await post(w, "bulk-assign-category", { ids: "1" })).status).toBe(400);
      expect((await post(w, "bulk-assign-category", { ids: ["0"] })).status).toBe(400);
      expect((await post(w, "bulk-assign-category", { ids: [2147483000] })).status).toBe(404);
      const category = await w.one(`INSERT INTO stock_categories (company_id, name) VALUES ($1, $2) RETURNING id`, [
        w.companyId,
        `${w.tag} Cat`,
      ]);
      const a = await stockItem(w);
      const set = await post(w, "bulk-assign-category", { ids: [a.id], categoryId: String(category) });
      expect(set.body).toEqual({ message: "Category updated for 1 item(s)", updated: 1 });
      expect((await row(w, a.id)).category_id).toBe(category);
      await post(w, "bulk-assign-category", { ids: [a.id], categoryId: "none" });
      expect((await row(w, a.id)).category_id).toBeNull();
      await post(w, "bulk-assign-category", { ids: [a.id], categoryId: category });
      await post(w, "bulk-assign-category", { ids: [a.id], categoryId: null });
      expect((await row(w, a.id)).category_id).toBeNull();
    });
  });
});

describe("bulk price update and opening balances", () => {
  it("updates global and location prices by code or alias and counts unknown barcodes", async () => {
    await withFactoryWorld(async (w) => {
      expect((await post(w, "bulk-update-prices", { prices: [] })).status).toBe(400);
      const a = await stockItem(w);
      const b = await stockItem(w);
      await w.q(`INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)`, [
        w.companyId,
        b.id,
        `${w.tag}-ALIAS`,
      ]);
      const res = await post(w, "bulk-update-prices", {
        prices: [
          { barcode: a.code.toLowerCase(), sellingPrice: "12.50" },
          { barcode: `${w.tag}-alias`, sellingPrice: "7", locationId: w.locationId },
          { barcode: "missing-code", sellingPrice: "1" },
          { barcode: a.code, sellingPrice: "" },
        ],
      });
      expect(res.body).toEqual({ message: "Updated 2 price(s). 1 barcode(s) not found.", updated: 2, notFound: 1 });
      expect((await row(w, a.id)).price).toMatch(/^12\.5/);
      const [locationPrice] = await w.q(
        `SELECT selling_price::text AS p FROM stock_item_location_prices WHERE stock_item_id = $1 AND location_id = $2`,
        [b.id, w.locationId]
      );
      expect(locationPrice.p).toMatch(/^7/);
      const nothing = await post(w, "bulk-update-prices", { prices: [{ barcode: "missing", sellingPrice: "1" }] });
      expect(nothing.body).toEqual({ message: "Updated 0 price(s). 1 barcode(s) not found.", updated: 0, notFound: 1 });
    });
  });

  it("imports opening balances by code or alias, computing a missing total value", async () => {
    await withFactoryWorld(async (w) => {
      expect((await post(w, "import-opening-balances", { openingBalances: {} })).status).toBe(400);
      const a = await stockItem(w);
      const b = await stockItem(w);
      await w.q(`INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)`, [
        w.companyId,
        b.id,
        `${w.tag}-OB`,
      ]);
      const missing = Array.from({ length: 6 }, (_, i) => ({ barcode: `nope-${i}`, openingQty: 1 }));
      const res = await post(w, "import-opening-balances", {
        openingBalances: [
          { barcode: a.code, openingQty: "4", openingRate: "2.5" },
          { barcode: `${w.tag}-ob`, openingQty: "3", openingRate: "2", openingValue: "9" },
          { barcode: 42 },
          ...missing,
        ],
      });
      expect(res.body).toMatchObject({ updated: 2, notFound: 6 });
      expect(res.body.message).toMatch(/nope-4\.\.\.$/);
      expect(await row(w, a.id)).toMatchObject({ oq: expect.stringMatching(/^4/), ov: expect.stringMatching(/^10/) });
      expect((await row(w, b.id)).ov).toMatch(/^9/);
      const clean = await post(w, "import-opening-balances", { openingBalances: [{ barcode: a.code, openingQty: 1 }] });
      expect(clean.body.message).toBe("Updated opening balances for 1 item(s).");
    });
  });
});

describe("bulk UOM fix and rename", () => {
  it("changes every bale UOM spelling to BL and reports when there is none", async () => {
    await withFactoryWorld(async (w) => {
      const none = await post(w, "bulk-update-uom", {});
      expect(none.body).toEqual({ message: "No items with UOM 'bale' found to update", updated: 0 });
      const items = [await stockItem(w, { uom: "bale" }), await stockItem(w, { uom: "BALE" }), await stockItem(w)];
      const res = await post(w, "bulk-update-uom", {});
      expect(res.body.updated).toBe(2);
      expect((await row(w, items[0].id)).uom).toBe("BL");
      expect((await row(w, items[2].id)).uom).toBe("PCS");
    });
  });

  it("validates the request, renames matches, skips unchanged and refuses empty names", async () => {
    await withFactoryWorld(async (w) => {
      expect((await post(w, "bulk-rename", { findText: " ", replaceWith: "", itemIds: [1] })).status).toBe(400);
      expect((await post(w, "bulk-rename", { findText: "a", itemIds: [1] })).status).toBe(400);
      expect((await post(w, "bulk-rename", { findText: "a", replaceWith: "", itemIds: [] })).status).toBe(400);
      const shirt = await stockItem(w, { name: `${w.tag} Shirt shirt` });
      const word = await stockItem(w, { name: `${w.tag} Shirts` });
      const whole = await stockItem(w, { name: "Shirt" });
      const untouched = await stockItem(w, { name: `${w.tag} Coat` });
      const res = await post(w, "bulk-rename", {
        findText: "Shirt",
        replaceWith: "Top",
        wholeWordOnly: true,
        caseInsensitive: false,
        itemIds: [shirt.id, word.id, untouched.id],
      });
      expect(res.body.updated).toBe(1);
      expect((await row(w, shirt.id)).name).toBe(`${w.tag} Top shirt`);
      expect((await row(w, word.id)).name).toBe(`${w.tag} Shirts`);
      const empty = await post(w, "bulk-rename", { findText: "shirt", replaceWith: "", itemIds: [whole.id] });
      expect(empty.body.failures).toEqual([{ id: whole.id, name: "Shirt", reason: "Resulting name would be empty" }]);
      expect((await row(w, whole.id)).name).toBe("Shirt");
    });
  });
});
