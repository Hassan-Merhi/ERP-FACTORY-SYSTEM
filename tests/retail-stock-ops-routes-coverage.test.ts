/**
 * server/routes/pos/retailStockOpsRoutes.ts lookup, receipt, exchange
 * refusals and movement history over HTTP against PostgreSQL, one rolled-back
 * retail company per test.
 *
 * Pinned: lookup needs a barcode or variant id, matches a barcode exactly
 * then case-insensitively, falls back to "Other / No Brand", merges variant
 * and style images and reports archived items as inactive; another company's
 * barcode is not found. Receipts refuse another company's location or
 * variant, default the unit cost to the variant's cost and replay a key.
 * Exchanges refuse a POS user's no-restock or on-account refund, another
 * company's location and an unknown sale. Movement history validates the id,
 * clamps the limit and names the counterpart location.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

async function retailVariant(w: FactoryWorld, opts: { brand?: boolean; barcode?: string; companyId?: number } = {}) {
  const companyId = opts.companyId ?? w.companyId;
  await w.q(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [w.companyId]);
  const brand = opts.brand
    ? await w.one(
        `INSERT INTO retail_brands (company_id, name, normalized_name) VALUES ($1, 'Acme', 'acme') RETURNING id`,
        [companyId]
      )
    : null;
  const product = await w.one(
    `INSERT INTO retail_products (company_id, code, name, brand_id, image_urls) VALUES ($1, $2, 'Polo', $3, $4::jsonb) RETURNING id`,
    [companyId, `${w.tag}P${nextSeq()}`, brand, JSON.stringify(["https://img.example/style.jpg"])]
  );
  const variant = await w.one(
    `INSERT INTO retail_product_variants (company_id, product_id, color, size, barcode, cost, selling_price, image_urls)
     VALUES ($1, $2, 'Blue', 'M', $3, 7.5, 20, $4::jsonb) RETURNING id`,
    [companyId, product, opts.barcode ?? `${w.tag}BC${nextSeq()}`, JSON.stringify(["https://img.example/v.jpg"])]
  );
  return { product, variant };
}

const lookup = (w: FactoryWorld, params: Record<string, string>) =>
  w.agent.get("/api/retail/stock/lookup").query({ ...params });

describe("retail stock lookup", () => {
  it("requires a barcode or id and matches exactly, case-insensitively and by id", () =>
    withFactoryWorld(async (w) => {
      const { variant, product } = await retailVariant(w, { barcode: `${w.tag}abc` });
      expect((await lookup(w, {})).status).toBe(400);
      expect((await lookup(w, { variantId: "-1" })).status).toBe(400);
      const exact = await lookup(w, { barcode: `${w.tag}abc` });
      expect(exact.status).toBe(200);
      expect(exact.body).toMatchObject({
        variantId: variant,
        brand: "Other / No Brand",
        active: true,
        cost: 7.5,
        imageUrls: ["https://img.example/v.jpg", "https://img.example/style.jpg"],
        stocks: [],
        totalQuantity: 0,
      });
      expect((await lookup(w, { barcode: `${w.tag}ABC`.toUpperCase() })).body.variantId).toBe(variant);
      await w.q(`UPDATE retail_products SET active = false, image_urls = '[]'::jsonb WHERE id = $1`, [product]);
      const byId = await lookup(w, { variantId: String(variant) });
      expect(byId.body).toMatchObject({ active: false, imageUrls: ["https://img.example/v.jpg"] });
      const missing = await lookup(w, { barcode: "NOPE" });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("BARCODE_NOT_FOUND");
    }));

  it("names the brand and does not find another company's barcode", () =>
    withFactoryWorld(async (w) => {
      const { variant } = await retailVariant(w, { brand: true });
      const [{ barcode }] = await w.q(`SELECT barcode FROM retail_product_variants WHERE id = $1`, [variant]);
      expect((await lookup(w, { barcode })).body.brand).toBe("Acme");
      const other = await otherCompany(w);
      await retailVariant(w, { companyId: other, barcode: `${w.tag}FOREIGN` });
      expect((await lookup(w, { barcode: `${w.tag}FOREIGN` })).status).toBe(404);
    }));
});

describe("retail receipts and movements", () => {
  it("refuses foreign references, defaults the unit cost and replays a key", () =>
    withFactoryWorld(async (w) => {
      const { variant } = await retailVariant(w);
      const other = await otherCompany(w);
      const far = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
        other,
        `${w.tag}FAR`,
      ]);
      const foreign = await retailVariant(w, { companyId: other });
      const base = { idempotencyKey: `${w.tag}-RCV1`, variantId: variant, locationId: w.locationId, quantity: 4 };
      expect((await w.agent.post("/api/pos/retail/receipts").send({ ...base, quantity: 0 })).status).toBe(400);
      expect((await w.agent.post("/api/pos/retail/receipts").send({ ...base, locationId: far })).status).toBe(400);
      expect(
        (await w.agent.post("/api/pos/retail/receipts").send({ ...base, variantId: foreign.variant })).status
      ).toBe(400);
      const first = await w.agent.post("/api/pos/retail/receipts").send(base);
      expect(first.status, first.text).toBe(201);
      expect(first.body).toMatchObject({ replayed: false, quantity: 4 });
      const replay = await w.agent.post("/api/pos/retail/receipts").send(base);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ replayed: true });
      const second = await w.agent.post("/api/pos/retail/receipts").send({
        ...base,
        idempotencyKey: `${w.tag}-RCV2`,
        quantity: 1,
        unitCost: 10,
        reference: "GRN-1",
        notes: "Top-up",
      });
      expect(second.body.quantity).toBe(5);
      const [inv] = await w.q(
        `SELECT quantity::numeric::text AS q, average_cost::numeric::text AS c FROM retail_variant_inventory WHERE variant_id = $1`,
        [variant]
      );
      expect(Number(inv.q)).toBe(5);
      expect(Number(inv.c)).toBeCloseTo((4 * 7.5 + 10) / 5, 4);

      expect((await w.agent.get("/api/retail/variants/abc/movements")).status).toBe(400);
      const movements = await w.agent.get(`/api/retail/variants/${variant}/movements`).query({ limit: "0" });
      expect(movements.body.map((m: { reason: string | null }) => m.reason)).toEqual(["Top-up", "Stock received"]);
      expect(movements.body[0]).toMatchObject({ quantityBefore: 4, quantityAfter: 5, counterpartLocation: null });
      const one = await w.agent.get(`/api/retail/variants/${variant}/movements`).query({ limit: "1" });
      expect(one.body).toHaveLength(1);
    }));

  it("names the counterpart location of a transfer movement", () =>
    withFactoryWorld(async (w) => {
      const { variant } = await retailVariant(w);
      const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
        w.companyId,
        `${w.tag}SHOP`,
      ]);
      await w.q(
        `INSERT INTO retail_stock_movements (company_id, variant_id, location_id, movement_type, quantity_delta,
           quantity_before, quantity_after, event_key, metadata, created_by)
         VALUES ($1, $2, $3, 'transfer_out', -1, 1, 0, $4, $5::jsonb, $7),
                ($1, $2, $3, 'adjust', 1, 0, 1, $6, '{}'::jsonb, $7)`,
        [
          w.companyId,
          variant,
          w.locationId,
          `${w.tag}E1`,
          JSON.stringify({ toLocationId: shop, reason: 7 }),
          `${w.tag}E2`,
          w.userId,
        ]
      );
      const res = await w.agent.get(`/api/retail/variants/${variant}/movements`);
      const byType = new Map(res.body.map((m: { movementType: string }) => [m.movementType, m]));
      expect(byType.get("transfer_out")).toMatchObject({ counterpartLocation: "Shop", reason: null });
      expect(byType.get("adjust")).toMatchObject({ counterpartLocation: null, reason: null });
    }));
});

describe("retail exchange refusals", () => {
  it("refuses a POS user's no-restock or on-account refund, a foreign location and an unknown sale", () =>
    withFactoryWorld(async (w) => {
      const { variant } = await retailVariant(w);
      const base = {
        idempotencyKey: `${w.tag}-EX${nextSeq()}`,
        saleId: 999999999,
        locationId: w.locationId,
        returnItems: [{ saleItemId: 1, quantity: 1 }],
        newItems: [{ variantId: variant, quantity: 1 }],
      };
      expect((await w.agent.post("/api/pos/retail/exchanges").send({ ...base, newItems: [] })).status).toBe(400);
      const pos = await w.agentFor("POS");
      const damaged = await pos
        .post("/api/pos/retail/exchanges")
        .send({ ...base, returnItems: [{ saleItemId: 1, quantity: 1, restock: false }] });
      expect(damaged.status).toBe(403);
      expect((await pos.post("/api/pos/retail/exchanges").send({ ...base, refundDestination: "account" })).status).toBe(
        403
      );
      const other = await otherCompany(w);
      const far = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
        other,
        `${w.tag}FAR`,
      ]);
      expect((await w.agent.post("/api/pos/retail/exchanges").send({ ...base, locationId: far })).status).toBe(400);
      const unknown = await w.agent.post("/api/pos/retail/exchanges").send(base);
      expect(unknown.status).toBe(400);
      const ops = await w.q(
        `SELECT 1 FROM retail_stock_operations WHERE company_id = $1 AND operation_type = 'exchange'`,
        [w.companyId]
      );
      expect(ops).toEqual([]);
    }));
});

describe("retail stock operations scope and exchange replays", () => {
  it("refuses a company that is not a retail company", () =>
    withFactoryWorld(async (w) => {
      for (const res of [
        await w.agent.get("/api/retail/stock/lookup").query({ barcode: "X" }),
        await w.agent.post("/api/pos/retail/receipts").send({}),
        await w.agent.post("/api/pos/retail/exchanges").send({}),
        await w.agent.get("/api/retail/variants/1/movements"),
      ]) {
        expect(res.status).toBe(409);
      }
    }));

  it("replays a recorded exchange from its stored metadata, old or new shape", () =>
    withFactoryWorld(async (w) => {
      const { variant } = await retailVariant(w);
      const record = (key: string, metadata: Record<string, unknown>) =>
        w.q(
          `INSERT INTO retail_stock_operations (company_id, operation_type, idempotency_key, reference_id, created_by, metadata)
           VALUES ($1, 'exchange', $2, '1', $3, $4::jsonb)`,
          [w.companyId, key, w.userId, JSON.stringify(metadata)]
        );
      const body = (key: string) => ({
        idempotencyKey: key,
        saleId: 1,
        locationId: w.locationId,
        returnItems: [{ saleItemId: 1, quantity: 1 }],
        newItems: [{ variantId: variant, quantity: 1 }],
      });
      await record(`${w.tag}-OLDEX`, { refundValue: "12.50" });
      const old = await w.agent.post("/api/pos/retail/exchanges").send(body(`${w.tag}-OLDEX`));
      expect(old.status).toBe(200);
      // Before the split was stored, the whole refund is treated as tender refunded.
      expect(old.body).toMatchObject({
        replayed: true,
        returnId: 0,
        newSaleId: 0,
        refundValue: 12.5,
        receivableReversed: 0,
        tenderRefund: 12.5,
        newSaleTotal: 0,
        balanceDue: -12.5,
      });
      await record(`${w.tag}-NEWEX`, {
        returnId: 4,
        newSaleId: 0,
        refundValue: 10,
        receivableReversed: 6,
        tenderRefund: 4,
      });
      const split = await w.agent.post("/api/pos/retail/exchanges").send(body(`${w.tag}-NEWEX`));
      expect(split.body).toMatchObject({
        returnId: 4,
        refundValue: 10,
        receivableReversed: 6,
        tenderRefund: 4,
        balanceDue: -4,
      });
    }));
});
