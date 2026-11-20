/**
 * POST /api/retail/import over real HTTP in one rolled-back transaction per
 * test. Pinned: the retail-company guard, the row-count and in-file
 * duplicate refusals, the per-row refusals that roll the whole file back,
 * and a successful create-then-update import with its stock movements.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const row = (w: FactoryWorld, extra: Record<string, unknown> = {}) => ({
  code: `${w.tag}-TEE`,
  name: "Tee",
  brand: "Acme",
  color: "Red",
  size: "M",
  barcode: `${w.tag}-111`,
  cost: 4,
  price: 10,
  qty: 5,
  location: `${w.tag}L`,
  ...extra,
});

const importRows = (w: FactoryWorld, rows: unknown, idempotencyKey?: string) =>
  w.agent.post("/api/retail/import").send({ rows, idempotencyKey });

async function asRetail(w: FactoryWorld) {
  await w.q(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [w.companyId]);
}

const productCount = async (w: FactoryWorld) =>
  (await w.q(`SELECT id FROM retail_products WHERE company_id = $1`, [w.companyId])).length;

describe("POST /api/retail/import refusals", () => {
  it("403s for a non-retail company and 400s for missing or oversized row lists", async () => {
    await withFactoryWorld(async (w) => {
      const factory = await importRows(w, [row(w)]);
      expect(factory.status).toBe(403);
      expect(factory.body.message).toMatch(/only available for Retail/);
      await asRetail(w);
      expect((await importRows(w, undefined)).body.message).toBe("No import rows supplied");
      const tooMany = await importRows(
        w,
        Array.from({ length: 5001 }, () => ({}))
      );
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.message).toMatch(/limited to 5,000 rows/);
      expect(await productCount(w)).toBe(0);
    });
  });

  it("400s for invalid rows, a barcode reused across variants and duplicate stock rows", async () => {
    await withFactoryWorld(async (w) => {
      await asRetail(w);
      const invalid = await importRows(w, [{ code: "" }]);
      expect(invalid.status).toBe(400);
      const reused = await importRows(w, [row(w), row(w, { size: "L" })]);
      expect(reused.status).toBe(400);
      expect(reused.body.message).toMatch(/assigned to more than one product\/color\/size/);
      const dup = await importRows(w, [row(w), row(w)]);
      expect(dup.status).toBe(400);
      expect(dup.body.message).toMatch(/Duplicate product\/color\/size\/location row/);
      expect(await productCount(w)).toBe(0);
    });
  });

  it("rolls the whole file back on an unknown location", async () => {
    await withFactoryWorld(async (w) => {
      await asRetail(w);
      const res = await importRows(w, [row(w), row(w, { size: "S", barcode: `${w.tag}-222`, location: "Nowhere" })]);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Unknown location for this company: Nowhere");
      expect(await productCount(w)).toBe(0);
    });
  });

  it("refuses a barcode that collides with an existing variant or a variant re-imported under a new barcode", async () => {
    await withFactoryWorld(async (w) => {
      await asRetail(w);
      expect((await importRows(w, [row(w)])).status).toBe(200);

      const owned = await importRows(w, [row(w, { code: `${w.tag}-OTHER`, name: "Other" })]);
      expect(owned.status).toBe(400);
      expect(owned.body.message).toBe(`Barcode already exists on another variant: ${w.tag}-111`);

      const rebarcoded = await importRows(w, [row(w, { barcode: `${w.tag}-999` })]);
      expect(rebarcoded.status).toBe(400);
      expect(rebarcoded.body.message).toBe(`Red / M on ${w.tag}-TEE already uses barcode ${w.tag}-111`);
      expect(await productCount(w)).toBe(1);
    });
  });

  it("refuses POS users before the company guard", async () => {
    await withFactoryWorld(async (w) => {
      await asRetail(w);
      const pos = await w.agentFor("POS");
      const res = await pos.post("/api/retail/import").send({ rows: [row(w)] });
      expect(res.status).toBe(403);
      expect(await productCount(w)).toBe(0);
    });
  });
});

describe("POST /api/retail/import success", () => {
  it("creates products, variants and stock, then updates quantity and cost on re-import", async () => {
    await withFactoryWorld(async (w) => {
      await asRetail(w);
      const first = await importRows(
        w,
        [
          row(w, { imageUrl: "https://example.com/tee.png", category: "Tops", description: "Cotton" }),
          row(w, { size: "L", barcode: `${w.tag}-112`, variantImageUrl: "https://example.com/l.png" }),
        ],
        `${w.tag}-batch1`
      );
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ rowsProcessed: 2, productsCreated: 1, variantsCreated: 2, stockRowsWritten: 2 });

      const second = await importRows(w, [row(w, { qty: 8, cost: 5, price: 12, location: "Yard" })]);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ rowsProcessed: 1, productsCreated: 0, variantsCreated: 0, stockRowsWritten: 1 });

      const [variant] = await w.q(
        `SELECT v.id, v.cost::text AS cost, v.selling_price::text AS price, i.quantity::text AS qty
           FROM retail_product_variants v JOIN retail_variant_inventory i ON i.variant_id = v.id
          WHERE v.company_id = $1 AND v.barcode = $2`,
        [w.companyId, `${w.tag}-111`]
      );
      expect([Number(variant.cost), Number(variant.price), Number(variant.qty)]).toEqual([5, 12, 8]);
      const movements = await w.q(
        `SELECT quantity_before::text AS b, quantity_after::text AS a, reference_id
           FROM retail_stock_movements WHERE company_id = $1 AND variant_id = $2 ORDER BY id`,
        [w.companyId, variant.id]
      );
      expect(movements.map((m) => [Number(m.b), Number(m.a)])).toEqual([
        [0, 5],
        [5, 8],
      ]);
      expect(movements[0].reference_id).toBe(`${w.tag}-batch1`);
    });
  });
});
