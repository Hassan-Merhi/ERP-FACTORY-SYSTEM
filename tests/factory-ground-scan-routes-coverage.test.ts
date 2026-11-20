/**
 * Ground Scan routes (server/routes/factory/factoryGroundScanRoutes.ts) over
 * HTTP in one rolled-back factory company per test: single scans with and
 * without a location, the missing-reference, non-bale-product and duplicate
 * refusals, bulk scans (empty, blank, excluded, alias fields, duplicate), the
 * live status read, and the scoped deletes, including another company's scan id
 * and location id.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/ground-scan-items";

const scans = (w: FactoryWorld) =>
  w.q<{ reference_number: string; location_id: number | null }>(
    `SELECT reference_number, location_id FROM factory_ground_scan_items WHERE company_id = $1 ORDER BY reference_number`,
    [w.companyId]
  );

async function seed(w: FactoryWorld) {
  const excludedProduct = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2, 'Strap roll') RETURNING id`,
    [w.companyId, `${w.tag}NB`]
  );
  await w.q(
    `INSERT INTO factory_settings (company_id, extra_settings) VALUES ($1, $2::jsonb)
     ON CONFLICT (company_id) DO UPDATE SET extra_settings = EXCLUDED.extra_settings`,
    [w.companyId, JSON.stringify({ nonBalePriorityProductIds: [excludedProduct] })]
  );
  const bale = (ref: string, status: string, productId: number | null) =>
    w.one(
      `INSERT INTO factory_bales (company_id, reference_number, bale_code, weight_kg, status, product_id, stock_entry_date)
       VALUES ($1, $2, $2, 30, $3, $4, '2026-03-01') RETURNING id`,
      [w.companyId, ref, status, productId]
    );
  await bale(`${w.tag}-STRAP`, "IN_STOCK", excludedProduct);
  await bale(`${w.tag}-LIVE`, "REMOVED", null);
  return { excludedRef: `${w.tag}-STRAP`, liveRef: `${w.tag}-LIVE` };
}

describe("ground scan single and bulk scans", () => {
  it("scans with and without a location and refuses missing, excluded and duplicate references", () =>
    withFactoryWorld(async (w) => {
      const { excludedRef, liveRef } = await seed(w);
      expect((await w.agent.post(BASE).send({})).status).toBe(400);
      const excluded = await w.agent.post(BASE).send({ referenceNumber: excludedRef.toLowerCase() });
      expect(excluded.status).toBe(422);

      const unlocated = await w.agent.post(BASE).send({ referenceNumber: ` ${liveRef.toLowerCase()} ` });
      expect(unlocated.status).toBe(201);
      expect(unlocated.body).toMatchObject({
        reference_number: liveRef,
        location_id: null,
        article_code: null,
        is_in_loading_order: false,
      });
      expect((await w.agent.post(BASE).send({ referenceNumber: liveRef, locationId: "all" })).status).toBe(409);

      const located = await w.agent.post(BASE).send({
        referenceNumber: "label-only",
        locationId: String(w.locationId),
        articleCode: "A1",
        productName: "Label",
        weightKg: "12.5",
        status: "IN_STOCK",
        isInLoadingOrder: true,
      });
      expect(located.status).toBe(201);
      expect(located.body).toMatchObject({ location_id: w.locationId, article_code: "A1", is_in_loading_order: true });
      const dup = await w.agent.post(BASE).send({ referenceNumber: "LABEL-ONLY", locationId: String(w.locationId) });
      expect(dup.status).toBe(409);

      const unlocatedRead = await w.agent.get(BASE);
      expect(unlocatedRead.body).toHaveLength(1);
      // The live bale status replaces the scan snapshot.
      expect(unlocatedRead.body[0]).toMatchObject({ reference_number: liveRef, status: "REMOVED" });
      const locatedRead = await w.agent.get(BASE).query({ locationId: String(w.locationId) });
      expect(locatedRead.body).toHaveLength(1);
      expect(locatedRead.body[0]).toMatchObject({ reference_number: "LABEL-ONLY", status: "IN_STOCK" });
      expect((await w.agent.get(BASE).query({ locationId: "all" })).body).toHaveLength(1);
    }));

  it("bulk-inserts with alias fields and skips empty, blank and excluded items", () =>
    withFactoryWorld(async (w) => {
      const { excludedRef } = await seed(w);
      expect((await w.agent.post(`${BASE}/bulk`).send({ items: [] })).body).toEqual({ inserted: 0, skipped: 0 });
      expect((await w.agent.post(`${BASE}/bulk`).send({ items: "x" })).body).toEqual({ inserted: 0, skipped: 0 });
      const res = await w.agent.post(`${BASE}/bulk`).send({
        locationId: String(w.locationId),
        items: [
          {
            refCode: "b-1",
            articleCode: "A",
            productName: "P",
            weightKg: 10,
            status: "IN_STOCK",
            isInLoadingOrder: true,
          },
          {
            reference_number: "b-2",
            article_code: "B",
            product_name: "Q",
            weight_kg: 11,
            scannedAt: "2026-03-01T10:00:00Z",
          },
          { refCode: "   " },
          {},
          { refCode: excludedRef },
          // The unique (company, location, reference) index swallows the
          // duplicate, yet the route still counts it as inserted.
          { refCode: "B-1" },
        ],
      });
      expect(res.body).toEqual({ inserted: 3, skipped: 3 });
      expect(await scans(w)).toEqual([
        { reference_number: "B-1", location_id: w.locationId },
        { reference_number: "B-2", location_id: w.locationId },
      ]);
      const [b2] = await w.q(
        `SELECT article_code, product_name, weight_kg::text AS weight, scanned_at::text AS at
           FROM factory_ground_scan_items WHERE company_id = $1 AND reference_number = 'B-2'`,
        [w.companyId]
      );
      expect(b2).toMatchObject({ article_code: "B", product_name: "Q", weight: "11.000" });
      expect(b2.at).toContain("2026-03-01");

      const unlocated = await w.agent.post(`${BASE}/bulk`).send({ items: [{ refCode: "c-1" }] });
      expect(unlocated.body).toEqual({ inserted: 1, skipped: 0 });
    }));

  it("counts an item the database rejects as skipped", () =>
    withFactoryWorld(async (w) => {
      // The failed insert aborts the rolled-back transaction, so it is the last request.
      const res = await w.agent.post(`${BASE}/bulk`).send({ items: [{ refCode: "bad-weight", weightKg: "heavy" }] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ inserted: 0, skipped: 1 });
    }));
});

describe("ground scan deletes", () => {
  it("deletes one scan, a location's scans and unlocated scans, never another company's", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreignScan = await w.one(
        `INSERT INTO factory_ground_scan_items (company_id, location_id, reference_number) VALUES ($1, NULL, 'FOREIGN') RETURNING id`,
        [other]
      );
      await w.agent
        .post(`${BASE}/bulk`)
        .send({ locationId: String(w.locationId), items: [{ refCode: "L-1" }, { refCode: "L-2" }] });
      await w.agent.post(`${BASE}/bulk`).send({ items: [{ refCode: "U-1" }] });

      expect((await w.agent.delete(`${BASE}/abc`)).status).toBe(400);
      expect((await w.agent.delete(`${BASE}/${foreignScan}`)).body).toEqual({ success: true });
      const [still] = await w.q(`SELECT count(*)::int AS n FROM factory_ground_scan_items WHERE id = $1`, [
        foreignScan,
      ]);
      expect(still.n).toBe(1);

      const [l1] = await w.q(
        `SELECT id FROM factory_ground_scan_items WHERE company_id = $1 AND reference_number = 'L-1'`,
        [w.companyId]
      );
      expect((await w.agent.delete(`${BASE}/${l1.id}`)).status).toBe(200);
      expect((await scans(w)).map((s) => s.reference_number)).toEqual(["L-2", "U-1"]);

      expect((await w.agent.delete(BASE).query({ locationId: String(w.locationId) })).status).toBe(200);
      expect((await scans(w)).map((s) => s.reference_number)).toEqual(["U-1"]);
      expect((await w.agent.delete(BASE).query({ locationId: "all" })).status).toBe(200);
      expect(await scans(w)).toEqual([]);
      const [foreignLeft] = await w.q(
        `SELECT count(*)::int AS n FROM factory_ground_scan_items WHERE company_id = $1`,
        [other]
      );
      expect(foreignLeft.n).toBe(1);
    }));

  it("accepts another company's location id on a scan (pinned: no location ownership check)", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}Q`]
      );
      const foreignLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Foreign yard') RETURNING id`,
        [other, `${w.tag}QL`]
      );
      const res = await w.agent.post(BASE).send({ referenceNumber: "X-1", locationId: String(foreignLocation) });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ company_id: String(w.companyId), location_id: foreignLocation });
    }));
});
