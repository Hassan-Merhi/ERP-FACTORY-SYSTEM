/**
 * Correlated subqueries in single-table select lists must bind to the outer
 * row. Drizzle renders `${table.id}` bare ("id") in such a select list, which
 * inside `SELECT ... FROM inner_table` resolves to the inner table's own id.
 * Each case seeds rows whose inner ids differ from the outer ids and checks the
 * aggregate through the real HTTP route, in one rolled-back transaction:
 * bale transfer item counts, factory worker pending advances, the emptied
 * loading's remaining weight and the customer statement's invoice weights.
 */
import { describe, expect, it } from "vitest";

import { loadingWithBales } from "./helpers/dispatchFlowFixture";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

/** An id far above any serial value, so an explicit row cannot collide with a sequence. */
const explicitId = () => 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

const bale = (w: FactoryWorld, reference: string) =>
  w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status, erp_location_id)
     VALUES ($1, $2, $2, 'ART-W', 'Rags', 25, 'IN_STOCK', $3) RETURNING id`,
    [w.companyId, reference, w.locationId]
  );

async function transfer(w: FactoryWorld, items: number) {
  const id = await w.one(
    `INSERT INTO bale_transfers (company_id, source_location_id, destination_location_id, transfer_date, created_by)
     VALUES ($1, $2, $2, '2026-06-01', $3) RETURNING id`,
    [w.companyId, w.locationId, w.userId]
  );
  for (let i = 0; i < items; i++) {
    await w.q(
      `INSERT INTO bale_transfer_items (transfer_id, production_bale_id, weight_kg, cost_per_kg, total_cost)
       VALUES ($1, $2, 25, 0.1, 2.5)`,
      [id, 900_000 + i]
    );
  }
  return id;
}

describe("select-list subqueries correlate on the outer row", () => {
  it("counts each bale transfer's own items", async () => {
    await withFactoryWorld(async (w) => {
      const three = await transfer(w, 3);
      const one = await transfer(w, 1);
      const none = await transfer(w, 0);
      const res = await w.agent.get("/api/bale-transfers");
      expect(res.status).toBe(200);
      const counts = new Map(res.body.map((t: { id: number; itemCount: number }) => [t.id, t.itemCount]));
      expect(counts.get(three)).toBe(3);
      expect(counts.get(one)).toBe(1);
      expect(counts.get(none)).toBe(0);
    });
  });

  it("sums each factory worker's own open advances", async () => {
    await withFactoryWorld(async (w) => {
      const worker = (name: string) =>
        w.one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [w.companyId, name]);
      const advance = (workerId: number, remaining: string) =>
        w.q(
          `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, remaining_balance)
           VALUES ($1, $2, '2026-06-01', 100, $3)`,
          [w.companyId, workerId, remaining]
        );
      const amina = await worker(`${w.tag} Amina`);
      const bakari = await worker(`${w.tag} Bakari`);
      const chiku = await worker(`${w.tag} Chiku`);
      await advance(amina, "40");
      await advance(amina, "15.5");
      await advance(bakari, "70");
      await advance(chiku, "0");

      const res = await w.agent.get("/api/factory/workers");
      expect(res.status).toBe(200);
      const balances = new Map(
        res.body.map((r: { id: number; pendingAdvanceBalance: string }) => [r.id, Number(r.pendingAdvanceBalance)])
      );
      expect(balances.get(amina)).toBe(55.5);
      expect(balances.get(bakari)).toBe(70);
      expect(balances.get(chiku)).toBe(0);
    });
  });

  it("reports the emptied loading's own remaining weight", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10", "12"]);
      // A row whose own id equals its order id: only a self-correlated subquery counts it.
      const decoy = explicitId();
      const customerId = await w.one(`SELECT customer_id AS id FROM customer_orders WHERE id = $1`, [orderId]);
      await w.q(
        `INSERT INTO customer_orders (id, company_id, customer_id, order_date, status, location_id)
         VALUES ($1, $2, $3, '2026-06-01', 'LOADING', $4)`,
        [decoy, w.companyId, customerId, w.locationId]
      );
      await w.q(
        `INSERT INTO customer_order_bales (id, order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $1, $2, $3, $4, 40, 1)`,
        [decoy, await bale(w, `${w.tag}-DECOY`), `${w.tag}-DECOY`, w.locationId]
      );

      const res = await w.agent.post(`/api/factory/customer-orders/${orderId}/bales/empty`).send({});
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(2);
      expect(Number(res.body.totalWeightKg)).toBe(0);
    });
  });

  it("weighs each statement invoice by its own bales", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Weight Customer') RETURNING id`,
        [w.companyId, `${w.tag}WC`]
      );
      const invoice = async (number: string, weights: number[]) => {
        const orderId = await w.one(
          `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, invoice_number)
           VALUES ($1, $2, '2026-06-01', 'FINALIZED', $3, $4) RETURNING id`,
          [w.companyId, customerId, w.locationId, number]
        );
        for (const [i, weight] of weights.entries()) {
          await w.q(
            `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
             VALUES ($1, $2, $3, $4, $5, 1)`,
            [orderId, await bale(w, `${w.tag}-${number}-${i}`), `${w.tag}-${number}-${i}`, w.locationId, weight]
          );
        }
        return orderId;
      };
      const heavy = await invoice("INV-W1", [25, 30.5]);
      const light = await invoice("INV-W2", [12]);

      const res = await w.agent.get(`/api/factory/customers/${customerId}/statement`);
      expect(res.status).toBe(200);
      const weights = new Map(
        res.body.invoices.map((inv: { id: number; totalWeightKg: string }) => [inv.id, Number(inv.totalWeightKg)])
      );
      expect(weights.get(heavy)).toBe(55.5);
      expect(weights.get(light)).toBe(12);
    });
  });
});
