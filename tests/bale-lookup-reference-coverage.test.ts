/**
 * Bale lookup by reference (GET /api/lookup/reference/:referenceNumber) over
 * HTTP, one rolled-back transaction per test. Covers the first lookup stage:
 * the direct factory_bales path for bales without a label print (not found,
 * another company, ambiguous legacy references, product / worker / location
 * fallbacks, the effective status derived from the outbound order, booking
 * info visibility) and the label-print path's user and product resolution.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const lookup = (w: FactoryWorld, reference: string, agent = w.agent) =>
  agent.get(`/api/lookup/reference/${encodeURIComponent(reference)}`);

let seq = 0;

async function bale(
  w: FactoryWorld,
  reference: string,
  values: {
    status?: string;
    productId?: number | null;
    article?: string | null;
    worker?: string | null;
    finalizedBy?: number | null;
    location?: number | null;
    companyId?: number;
  } = {}
) {
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, article_code, product_name,
       weight_kg, status, worker_name, finalized_by, erp_location_id)
     VALUES ($1, $2, $3, $4, $5, 'Rags', 25, $6, $7, $8, $9) RETURNING id`,
    [
      values.companyId ?? w.companyId,
      `${w.tag}BC${++seq}`,
      reference,
      values.productId ?? null,
      values.article ?? null,
      values.status ?? "IN_STOCK",
      values.worker ?? null,
      values.finalizedBy ?? null,
      values.location === undefined ? w.locationId : values.location,
    ]
  );
}

async function order(w: FactoryWorld, status: string, reference: string, baleId: number, deleted = false) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Lookup Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${++seq}`]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, booking_info, deleted_at)
     VALUES ($1, $2, '2026-06-01', $3, $4, 'BK-123', $5) RETURNING id`,
    [w.companyId, customerId, status, w.locationId, deleted ? new Date() : null]
  );
  await w.one(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
     VALUES ($1, $2, $3, $4, 25, 30) RETURNING id`,
    [orderId, baleId, reference, w.locationId]
  );
  return orderId;
}

/** A factory catalogue product (the table factory_bales.product_id references), with an explicit id. */
async function factoryProduct(w: FactoryWorld, article: string, id: number) {
  return w.one(
    `INSERT INTO factory_bale_products (id, company_id, code, name, article_code) VALUES ($1, $2, $3, 'Factory product', $4) RETURNING id`,
    [id, w.companyId, `${w.tag}P${++seq}`, article]
  );
}

/** A legacy bale_products row, the table the lookup actually reads products from. */
async function catalogProduct(w: FactoryWorld, article: string, companyId = w.companyId, id?: number) {
  return w.one(
    `INSERT INTO bale_products (id, company_id, code, name, article_code)
     VALUES (COALESCE($1::int, nextval(pg_get_serial_sequence('bale_products', 'id'))::int), $2, $3, 'Catalog product', $4) RETURNING id`,
    [id ?? null, companyId, `${w.tag}P${++seq}`, article]
  );
}

/** An id far above any serial value, so both product tables can hold it without collision. */
const explicitId = () => 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

