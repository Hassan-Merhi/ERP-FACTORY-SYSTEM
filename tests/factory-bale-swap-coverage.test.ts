/**
 * Bale order-info and swap routes
 * (server/routes/factory/customer-orders/bale-scanning/swap.ts): id and
 * body validation, bale state refusals, another company's bales, the
 * no-order-link path, and a successful swap that repoints the order line
 * before either bale's status changes, logs the removal and keeps the
 * price. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { loadingWithBales } from "./helpers/dispatchFlowFixture";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const SWAP = "/api/factory/bales/swap";

const stockBale = (w: FactoryWorld, reference: string, status = "IN_STOCK", companyId = w.companyId) =>
  w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, cost_per_kg, total_cost, status, erp_location_id)
     VALUES ($1, $2, $2, 'ART-B', 'Cotton', 30, 0.2, 6, $3, $4) RETURNING id`,
    [companyId, reference, status, w.locationId]
  );

describe("GET /api/factory/bales/:id/order-info", () => {
  it("returns the order with its bale count, null for an unlinked or foreign bale, and 400 for a bad id", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10", "12"]);
      expect((await w.agent.get("/api/factory/bales/abc/order-info")).status).toBe(400);
      const info = await w.agent.get(`/api/factory/bales/${bales[0].baleId}/order-info`);
      expect(info.status).toBe(200);
      expect(info.body).toMatchObject({ id: orderId, customerName: "Truck Customer", totalBalesInOrder: 2 });
      const loose = await stockBale(w, `${w.tag}-LOOSE`);
      expect((await w.agent.get(`/api/factory/bales/${loose}/order-info`)).body).toBeNull();

      // Another company's bale linked to that company's order reads as null.
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreignCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [other, `${w.tag}FC`]
      );
      const foreignOrder = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, foreignCustomer]
      );
      const foreignBale = await stockBale(w, `${w.tag}-FB`, "RESERVED_FOR_ORDER", other);
      const foreignLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'F') RETURNING id`,
        [other, `${w.tag}FL`]
      );
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 30, 9)`,
        [foreignOrder, foreignBale, `${w.tag}-FB`, foreignLocation]
      );
      expect((await w.agent.get(`/api/factory/bales/${foreignBale}/order-info`)).body).toBeNull();
    });
  });
});

describe("POST /api/factory/bales/swap", () => {
  it("validates the references and both bales' states", async () => {
    await withFactoryWorld(async (w) => {
      const { bales } = await loadingWithBales(w, ["10"]);
      await stockBale(w, `${w.tag}-SOLDOUT`, "DISPATCHED");
      await stockBale(w, `${w.tag}-PENDING`, "PENDING_PRESSING");
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      await stockBale(w, `${w.tag}-FOREIGN`, "IN_STOCK", other);
      const swap = (currentBaleRef: unknown, replacementBaleRef: unknown) =>
        w.agent.post(SWAP).send({ currentBaleRef, replacementBaleRef });

      expect((await swap(bales[0].reference, "")).body.message).toMatch(/are required/);
      expect((await swap(bales[0].reference, ` ${bales[0].reference.toLowerCase()} `)).body.message).toMatch(
        /must be different/
      );
      expect((await swap("NOPE", `${w.tag}-PENDING`)).status).toBe(404);
      const notLoaded = await swap(`${w.tag}-PENDING`, `${w.tag}-SOLDOUT`);
      expect(notLoaded.body.message).toMatch(/must be loaded in an order/);
      const foreign = await swap(bales[0].reference, `${w.tag}-FOREIGN`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.message).toMatch(/Replacement bale/);
      const notInStock = await swap(bales[0].reference, `${w.tag}-SOLDOUT`);
      expect(notInStock.body.message).toMatch(/must be IN_STOCK/);
      const [line] = await w.q(`SELECT bale_id FROM customer_order_bales WHERE id = $1`, [bales[0].orderBaleId]);
      expect(line.bale_id).toBe(bales[0].baleId);
    });
  });

  it("returns a reserved bale without an order link to stock and reports it", async () => {
    await withFactoryWorld(async (w) => {
      const orphan = await stockBale(w, `${w.tag}-ORPHAN`, "RESERVED");
      await stockBale(w, `${w.tag}-REPL`);
      const res = await w.agent
        .post(SWAP)
        .send({ currentBaleRef: `${w.tag}-ORPHAN`, replacementBaleRef: `${w.tag}-REPL` });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("No order link found for the current bale");
      const [row] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [orphan]);
      // The refusal still writes: the orphan bale is flipped back to stock.
      expect(row.status).toBe("IN_STOCK");
    });
  });

  it("swaps a loaded bale for an in-stock one, keeping the price and logging the removal", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["15"]);
      const replacement = await stockBale(w, `${w.tag}-NEW`);
      const res = await w.agent
        .post(SWAP)
        .send({ currentBaleRef: bales[0].reference, replacementBaleRef: `${w.tag}-NEW` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orderId, replacedRef: bales[0].reference, replacementRef: `${w.tag}-NEW` });

      const [line] = await w.q(
        `SELECT bale_id, bale_reference, weight::text, price_used::text, article_code FROM customer_order_bales WHERE id = $1`,
        [bales[0].orderBaleId]
      );
      expect(line).toMatchObject({ bale_id: replacement, bale_reference: `${w.tag}-NEW`, article_code: "ART-B" });
      expect(Number(line.price_used)).toBe(15);
      const statuses = await w.q(`SELECT id, status FROM factory_bales WHERE id = ANY($1::int[]) ORDER BY id`, [
        [bales[0].baleId, replacement],
      ]);
      expect(statuses).toEqual([
        { id: bales[0].baleId, status: "IN_STOCK" },
        { id: replacement, status: "RESERVED_FOR_ORDER" },
      ]);
      const removals = await w.q(
        `SELECT reference_number, removed_by_username FROM customer_order_bale_removals WHERE order_id = $1`,
        [orderId]
      );
      expect(removals).toEqual([
        { reference_number: bales[0].reference, removed_by_username: `${w.username} (swapped → ${w.tag}-NEW)` },
      ]);
    });
  });

  it("refuses a bale linked to another company's order and swaps bales with no article or product", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreignCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [other, `${w.tag}FC`]
      );
      const foreignOrder = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, foreignCustomer]
      );
      const mine = await stockBale(w, `${w.tag}-MINE`, "SOLD");
      await stockBale(w, `${w.tag}-SPARE`);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 30, 9)`,
        [foreignOrder, mine, `${w.tag}-MINE`, w.locationId]
      );
      const refused = await w.agent
        .post(SWAP)
        .send({ currentBaleRef: `${w.tag}-MINE`, replacementBaleRef: `${w.tag}-SPARE` });
      expect(refused.status).toBe(404);
      expect(refused.body.message).toBe("Associated order not found");

      const { orderId, bales } = await loadingWithBales(w, ["7"]);
      await w.q(`UPDATE factory_bales SET article_code = NULL, product_name = NULL WHERE id = $1`, [bales[0].baleId]);
      const bare = await w.one(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status, erp_location_id)
         VALUES ($1, $2, $2, 20, 0.1, 2, 'IN_STOCK', $3) RETURNING id`,
        [w.companyId, `${w.tag}-BARE`, w.locationId]
      );
      const ok = await w.agent
        .post(SWAP)
        .send({ currentBaleRef: bales[0].reference, replacementBaleRef: `${w.tag}-BARE` });
      expect(ok.status).toBe(200);
      const [line] = await w.q(
        `SELECT bale_id, article_code, bale_name FROM customer_order_bales WHERE order_id = $1`,
        [orderId]
      );
      expect(line).toEqual({ bale_id: bare, article_code: null, bale_name: null });
    });
  });
});
