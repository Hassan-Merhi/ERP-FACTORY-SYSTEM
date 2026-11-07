/**
 * Destination pricing must never mutate an existing proforma other than the
 * one the user explicitly edits. Uses a disposable factory/company fixture.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { pool } from "../server/db";
import { ensureProformaDestinationPricingSchema } from "../server/services/factory/ensureProformaDestinationPricingSchema";
import { registerFactoryCustomerProformaCrudRoutes } from "../server/routes/factory/customer-proformas/proformas";
import { registerFactoryCustomerPriceListRoutes } from "../server/routes/factory/customer-proformas/price-lists";
import { registerFactoryCustomerProformaLineRoutes } from "../server/routes/factory/customer-proformas/lines";
import { createProformaLoadingFixture, createRouteHarness } from "./helpers/proformaLoadingFixture";

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip;

databaseDescribe("destination-scoped proforma prices", () => {
  const call = createRouteHarness(
    registerFactoryCustomerProformaCrudRoutes,
    registerFactoryCustomerPriceListRoutes,
    registerFactoryCustomerProformaLineRoutes
  );
  let fixture: Awaited<ReturnType<typeof createProformaLoadingFixture>>;
  let firstId = 0;
  let secondId = 0;
  let firstLineId = 0;
  let secondLineId = 0;
  const articleCode = "PROFORMA-DEST-TEST";

  async function readLinePrice(id: number) {
    const { rows } = await pool.query<{ price_per_bale: string }>(
      "SELECT price_per_bale FROM customer_proforma_lines WHERE id = $1",
      [id]
    );
    return Number(rows[0].price_per_bale);
  }
  async function agreedPrice(destination: string) {
    const response = await call("GET", "/api/factory/customer-price-lists/:customerId", fixture.companyId, {
      params: { customerId: String(fixture.customerId) },
      query: { destination },
    });
    expect(response.statusCode).toBe(200);
    return response.body.find((line: { article_code: string }) => line.article_code === articleCode)?.price_per_bale;
  }

  beforeAll(async () => {
    await ensureProformaDestinationPricingSchema(pool);
    fixture = await createProformaLoadingFixture("PDI");
    firstId = await fixture.proforma([{ code: articleCode, qty: 2 }]);
    secondId = await fixture.proforma([{ code: articleCode, qty: 3 }]);
    const { rows } = await pool.query<{ id: number; proforma_id: number }>(
      "SELECT id, proforma_id FROM customer_proforma_lines WHERE proforma_id = ANY($1::integer[])",
      [[firstId, secondId]]
    );
    firstLineId = rows.find((row) => row.proforma_id === firstId)!.id;
    secondLineId = rows.find((row) => row.proforma_id === secondId)!.id;
  });
  afterAll(async () => {
    if (fixture) {
      await pool.query("DELETE FROM customer_destination_price_lists WHERE company_id = $1", [fixture.companyId]);
    }
    await fixture?.cleanup();
  });

  it("requires linking an old proforma before saving its agreed prices", async () => {
    const response = await call(
      "POST",
      "/api/factory/customer-price-lists/:customerId/from-proforma/:proformaId",
      fixture.companyId,
      {
        params: { customerId: String(fixture.customerId), proformaId: String(firstId) },
      }
    );
    expect(response.statusCode).toBe(400);
  });

  it("links old proformas to different destinations without changing either price", async () => {
    for (const [id, destination] of [
      [firstId, "LUBUMBASHI"],
      [secondId, "MALI"],
    ] as const) {
      const response = await call("PUT", "/api/factory/customer-proformas/:id", fixture.companyId, {
        params: { id: String(id) },
        body: { destination },
      });
      expect(response.statusCode).toBe(200);
    }
    const { rows } = await pool.query<{ id: number; destination: string }>(
      "SELECT id, destination FROM customer_proformas WHERE id = ANY($1::integer[])",
      [[firstId, secondId]]
    );
    expect(rows.find((row) => row.id === firstId)?.destination).toBe("L'SHI");
    expect(rows.find((row) => row.id === secondId)?.destination).toBe("MALI");
    expect(await readLinePrice(firstLineId)).toBe(10);
    expect(await readLinePrice(secondLineId)).toBe(10);
  });

  it("changing one proforma price never changes its sibling's price or agreed lists", async () => {
    const response = await call("PUT", "/api/factory/customer-proforma-lines/:id", fixture.companyId, {
      params: { id: String(firstLineId) },
      body: { pricePerBale: "25" },
    });
    expect(response.statusCode).toBe(200);
    expect(await readLinePrice(firstLineId)).toBe(25);
    expect(await readLinePrice(secondLineId)).toBe(10);
    expect(await agreedPrice("L'SHI")).toBeUndefined();
    expect(await agreedPrice("MALI")).toBeUndefined();
  });

  it("saving destination agreed prices updates only that destination, not document lines", async () => {
    const a = await call(
      "POST",
      "/api/factory/customer-price-lists/:customerId/from-proforma/:proformaId",
      fixture.companyId,
      {
        params: { customerId: String(fixture.customerId), proformaId: String(firstId) },
      }
    );
    expect(a.statusCode).toBe(200);
    expect(a.body.backfilled).toBe(0);
    const b = await call(
      "POST",
      "/api/factory/customer-price-lists/:customerId/from-proforma/:proformaId",
      fixture.companyId,
      {
        params: { customerId: String(fixture.customerId), proformaId: String(secondId) },
      }
    );
    expect(b.statusCode).toBe(200);
    expect(Number(await agreedPrice("LUBUMBASHI"))).toBe(25);
    expect(Number(await agreedPrice("MALI"))).toBe(10);
    expect(await readLinePrice(firstLineId)).toBe(25);
    expect(await readLinePrice(secondLineId)).toBe(10);
  });

  it("lists destinations and deletes only the selected destination's price", async () => {
    const params = { customerId: String(fixture.customerId) };
    const list = await call("GET", "/api/factory/customer-price-lists/:customerId/destinations", fixture.companyId, { params });
    expect(list.statusCode).toBe(200);
    expect(list.body).toEqual(expect.arrayContaining(["L'SHI", "MALI"]));

    const legacy = await call("PUT", "/api/factory/customer-price-lists/:customerId", fixture.companyId, {
      params,
      body: [{ articleCode, pricePerBale: 99 }],
    });
    expect(legacy.statusCode).toBe(200);

    const deleted = await call("DELETE", "/api/factory/customer-price-lists/:customerId/:articleCode", fixture.companyId, {
      params: { ...params, articleCode },
      query: { destination: "MALI" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await agreedPrice("MALI")).toBeUndefined();
    expect(Number(await agreedPrice("L'SHI"))).toBe(25);
    const old = await call("GET", "/api/factory/customer-price-lists/:customerId", fixture.companyId, { params });
    expect(Number(old.body.find((row: { article_code: string }) => row.article_code === articleCode)?.price_per_bale)).toBe(99);
    expect(await readLinePrice(secondLineId)).toBe(10);

    const restored = await call("PUT", "/api/factory/customer-price-lists/:customerId", fixture.companyId, {
      params,
      query: { destination: "MALI" },
      body: [{ articleCode, pricePerBale: 10 }],
    });
    expect(restored.statusCode).toBe(200);
    expect(Number(await agreedPrice("MALI"))).toBe(10);
  });

  it("changing an old proforma's destination does not reprice it", async () => {
    const response = await call("PUT", "/api/factory/customer-proformas/:id", fixture.companyId, {
      params: { id: String(secondId) },
      body: { destination: "L'SHI" },
    });
    expect(response.statusCode).toBe(200);
    expect(await readLinePrice(secondLineId)).toBe(10);
    expect(Number(await agreedPrice("L'SHI"))).toBe(25);
  });
});
