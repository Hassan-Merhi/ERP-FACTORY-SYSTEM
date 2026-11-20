/**
 * Factory route helpers (server/routes/factory/_helpers.ts) driven directly
 * inside one rolled-back transaction: recalculateContainerCosts' refusals
 * (missing container, no received weight, unresolved container and commission
 * rates) and its currency normalisation of freight, other charges, commission,
 * confirmed duty and additional charges, with the raw-stock and mix-batch
 * cascade; getOrCreateLedgerAccount's registry, explicit and default types and
 * restore of a deleted account; the admin check and the hide-all-costs lookup.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { db } from "../server/db";
import {
  checkFactoryAdmin,
  getOrCreateLedgerAccount,
  getOrFetchFxRateToUsd,
  getUserHideAllCosts,
  isLegacySHA256Hash,
  recalculateContainerCosts,
  recalculateOrderTotals,
} from "../server/routes/factory/_helpers";

let seq = 0;

async function company(w: FactoryWorld) {
  // The world's own factory company; its Admin login is not used here.
  const { q, one, companyId, tag } = w;
  const container = (fields: {
    kg: string | null;
    currency: string;
    fx: string;
    rate: string;
    freight?: string;
    freightCcy?: string | null;
    other?: string | null;
    otherCcy?: string | null;
    commission?: string;
    duty?: string;
    dutyStatus?: string;
  }) =>
    one(
      `INSERT INTO factory_containers (company_id, container_number, status, actual_received_kg, currency_code, fx_rate_to_usd,
         rate_per_kg, freight, freight_currency_code, other_charges, other_charges_currency_code, commission_amount,
         duty_amount, duty_status)
       VALUES ($1, $2, 'OFFLOADED', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        companyId,
        `${tag}-${++seq}`,
        fields.kg,
        fields.currency,
        fields.fx,
        fields.rate,
        fields.freight ?? "0",
        fields.freightCcy ?? null,
        fields.other ?? null,
        fields.otherCcy ?? null,
        fields.commission ?? "0",
        fields.duty ?? "0",
        fields.dutyStatus ?? "NONE",
      ]
    );
  const commission = (containerId: number, currency: string, total: string, fx: string, confirmed: boolean) =>
    q(
      `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate, commission_total,
         currency_code, fx_rate_to_usd, fx_rate_confirmed)
       VALUES ($1, $2, 'Agent', 0.1, $3, $4, $5, $6)`,
      [companyId, containerId, total, currency, fx, confirmed]
    );
  const charge = (containerId: number, amount: string, currency: string | null, fx: string | null) =>
    q(
      `INSERT INTO factory_offload_additional_charges (company_id, container_id, description, amount, currency_code, fx_rate_to_usd)
       VALUES ($1, $2, 'Extra', $3, $4, $5)`,
      [companyId, containerId, amount, currency, fx]
    );
  return { companyId, tag, q, one, container, commission, charge };
}

const recalc = (companyId: number, containerId: number) =>
  db.transaction((tx) => recalculateContainerCosts(tx as never, companyId, containerId));

describe("recalculateContainerCosts", () => {
  it("refuses a missing container, no received weight and unresolved rates", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      await expect(recalc(c.companyId, 999999999)).rejects.toThrow(/not found/);
      const empty = await c.container({ kg: "0", currency: "USD", fx: "1", rate: "2" });
      await expect(recalc(c.companyId, empty)).rejects.toThrow(/no received weight/);
      const unset = await c.container({ kg: "100", currency: "EUR", fx: "1", rate: "2" });
      await expect(recalc(c.companyId, unset)).rejects.toThrow(/EUR/);
      const commissionUnset = await c.container({ kg: "100", currency: "EUR", fx: "1.1", rate: "2" });
      await c.commission(commissionUnset, "GBP", "10", "1.3", false);
      await expect(recalc(c.companyId, commissionUnset)).rejects.toThrow(/GBP/);
    }));

  it("costs a USD container and cascades to raw stock and container-priced mix sources only", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      const id = await c.container({ kg: "100", currency: "USD", fx: "1", rate: "2", freight: "10", commission: "5" });
      const stockId = await c.one(
        `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg) VALUES ($1, $2, 100, 0, 2) RETURNING id`,
        [c.companyId, id]
      );
      const supplier = await c.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'S') RETURNING id`, [
        c.companyId,
      ]);
      // Mix sources from a container need the container's supplier.
      await c.q(`UPDATE factory_containers SET supplier_id = $1 WHERE id = $2`, [supplier, id]);
      const batch = await c.one(
        `INSERT INTO factory_mix_batches (company_id, status, batch_number) VALUES ($1, 'OPEN', $2) RETURNING id`,
        [c.companyId, `${c.tag}-A`]
      );
      const zeroBatch = await c.one(
        `INSERT INTO factory_mix_batches (company_id, status, batch_number) VALUES ($1, 'OPEN', $2) RETURNING id`,
        [c.companyId, `${c.tag}-Z`]
      );
      await c.q(
        `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, supplier_id, weight_kg, cost_per_kg, total_cost)
         VALUES ($1, $2, NULL, 10, 1, 10), ($1, $2, $3, 10, 0.5, 5), ($4, $2, NULL, 0, 0, 0)`,
        [batch, id, supplier, zeroBatch]
      );

      const result = await recalc(c.companyId, id);
      expect(result).toEqual({ totalCost: 215, inclusiveCostPerKg: 2.15, costPerKgUsd: 2.15, rawStockId: stockId });
      const sources = await c.q(
        `SELECT supplier_id IS NULL AS direct, total_cost::numeric::text AS total FROM factory_mix_batch_sources
          WHERE mix_batch_id = $1 ORDER BY id`,
        [batch]
      );
      expect(sources).toEqual([
        { direct: true, total: "21.5000000" },
        { direct: false, total: "5.0000000" },
      ]);
      const batches = await c.q(
        `SELECT id, cost_per_kg::numeric AS cpk FROM factory_mix_batches WHERE id = ANY($1::int[]) ORDER BY id`,
        [[batch, zeroBatch]]
      );
      expect(batches.map((b) => Number(b.cpk))).toEqual([1.325, 0]);
      const [stock] = await c.q(`SELECT cost_per_kg_usd::numeric AS usd FROM factory_raw_stock WHERE id = $1`, [
        stockId,
      ]);
      expect(Number(stock.usd)).toBe(2.15);
    }));

  it("normalises every foreign charge into the container currency", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      const id = await c.container({
        kg: "100",
        currency: "EUR",
        fx: "1.1",
        rate: "2",
        freight: "11",
        freightCcy: "USD",
        other: "5",
        otherCcy: "GBP",
        duty: "7",
        dutyStatus: "CONFIRMED",
      });
      await c.commission(id, "GBP", "10", "1.3", true);
      await c.charge(id, "3", "EUR", null);
      await c.charge(id, "2.2", "USD", null);
      await c.charge(id, "4", "GBP", null);
      await c.charge(id, "1", null, null);
      const result = await recalc(c.companyId, id);
      // 200 base + 11/1.1 freight + 5 other + 13/1.1 commission + 7 duty + 3 + 2 + 4 + 1 charges.
      expect(result.totalCost).toBeCloseTo(200 + 10 + 5 + 13 / 1.1 + 7 + 3 + 2 + 4 + 1, 6);
      expect(result.costPerKgUsd).toBeCloseTo((result.totalCost / 100) * 1.1, 6);
      expect(result.rawStockId).toBeNull();

      const sameCcy = await c.container({ kg: "10", currency: "EUR", fx: "1.2", rate: "1", freight: "6" });
      await c.commission(sameCcy, "EUR", "6", "9", false);
      expect((await recalc(c.companyId, sameCcy)).totalCost).toBe(10 + 6 + 6);

      const usdCommission = await c.container({ kg: "10", currency: "EUR", fx: "1.2", rate: "1" });
      await c.commission(usdCommission, "USD", "12", "1", false);
      expect((await recalc(c.companyId, usdCommission)).totalCost).toBeCloseTo(10 + 10, 6);

      const blankCommissionCcy = await c.container({ kg: "10", currency: "USD", fx: "1", rate: "1" });
      await c.q(
        `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate, commission_total, currency_code)
         VALUES ($1, $2, 'Agent', 0.1, 4, '')`,
        [c.companyId, blankCommissionCcy]
      );
      expect((await recalc(c.companyId, blankCommissionCcy)).totalCost).toBe(14);
    }));
});

describe("recalculateOrderTotals", () => {
  it("prices per-kg proforma lines by weight, order supplements and plain lines per bale, plus charges", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      const customer = await c.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Totals Customer') RETURNING id`,
        [c.companyId, `${c.tag}C`]
      );
      const location = await c.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Yard') RETURNING id`,
        [c.companyId, `${c.tag}L2`]
      );
      const proforma = await c.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'PF') RETURNING id`,
        [c.companyId, customer]
      );
      await c.q(
        `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, price_per_bale, pricing_mode, price_per_kg)
         VALUES ($1, 'ART-K', 'Kilo', 0, 'per_kg', 2), ($1, 'ART-X', 'Extra', 0, 'per_kg', 3),
                ($1, 'ART-Z', 'Zero', 0, 'per_kg', 0), ($1, '', 'Blank', 1, 'per_bale', NULL)`,
        [proforma]
      );
      const order = (status: string, proformaId: number | null) =>
        c.one(
          `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, proforma_id_used)
           VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
          [c.companyId, customer, status, location, proformaId]
        );
      const orderId = await order("LOADING", proforma);
      await c.q(
        `INSERT INTO customer_order_extra_expected_lines (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
         VALUES ($1, $2, ' art-x ', 'Extra', 1, 9)`,
        [c.companyId, orderId]
      );
      const addBale = async (
        orderRef: number,
        article: string | null,
        name: string | null,
        kg: string,
        price: string
      ) => {
        const ref = `${c.tag}-OB${++seq}`;
        const baleId = await c.one(
          `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status) VALUES ($1, $2, $2, $3, 'RESERVED_FOR_ORDER') RETURNING id`,
          [c.companyId, ref, kg]
        );
        await c.q(
          `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orderRef, baleId, ref, location, kg, price, article, name]
        );
      };
      await addBale(orderId, "ART-K", "Kilo", "10", "5");
      await addBale(orderId, "ART-K", "Kilo", "10", "5");
      await addBale(orderId, "ART-X", "Extra", "7", "9");
      await addBale(orderId, "ART-Z", "Zero", "4", "6");
      await addBale(orderId, null, null, "3", "1");
      await c.q(
        `INSERT INTO customer_order_charges (order_id, name, amount, charge_type) VALUES ($1, 'Truck', 10, 'FREIGHT'), ($1, 'Pallets', 2.5, 'OTHER')`,
        [orderId]
      );

      await recalculateOrderTotals(db as never, orderId);
      const lines = await c.q(
        `SELECT article_code, bale_name, qty, total_price::text AS total, pricing_mode, price_per_kg::text AS per_kg
           FROM customer_order_lines WHERE order_id = $1 ORDER BY article_code`,
        [orderId]
      );
      expect(lines).toEqual([
        {
          article_code: "ART-K",
          bale_name: "Kilo",
          qty: 2,
          total: "40.00",
          pricing_mode: "per_kg",
          per_kg: "2.000000",
        },
        { article_code: "ART-X", bale_name: "Extra", qty: 1, total: "9.00", pricing_mode: "per_bale", per_kg: null },
        { article_code: "ART-Z", bale_name: "Zero", qty: 1, total: "6.00", pricing_mode: "per_kg", per_kg: "0.000000" },
        {
          article_code: "UNKNOWN",
          bale_name: "UNKNOWN",
          qty: 1,
          total: "1.00",
          pricing_mode: "per_bale",
          per_kg: null,
        },
      ]);
      const [totals] = await c.q(
        `SELECT subtotal_bales::text AS sub, freight_amount::text AS freight, other_charges_total::text AS other,
                grand_total::text AS grand, total_qty_bales AS qty FROM customer_orders WHERE id = $1`,
        [orderId]
      );
      expect(totals).toEqual({ sub: "56.00", freight: "10.00", other: "2.50", grand: "68.50", qty: 5 });

      // No proforma and no bales: zero totals, no lines.
      const plain = await order("LOADING", null);
      await db.transaction((tx) => recalculateOrderTotals(tx as never, plain));
      const [empty] = await c.q(
        `SELECT grand_total::text AS grand, total_qty_bales AS qty FROM customer_orders WHERE id = $1`,
        [plain]
      );
      expect(empty).toEqual({ grand: "0.00", qty: 0 });
    }));
});

describe("small factory helpers", () => {
  it("creates and restores ledger accounts with registry, explicit and default types", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      const payable = await getOrCreateLedgerAccount(c.companyId, "FACTORY_CHARGES_PAYABLE", "Payable", "Asset");
      const typed = await getOrCreateLedgerAccount(c.companyId, `${c.tag}-INC`, "Income", "Income");
      const plain = await getOrCreateLedgerAccount(c.companyId, `${c.tag}-${"X".repeat(60)}`, "Long");
      const rows = await c.q(
        `SELECT id, code, account_type FROM ledger_accounts WHERE id = ANY($1::int[]) ORDER BY id`,
        [[payable, typed, plain]]
      );
      expect(rows.map((r) => r.account_type)).toEqual(["Liability", "Income", "Expense"]);
      expect(rows[2].code).toHaveLength(50);

      await c.q(`UPDATE ledger_accounts SET deleted_at = now(), active = FALSE WHERE id = $1`, [typed]);
      expect(await getOrCreateLedgerAccount(c.companyId, `${c.tag}-INC`, "Income")).toBe(typed);
      const [restored] = await c.q(`SELECT deleted_at, active FROM ledger_accounts WHERE id = $1`, [typed]);
      expect(restored).toEqual({ deleted_at: null, active: true });
      expect(await getOrCreateLedgerAccount(c.companyId, "FACTORY_CHARGES_PAYABLE", "Again")).toBe(payable);
      expect(await getOrFetchFxRateToUsd(c.companyId, "USD", "2026-01-01")).toBe("1");
    }));

  it("checks admin access, override windows and the hide-all-costs profile", () =>
    withFactoryWorld(async (w) => {
      const c = await company(w);
      const response = () => {
        const res = { statusCode: 0, body: null as unknown } as { statusCode: number; body: unknown };
        return Object.assign(res, {
          status(code: number) {
            res.statusCode = code;
            return this;
          },
          json(payload: unknown) {
            res.body = payload;
            return this;
          },
        });
      };
      const req = (session: Record<string, unknown> | undefined) => ({ session }) as unknown as Request;
      const allowed = response();
      expect(checkFactoryAdmin(req({ currentRole: "Developer" }), allowed as unknown as Response)).toBe(true);
      expect(
        checkFactoryAdmin(
          req({ currentRole: "Manager", factoryAdminOverrideUntil: Date.now() + 60000 }),
          allowed as never
        )
      ).toBe(true);
      expect(allowed.statusCode).toBe(0);
      for (const session of [{ currentRole: "Manager", factoryAdminOverrideUntil: Date.now() - 1 }, {}, undefined]) {
        const denied = response();
        expect(checkFactoryAdmin(req(session), denied as never)).toBe(false);
        expect(denied.statusCode).toBe(403);
        expect(denied.body).toMatchObject({ requiresAdminOverride: true });
      }

      const [user] = await c.q(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
        `${c.tag.toLowerCase()}_hide`,
      ]);
      const [bare] = await c.q(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
        `${c.tag.toLowerCase()}_bare`,
      ]);
      await c.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hide_all_costs) VALUES ($1, $2, 'Hidden', TRUE)`,
        [c.companyId, user.id]
      );
      expect(await getUserHideAllCosts(req({}))).toBe(false);
      expect(await getUserHideAllCosts(req({ userId: user.id, currentRole: "Owner" }))).toBe(false);
      expect(await getUserHideAllCosts(req({ userId: user.id, currentRole: "Manager" }))).toBe(true);
      expect(await getUserHideAllCosts(req({ userId: user.id }))).toBe(true);
      expect(await getUserHideAllCosts(req({ userId: bare.id, currentRole: "Manager" }))).toBe(false);
      expect(isLegacySHA256Hash("a".repeat(64))).toBe(true);
      expect(isLegacySHA256Hash("$2b$10$abc")).toBe(false);
    }));
});
