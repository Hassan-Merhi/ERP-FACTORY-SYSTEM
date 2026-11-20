/**
 * PATCH and DELETE /api/factory/raw-stock/opening-balance/:id
 * (server/routes/factory/raw-stock/opening-balance/crud.ts): id and amount
 * validation, another company's row, currency/FX resolution (explicit,
 * stored, unresolved), commission edits, supplier by id (including another
 * company's) or by name, and delete of an opening balance versus a normal
 * container row. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/raw-stock/opening-balance";

async function openingBalance(w: FactoryWorld, body: Record<string, unknown> = {}) {
  const res = await w.agent
    .post(URL)
    .send({ supplierName: `${w.tag} Supplier`, receivedKg: "100", costPerKg: "2", currencyCode: "USD", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [row] = await w.q<{ id: number; container_id: number }>(
    `SELECT id, container_id FROM factory_raw_stock WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
    [w.companyId]
  );
  return row;
}

const rawRow = (w: FactoryWorld, id: number) =>
  w.q(
    `SELECT r.received_kg::text AS kg, r.cost_per_kg::text AS cost, r.cost_per_kg_usd::text AS cost_usd,
            r.commission_amount::text AS commission, r.commission_amount_usd::text AS commission_usd,
            c.currency_code, c.fx_rate_to_usd::text AS fx, c.notes, c.supplier_id, c.status
       FROM factory_raw_stock r JOIN factory_containers c ON c.id = r.container_id WHERE r.id = $1`,
    [id]
  );

describe("PATCH opening balance", () => {
  it("validates the id and every amount before reading the row", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      const patch = (body: Record<string, unknown>, target: string | number = id) =>
        w.agent.patch(`${URL}/${target}`).send(body);
      expect((await patch({}, "abc")).body.message).toBe("Invalid id");
      expect((await patch({ receivedKg: "0" })).body.message).toBe("Received KG must be positive");
      expect((await patch({ receivedKg: "x" })).body.message).toBe("Received KG must be positive");
      expect((await patch({ costPerKg: "-1" })).body.message).toBe("Cost per KG must be non-negative");
      expect((await patch({ fxRateToUsd: "0" })).body.message).toBe("FX rate must be positive");
      expect((await patch({ commissionAmount: "abc" })).body.message).toBe("Commission amount must be a number");
      expect((await patch({ commissionFxRateToUsd: "abc" })).body.message).toBe("Commission FX rate must be a number");
      expect((await patch({ notes: "x" }, 999999999)).status).toBe(404);
    });
  });

  it("refuses another company's row and a supplier id from another company", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreignSupplier = await w.one(
        `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, 'Foreign', true) RETURNING id`,
        [other]
      );
      const res = await w.agent.patch(`${URL}/${id}`).send({ supplierId: String(foreignSupplier) });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Supplier not found");
      const [row] = await rawRow(w, id);
      expect(row.supplier_id).not.toBe(foreignSupplier);

      await w.q(`UPDATE factory_raw_stock SET company_id = $1 WHERE id = $2`, [other, id]);
      expect((await w.agent.patch(`${URL}/${id}`).send({ notes: "x" })).status).toBe(404);
      expect((await w.agent.delete(`${URL}/${id}`)).status).toBe(404);
    });
  });

  it("updates kg, cost, currency with an explicit rate, notes and supplier by name", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      const res = await w.agent.patch(`${URL}/${id}`).send({
        receivedKg: "250",
        costPerKg: "3",
        currencyCode: "EUR",
        fxRateToUsd: "1.1",
        notes: "re-weighed",
        supplierName: `  ${w.tag} New Mill `,
      });
      expect(res.status).toBe(200);
      const [row] = await rawRow(w, id);
      expect(row).toMatchObject({ kg: "250.000", currency_code: "EUR", notes: "re-weighed" });
      expect(Number(row.cost_usd)).toBeCloseTo(3.3, 6);
      const [supplier] = await w.q(`SELECT name FROM factory_suppliers WHERE id = $1`, [row.supplier_id]);
      expect(supplier.name).toBe(`${w.tag} New Mill`);

      // Same name again reuses the supplier.
      expect((await w.agent.patch(`${URL}/${id}`).send({ supplierName: `${w.tag} new mill` })).status).toBe(200);
      const [again] = await rawRow(w, id);
      expect(again.supplier_id).toBe(row.supplier_id);

      // The explicit EUR rate above is stored confirmed, so a later
      // cost-only edit resolves it.
      const [confirmed] = await w.q(
        `SELECT c.fx_rate_confirmed FROM factory_containers c JOIN factory_raw_stock r ON r.container_id = c.id WHERE r.id = $1`,
        [id]
      );
      expect(confirmed.fx_rate_confirmed).toBe(true);
      const costOnly = await w.agent.patch(`${URL}/${id}`).send({ costPerKg: "4" });
      expect(costOnly.status, JSON.stringify(costOnly.body)).toBe(200);
      expect(Number((await rawRow(w, id))[0].cost_usd)).toBeCloseTo(4.4, 6);
    });
  });

  it("refuses a currency change without a resolvable stored rate, and recomputes USD cost for USD", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      await w.q(
        `UPDATE factory_containers SET fx_rate_to_usd = NULL, fx_rate_confirmed = false WHERE id = (SELECT container_id FROM factory_raw_stock WHERE id = $1)`,
        [id]
      );
      const refused = await w.agent.patch(`${URL}/${id}`).send({ currencyCode: "TZS" });
      expect(refused.status).toBe(400);
      const [unchanged] = await rawRow(w, id);
      expect(unchanged.currency_code).toBe("USD");

      expect((await w.agent.patch(`${URL}/${id}`).send({ costPerKg: "5" })).status).toBe(200);
      const [usd] = await rawRow(w, id);
      expect(Number(usd.cost_usd)).toBe(5);
    });
  });

  it("edits the commission in USD and in a foreign currency with or without a rate", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      expect(
        (
          await w.agent
            .patch(`${URL}/${id}`)
            .send({ commissionAmount: "40", commissionPersonName: "Ali", commissionNotes: "n" })
        ).status
      ).toBe(200);
      expect((await rawRow(w, id))[0]).toMatchObject({ commission_usd: "40.0000" });

      const eur = await w.agent
        .patch(`${URL}/${id}`)
        .send({ commissionAmount: "40", commissionCurrencyCode: "EUR", commissionFxRateToUsd: "1.5" });
      expect(eur.status).toBe(200);
      expect(Number((await rawRow(w, id))[0].commission_usd)).toBe(60);

      // Changing the commission currency without a rate is refused: the
      // stored 1.5 is an EUR rate, not a TZS one. Nothing is written.
      const noRate = await w.agent
        .patch(`${URL}/${id}`)
        .send({ commissionCurrencyCode: "TZS", commissionAmount: "40" });
      expect(noRate.status).toBe(400);
      expect(noRate.body.message).toMatch(/Commission currency changed to TZS/);
      const [kept] = await w.q(
        `SELECT commission_currency_code, commission_fx_rate_to_usd::text AS fx, commission_amount_usd::text AS usd
           FROM factory_raw_stock WHERE id = $1`,
        [id]
      );
      expect(kept.commission_currency_code).toBe("EUR");
      expect(Number(kept.fx)).toBe(1.5);
      expect(Number(kept.usd)).toBe(60);

      // With its own rate the currency change goes through.
      const withRate = await w.agent
        .patch(`${URL}/${id}`)
        .send({ commissionCurrencyCode: "TZS", commissionFxRateToUsd: "0.0004" });
      expect(withRate.status, JSON.stringify(withRate.body)).toBe(200);
      // No amount in the edit: the stored 40 is converted, not zero.
      expect(Number((await rawRow(w, id))[0].commission_usd)).toBeCloseTo(0.016, 6);
    });
  });

  it("keeps the stored commission currency's rate when only the amount changes", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await openingBalance(w);
      const eur = await w.agent
        .patch(`${URL}/${id}`)
        .send({ commissionAmount: "10", commissionCurrencyCode: "EUR", commissionFxRateToUsd: "2" });
      expect(eur.status).toBe(200);
      // Same currency resent without a rate: the stored EUR rate still applies.
      const same = await w.agent.patch(`${URL}/${id}`).send({ commissionAmount: "30", commissionCurrencyCode: "EUR" });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(Number((await rawRow(w, id))[0].commission_usd)).toBe(60);
      // Back to USD needs no rate.
      const usd = await w.agent.patch(`${URL}/${id}`).send({ commissionCurrencyCode: "USD" });
      expect(usd.status).toBe(200);
      expect(Number((await rawRow(w, id))[0].commission_usd)).toBe(30);
    });
  });
});

describe("DELETE opening balance", () => {
  it("deletes an opening balance row and soft-deletes its container, but refuses a normal container row", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.delete(`${URL}/abc`)).status).toBe(400);
      const { id, container_id } = await openingBalance(w);
      const res = await w.agent.delete(`${URL}/${id}`);
      expect(res.body.message).toMatch(/deleted/);
      expect(await w.q(`SELECT 1 FROM factory_raw_stock WHERE id = $1`, [id])).toEqual([]);
      const [container] = await w.q(`SELECT status FROM factory_containers WHERE id = $1`, [container_id]);
      expect(container.status).toBe("DELETED");

      const second = await openingBalance(w);
      await w.q(`UPDATE factory_containers SET status = 'RECEIVED' WHERE id = $1`, [second.container_id]);
      const refused = await w.agent.delete(`${URL}/${second.id}`);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/not an opening balance/);
      expect((await w.agent.patch(`${URL}/${second.id}`).send({ notes: "x" })).status).toBe(404);
    });
  });
});
