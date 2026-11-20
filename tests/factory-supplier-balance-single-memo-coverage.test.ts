/**
 * Single supplier balance (server/routes/factory/suppliers/balance/single.ts)
 * over HTTP in one rolled-back factory company per test: the id refusals,
 * another company's supplier, and the operational memo's every conversion
 * path - container material and freight (container, USD and third-currency),
 * own commission (USD, container and own currency), other charges and
 * post-offload charges payable to the supplier, FX transfers in and out,
 * factory payments and voucher payments (USD and legacy foreign rate) - with
 * the unresolved-rate flag for each component that has no usable rate.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const balance = (w: FactoryWorld, id: number | string, filters: Record<string, string> = {}) =>
  w.agent.get(`/api/factory/suppliers/${id}/balance?${new URLSearchParams(filters)}`);

let seq = 0;

function builders(w: FactoryWorld) {
  const supplier = (name: string, parentId: number | null = null) =>
    w.one(`INSERT INTO factory_suppliers (company_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id`, [
      w.companyId,
      name,
      parentId,
    ]);
  const container = (supplierId: number, f: Record<string, string | boolean | number | null>) =>
    w.one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code, fx_rate_to_usd,
         fx_rate_confirmed, total_kg, rate_per_kg, freight, freight_paid_by, freight_currency_code, freight_fx_rate_to_usd,
         freight_fx_rate_confirmed, commission_amount, commission_currency_code, commission_fx_rate_to_usd,
         commission_fx_rate_confirmed, other_charges, other_charges_currency_code, other_charges_supplier_id)
       VALUES ($1, $2, $3, 'OFFLOADED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        w.companyId,
        `${w.tag}-SB${++seq}`,
        supplierId,
        f.currency ?? "USD",
        f.fx ?? "1",
        f.fxConfirmed ?? false,
        f.kg ?? "0",
        f.rate ?? "0",
        f.freight ?? "0",
        f.paidBy ?? "supplier",
        f.freightCcy ?? null,
        f.freightFx ?? null,
        f.freightFxConfirmed ?? false,
        f.commission ?? "0",
        f.commissionCcy ?? null,
        f.commissionFx ?? null,
        f.commissionFxConfirmed ?? false,
        f.other ?? "0",
        f.otherCcy ?? null,
        f.otherSupplier ?? null,
      ]
    );
  const offloadCharge = (
    containerId: number,
    supplierId: number,
    amount: string,
    ccy: string,
    fx: string,
    ok: boolean
  ) =>
    w.q(
      `INSERT INTO factory_offload_additional_charges (company_id, container_id, supplier_id, description, amount,
         currency_code, fx_rate_to_usd, fx_rate_confirmed)
       VALUES ($1, $2, $3, 'charge', $4, $5, $6, $7)`,
      [w.companyId, containerId, supplierId, amount, ccy, fx, ok]
    );
  const voucherPayment = async (supplierId: number, debit: string, currency: string, rate: string | null) => {
    const [v] = await w.q(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Payment', '2026-05-01', $3, $4, $5) RETURNING id`,
      [w.companyId, `${w.tag}-VP${++seq}`, debit, currency, rate]
    );
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, factory_supplier_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, $3, 0, 'paid')`,
      [v.id, supplierId, debit]
    );
  };
  return { supplier, container, offloadCharge, voucherPayment };
}

const memo = async (w: FactoryWorld, id: number) => {
  const res = await balance(w, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  return res.body.operationalMemo as { outstandingUsd: string; fxUnresolved: boolean };
};

describe("single supplier balance", () => {
  it("refuses invalid ids and another company's supplier", () =>
    withFactoryWorld(async (w) => {
      expect((await balance(w, "abc")).status).toBe(400);
      expect((await balance(w, 999999999)).status).toBe(404);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await w.one(
        `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Foreign') RETURNING id`,
        [other]
      );
      expect((await balance(w, foreign)).status).toBe(404);
    }));

  it("adds every resolved component and subtracts payments in the operational memo", () =>
    withFactoryWorld(async (w) => {
      const b = builders(w);
      const s = await b.supplier("Resolved");
      const child = await b.supplier("Child", s);
      const x = await b.supplier("Other");
      const c1 = await b.container(s, { kg: "100", rate: "1", freight: "10", commission: "5" });
      await b.container(s, {
        currency: "EUR",
        fx: "1.2",
        fxConfirmed: true,
        kg: "10",
        rate: "1",
        freight: "5",
        freightCcy: "USD",
        commission: "2",
      });
      await b.container(s, {
        currency: "EUR",
        fx: "1.2",
        fxConfirmed: true,
        freight: "3",
        freightCcy: "GBP",
        freightFx: "1.5",
        freightFxConfirmed: true,
        commission: "4",
        commissionCcy: "GBP",
        commissionFx: "1.4",
        commissionFxConfirmed: true,
      });
      await b.container(s, { kg: "1", rate: "1", freight: "100", paidBy: "own" });
      await b.container(x, { other: "7", otherSupplier: s });
      await b.container(x, { other: "0", otherSupplier: s });
      await b.container(x, {
        currency: "EUR",
        fx: "1.2",
        fxConfirmed: true,
        other: "3",
        otherCcy: "EUR",
        otherSupplier: s,
      });
      await b.offloadCharge(c1, s, "8", "USD", "1", false);
      await b.offloadCharge(c1, s, "0", "USD", "1", false);
      await b.offloadCharge(c1, s, "5", "EUR", "1.1", true);
      await b.offloadCharge(c1, child, "9", "USD", "1", false);
      await w.q(
        `INSERT INTO factory_supplier_fx_transfers (company_id, date, from_supplier_id, to_supplier_id, from_amount,
           from_currency_code, fx_rate_to_usd, to_amount_usd)
         VALUES ($1, '2026-05-01', $2, $3, 50, 'USD', 1, 50), ($1, '2026-05-02', $3, $2, 20, 'USD', 1, 20)`,
        [w.companyId, x, s]
      );
      await w.q(
        `INSERT INTO factory_supplier_payments (company_id, supplier_id, date, amount, amount_usd) VALUES ($1, $2, '2026-05-01', 10, 10)`,
        [w.companyId, s]
      );
      await b.voucherPayment(s, "6", "USD", null);
      await b.voucherPayment(child, "3", "USD", null);

      // 110 + 5 + 17 + 2.4 + 4.5 + 5.6 + 1 + 7 + 3.6 + 8 + 5.5 + 30 - 10 - 6. A legacy foreign-currency
      // voucher line (converted at the voucher rate) can no longer be written: the
      // VOUCHER_LINE_NATIVE_AMOUNT_REQUIRED guard refuses it.
      expect(await memo(w, s)).toMatchObject({ outstandingUsd: "183.60", fxUnresolved: false });
      const eur = await balance(w, s, { fxEurPayout: "true", asOf: "2026-12-31" });
      expect(eur.status).toBe(200);
      expect(eur.body).toHaveProperty("fxEurPayable");
      expect(eur.body).toHaveProperty("ledgerBalance");
    }));

  it("flags each component without a usable rate and leaves it out", () =>
    withFactoryWorld(async (w) => {
      const b = builders(w);
      const u = await b.supplier("Unresolved");
      const x = await b.supplier("Carrier");
      const c = await b.container(u, {
        currency: "EUR",
        fx: "1",
        kg: "10",
        rate: "1",
        freight: "2",
        freightCcy: "USD",
      });
      await b.container(u, { freight: "3", freightCcy: "GBP" });
      await b.container(u, { commission: "4", commissionCcy: "EUR" });
      await b.container(x, {
        currency: "EUR",
        fx: "1.2",
        fxConfirmed: true,
        other: "5",
        otherCcy: "GBP",
        otherSupplier: u,
      });
      await b.container(x, { currency: "EUR", fx: "1.2", other: "6", otherCcy: "EUR", otherSupplier: u });
      await b.offloadCharge(c, u, "7", "EUR", "1.1", false);
      expect(await memo(w, u)).toEqual(expect.objectContaining({ outstandingUsd: "2.00", fxUnresolved: true }));

      for (const setup of ["offload", "other-ccy", "commission", "freight"]) {
        const only = await b.supplier(`Only ${setup}`);
        if (setup === "offload") await b.offloadCharge(c, only, "7", "EUR", "1.1", false);
        if (setup === "other-ccy")
          await b.container(x, { currency: "EUR", fx: "1.2", other: "6", otherCcy: "EUR", otherSupplier: only });
        if (setup === "commission")
          await b.container(only, {
            currency: "EUR",
            fx: "1.2",
            fxConfirmed: true,
            commission: "4",
            commissionCcy: "GBP",
          });
        if (setup === "freight") await b.container(only, { freight: "3", freightCcy: "GBP" });
        expect((await memo(w, only)).fxUnresolved, setup).toBe(true);
      }
    }));
});