async function otherCompany(w: FactoryWorld) {
  return w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}X${++seq}`]
  );
}

describe("bale lookup without a label print", () => {
  it("returns 404 for unknown and other companies' references and 409 for ambiguous ones", async () => {
    await withFactoryWorld(async (w) => {
      expect((await lookup(w, `${w.tag}-NONE`)).status).toBe(404);
      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      await bale(w, `${w.tag}-FAR`, { companyId: otherCompany, location: null });
      const foreign = await lookup(w, `${w.tag}-FAR`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.message).toBe("Reference number not found");

      await bale(w, `${w.tag}-dup`);
      await bale(w, ` ${w.tag}-DUP`);
      const ambiguous = await lookup(w, `${w.tag}-dup`);
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.code).toBe("AMBIGUOUS_REFERENCE");
    });
  });

  // BUG (pinned): factory_bales.product_id references factory_bale_products, but the
  // lookup reads bale_products by that id with no company filter. The response
  // carries whichever bale_products row shares the number, here another company's.
  it("resolves product by id, worker by finalizer and location, and marks a finalized order sold", async () => {
    await withFactoryWorld(async (w) => {
      const productId = await factoryProduct(w, `${w.tag}A1`, explicitId());
      const foreign = await otherCompany(w);
      await catalogProduct(w, "FOREIGN-ART", foreign, productId);
      const workerId = await w.one(
        `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Amina Worker') RETURNING id`,
        [w.companyId]
      );
      const reference = `${w.tag}-SOLD`;
      const baleId = await bale(w, reference, { productId, finalizedBy: workerId });
      await order(w, "LOADING", reference, baleId, true);
      await order(w, "FINALIZED", reference, baleId);

      const res = await lookup(w, reference.toLowerCase());
      expect(res.status).toBe(200);
      expect(res.body.labelPrint).toBeNull();
      expect(res.body.product).toMatchObject({ id: productId, companyId: foreign, articleCode: "FOREIGN-ART" });
      expect(res.body.locationInfo).toMatchObject({ id: w.locationId, name: "Yard" });
      expect(res.body.baleInfo).toMatchObject({
        id: baleId,
        articleCode: "FOREIGN-ART",
        status: "SOLD",
        isInLoadingOrder: false,
        workerName: "Amina Worker",
      });
      expect(res.body.loadedOnOrder).toMatchObject({
        status: "FINALIZED",
        bookingInfo: "BK-123",
        canViewBookingInfo: true,
      });
      expect(Array.isArray(res.body.auditHistory)).toBe(true);
    });
  });

  it("uses the article-code product, stored worker name and a loading order", async () => {
    await withFactoryWorld(async (w) => {
      const productId = await catalogProduct(w, `${w.tag}A2`);
      const reference = `${w.tag}-LOAD`;
      const baleId = await bale(w, reference, { article: `${w.tag}A2`, worker: "Stored Name", location: null });
      await order(w, "LOADING", reference, baleId);
      const res = await lookup(w, reference);
      expect(res.body.product).toMatchObject({ id: productId });
      expect(res.body.locationInfo).toBeNull();
      expect(res.body.baleInfo).toMatchObject({ status: "LOADING", isInLoadingOrder: true, workerName: "Stored Name" });
    });
  });

  it.each([
    ["VERIFIED", "IN_STOCK", "RESERVED_FOR_ORDER"],
    ["CANCELLED", "IN_STOCK", "IN_STOCK"],
    ["FINALIZED", "RESERVED_FOR_ORDER", "RESERVED_FOR_ORDER"],
  ])("an order in %s on a %s bale shows %s", async (orderStatus, baleStatus, effective) => {
    await withFactoryWorld(async (w) => {
      const reference = `${w.tag}-EFF`;
      const baleId = await bale(w, reference, { status: baleStatus, article: "UNKNOWN-ART" });
      await order(w, orderStatus, reference, baleId);
      const res = await lookup(w, reference);
      expect(res.status).toBe(200);
      expect(res.body.product).toBeNull();
      expect(res.body.baleInfo.status).toBe(effective);
      expect(res.body.baleInfo.articleCode).toBe("UNKNOWN-ART");
    });
  });

  it("shows a bale with no order, product or worker, and hides booking info from other roles", async () => {
    await withFactoryWorld(async (w) => {
      const reference = `${w.tag}-BARE`;
      await bale(w, reference);
      const bare = await lookup(w, reference);
      expect(bare.body).toMatchObject({ product: null, loadedOnOrder: null });
      expect(bare.body.baleInfo).toMatchObject({ status: "IN_STOCK", workerName: null, articleCode: null });

      const booked = `${w.tag}-BOOK`;
      const baleId = await bale(w, booked);
      await order(w, "SOLD", booked, baleId);
      const manager = await w.agentFor("Manager");
      const res = await lookup(w, booked, manager);
      expect(res.status).toBe(200);
      expect(res.body.loadedOnOrder).toMatchObject({ bookingInfo: null, canViewBookingInfo: false });
    });
  });
});

describe("bale lookup with a label print", () => {
  it("names the printing and scanning users and resolves the product", async () => {
    await withFactoryWorld(async (w) => {
      const productId = await catalogProduct(w, `${w.tag}LP`);
      const reference = `${w.tag}-LABEL`;
      await w.q(
        `INSERT INTO bale_label_prints (company_id, reference_number, article_code, product_id, approx_weight_kg,
           printed_by_user_id, scanned_by_user_id)
         VALUES ($1, $2, $3, $4, 25, $5, 'no-such-user')`,
        [w.companyId, reference, `${w.tag}LP`, productId, w.userId]
      );
      const res = await lookup(w, reference);
      expect(res.status).toBe(200);
      expect(res.body.labelPrint).toMatchObject({
        referenceNumber: reference,
        printedByName: w.username,
        scannedByName: null,
      });
      expect(res.body.product).toMatchObject({ id: productId });

      const articleRef = `${w.tag}-LABEL2`;
      await w.q(
        `INSERT INTO bale_label_prints (company_id, reference_number, article_code, approx_weight_kg) VALUES ($1, $2, $3, 25)`,
        [w.companyId, articleRef, `${w.tag}LP`]
      );
      const byArticle = await lookup(w, articleRef);
      expect(byArticle.status).toBe(200);
      expect(byArticle.body.product).toMatchObject({ id: productId });
    });
  });
});
