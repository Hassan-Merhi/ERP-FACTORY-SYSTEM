/**
 * Bale Explorer "return to stock" (POST /api/factory/bales/:id/release-from-loading),
 * against a real PostgreSQL schema. The route detaches one bale from an OPEN
 * loading: the scan row goes, the bale is IN_STOCK, a removal is recorded and
 * the order totals are recomputed. A verified loading, a bale on no loading
 * and a non-admin caller are refused without changing anything.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { registerOrderBaleRemovalRoutes } from "../server/routes/factory/customer-orders/bale-scanning/remove";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type Handler = (req: any, res: any, next: () => void) => unknown;
const routes = new Map<string, Handler[]>();
const app: any = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: string, ...handlers: Handler[]) =>
        routes.set(`${method.toUpperCase()} ${path}`, handlers),
  }
);
registerOrderBaleRemovalRoutes(app);

async function release(companyId: number, baleId: number | string, role = "Admin") {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  const req = {
    params: { id: String(baleId) },
    session: { factoryCompanyId: companyId, username: "tester" },
    user: { id: "release-test-user", username: "tester", role },
  };
  for (const handler of routes.get("POST /api/factory/bales/:id/release-from-loading")!) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res as { statusCode: number; body: any };
}

databaseDescribe("POST /api/factory/bales/:id/release-from-loading", () => {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  let companyId = 0;
  const ids: Record<string, number> = {};

  const one = async (query: ReturnType<typeof sql>) => {
    const result: any = await db.execute(query);
    return Number(result.rows[0]?.id);
  };
  const bale = (code: string) =>
    one(sql`INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, weight_kg, status)
      VALUES (${companyId}, ${code + suffix}, ${code + suffix}, ${ids.product}, 50, 'IN_STOCK') RETURNING id`);
  const order = (status: string) =>
    one(sql`INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total, total_qty_bales)
      VALUES (${companyId}, ${ids.customer}, '2026-10-20', ${status}, 0, 0) RETURNING id`);
  const scan = (orderId: number, baleId: number, price: number) =>
    db.execute(sql`INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, scanned_at)
      VALUES (${orderId}, ${baleId}, 'B', ${ids.location}, 50, ${price}, now())`);
  const state = async (baleId: number, orderId: number) => {
    const result: any = await db.execute(sql`
      SELECT (SELECT status FROM factory_bales WHERE id = ${baleId}) AS bale_status,
             (SELECT COUNT(*)::int FROM customer_order_bales WHERE bale_id = ${baleId}) AS links,
             (SELECT COUNT(*)::int FROM customer_order_bale_removals WHERE bale_id = ${baleId} AND order_id = ${orderId}) AS removals,
             (SELECT total_qty_bales FROM customer_orders WHERE id = ${orderId}) AS qty,
             (SELECT grand_total::numeric::float FROM customer_orders WHERE id = ${orderId}) AS total`);
    return result.rows[0];
  };

  beforeAll(async () => {
    companyId = await one(sql`INSERT INTO companies (code, name, company_type)
      VALUES (${"REL" + suffix}, ${"Release " + suffix}, 'factory') RETURNING id`);
    ids.product =
      await one(sql`INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
      VALUES (${companyId}, ${"P" + suffix}, 'Mixed bale', 40, 60) RETURNING id`);
    ids.customer = await one(sql`INSERT INTO customers (company_id, code, legal_name)
      VALUES (${companyId}, ${"C" + suffix}, 'Release Customer') RETURNING id`);
    ids.location = await one(
      sql`INSERT INTO locations (company_id, code, name) VALUES (${companyId}, ${"L" + suffix}, 'Warehouse') RETURNING id`
    );
  }, 60_000);

  afterAll(async () => {
    if (!companyId) return;
    const orders = sql`(SELECT id FROM customer_orders WHERE company_id = ${companyId})`;
    await db.execute(sql`DELETE FROM customer_order_bale_removals WHERE order_id IN ${orders}`);
    await db.execute(sql`DELETE FROM customer_order_bales WHERE order_id IN ${orders}`);
    for (const table of ["customer_orders", "factory_bales", "factory_bale_products", "customers", "locations"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE company_id = ${companyId}`);
    }
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
  });

  it("returns a bale on an open loading to stock and recomputes the loading", async () => {
    const loading = await order("LOADING");
    const released = await bale("R1-");
    const kept = await bale("R2-");
    await scan(loading, released, 60);
    await scan(loading, kept, 70);

    const res = await release(companyId, released);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orderId: loading, totalQtyBales: 1 });
    expect(await state(released, loading)).toMatchObject({
      bale_status: "IN_STOCK",
      links: 0,
      removals: 1,
      qty: 1,
      total: 70,
    });
    expect(await state(kept, loading)).toMatchObject({ links: 1 });
  });

  it("refuses a verified loading, a bale on no loading and a non-admin caller", async () => {
    const verified = await order("VERIFIED");
    const onVerified = await bale("V1-");
    await scan(verified, onVerified, 80);
    const loose = await bale("F1-");
    const open = await order("LOADING");
    const onOpen = await bale("O1-");
    await scan(open, onOpen, 90);

    expect((await release(companyId, onVerified)).statusCode).toBe(409);
    expect((await release(companyId, loose)).statusCode).toBe(409);
    expect((await release(companyId, onOpen, "Manager")).statusCode).toBe(403);
    expect((await release(companyId, "x")).statusCode).toBe(400);
    expect((await release(companyId, 2_000_000_000)).statusCode).toBe(404);

    expect(await state(onVerified, verified)).toMatchObject({ links: 1, removals: 0 });
    expect(await state(onOpen, open)).toMatchObject({ links: 1, removals: 0 });
  });
});
