/**
 * Factory Daybook read routes over HTTP against PostgreSQL (one rolled-back
 * transaction per test): live loading amounts, voucher-backed rows refreshed
 * from the live voucher, deleted vouchers dropped, synthetic voucher rows and
 * their filters, bale-stock production-price derivation, singleton
 * de-duplication and the own-entries-only restriction.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const DAY = "2026-03-02";
const range = { startDate: DAY, endDate: DAY };

async function customerOrder(w: FactoryWorld, total: string) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Daybook Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${Math.random().toString(36).slice(2, 7)}`]
  );
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total)
     VALUES ($1, $2, $3, 'LOADING', $4) RETURNING id`,
    [w.companyId, customerId, DAY, total]
  );
}

function entry(
  w: FactoryWorld,
  fields: {
    txType: string;
    ref?: number | null;
    table?: string | null;
    amount?: string;
    meta?: string;
    by?: string | null;
  }
) {
  return w.one(
    `INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, reference_id, reference_table, description,
       currency_code, amount_currency, fx_rate_to_usd, amount_usd, meta_json, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, '1', $7, $8, $9) RETURNING id`,
    [
      w.companyId,
      DAY,
      fields.txType,
      fields.ref ?? null,
      fields.table ?? null,
      `${fields.txType} stored text`,
      fields.amount ?? "0",
      fields.meta ?? null,
      fields.by === undefined ? w.userId : fields.by,
    ]
  );
}

function voucher(w: FactoryWorld, type: string, amount: string, extra: { currency?: string; rate?: string } = {}) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      w.companyId,
      `${w.tag}${type}${Math.random().toString(36).slice(2, 6)}`,
      type,
      DAY,
      amount,
      extra.currency ?? "USD",
      extra.rate ?? "1",
      `${type} live text`,
    ]
  );
}

describe("factory daybook loading amounts", () => {
  it("returns live totals only for loadings with a creation entry and validates the ID list", async () => {
    await withFactoryWorld(async (w) => {
      const tracked = await customerOrder(w, "125.5");
      const untracked = await customerOrder(w, "40");
      await entry(w, { txType: "LOADING_CREATED", ref: tracked, table: "customer_orders" });
      const res = await w.agent
        .get("/api/factory/daybook/loading-amounts")
        .query({ orderIds: `${tracked},${untracked},${tracked}` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ amounts: { [tracked]: "125.50" } });
      for (const orderIds of ["", "1,a", "1,,2", "0", Array.from({ length: 151 }, (_, i) => i + 1).join(",")]) {
        const bad = await w.agent.get("/api/factory/daybook/loading-amounts").query({ orderIds });
        expect(bad.status, orderIds.slice(0, 20)).toBe(400);
      }
    });
  });
});

describe("factory daybook list", () => {
  it("refreshes voucher-backed rows, drops deleted vouchers and adds uncaptured vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const live = await voucher(w, "Payment", "80", { currency: "ZMW", rate: "0.05" });
      const gone = await voucher(w, "Receipt", "15");
      await w.q(`UPDATE vouchers SET optional = TRUE WHERE id = $1`, [live]);
      await entry(w, { txType: "PAYMENT", ref: live, table: "vouchers", amount: "1" });
      await entry(w, { txType: "RECEIPT", ref: gone, table: "vouchers", amount: "15" });
      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [gone]);
      const synthetic = await voucher(w, "Journal", "9.5");
      await voucher(w, "Sales", "999");

      const res = await w.agent.get("/api/factory/daybook").query(range);
      expect(res.status).toBe(200);
      const real = res.body.find((r: any) => r.referenceId === live && r.id > 0);
      expect(real).toMatchObject({
        description: "Payment live text",
        amountCurrency: "80",
        amountUsd: "4",
        optional: true,
      });
      expect(res.body.some((r: any) => r.referenceId === gone)).toBe(false);
      expect(res.body.find((r: any) => r.id === -synthetic)).toMatchObject({
        txType: "JOURNAL",
        amountUsd: "9.5",
        createdBy: null,
      });
      expect(res.body.some((r: any) => r.description === "Sales live text")).toBe(false);

      const journals = await w.agent.get("/api/factory/daybook").query({ ...range, txType: "JOURNAL" });
      expect(journals.body.map((r: any) => r.id)).toEqual([-synthetic]);
      const zmw = await w.agent.get("/api/factory/daybook").query({ ...range, currencyCode: "ZMW" });
      expect(zmw.body.every((r: any) => r.id > 0 || r.currencyCode === "ZMW")).toBe(true);
      expect(zmw.body.some((r: any) => r.id === -synthetic)).toBe(false);
      const nonVoucher = await w.agent.get("/api/factory/daybook").query({ ...range, txType: "INVOICE" });
      expect(nonVoucher.body).toEqual([]);
      const outside = await w.agent
        .get("/api/factory/daybook")
        .query({ startDate: "2020-01-01", endDate: "2020-01-02" });
      expect(outside.body).toEqual([]);
      // No range at all means today only.
      const today = await w.agent.get("/api/factory/daybook");
      expect(today.body.some((r: any) => r.referenceId === live)).toBe(false);
    });
  });

  it("derives bale stock entries from production prices and keeps only the latest singleton event", async () => {
    await withFactoryWorld(async (w) => {
      const byId = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price)
         VALUES ($1, $2, 'Shirts', 'ART-S', '12.25') RETURNING id`,
        [w.companyId, `${w.tag}P1`]
      );
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price)
         VALUES ($1, $2, 'Pants', 'ART-P', '7.75')`,
        [w.companyId, `${w.tag}P2`]
      );
      const bale = (ref: string, productId: number | null, article: string | null) =>
        w.one(
          `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, article_code, weight_kg, status)
           VALUES ($1, $2, $2, $3, $4, 20, 'IN_STOCK') RETURNING id`,
          [w.companyId, `${w.tag}${ref}`, productId, article]
        );
      const first = await bale("B1", byId, "ART-S");
      const second = await bale("B2", null, "ART-P");
      const meta = JSON.stringify({
        bales: [{ id: String(first), weightKg: 20 }, { id: second, weightKg: 20 }, { id: "uuid-like-id" }, {}],
      });
      const stock = await entry(w, { txType: "BALE_STOCK_ENTRY", amount: "999", meta });
      const broken = await entry(w, { txType: "BALE_STOCK_ENTRY", amount: "5", meta: "{not json" });
      const orderId = await customerOrder(w, "60");
      const older = await entry(w, { txType: "INVOICE", ref: orderId, table: "customer_orders", amount: "60" });
      const newer = await entry(w, { txType: "INVOICE", ref: orderId, table: "customer_orders", amount: "60" });
      await entry(w, { txType: "INVOICE", ref: 999999999, table: "customer_orders", amount: "1" });

      const res = await w.agent.get("/api/factory/daybook").query(range);
      expect(res.status).toBe(200);
      const ids = res.body.map((r: any) => r.id);
      expect(res.body.find((r: any) => r.id === stock)).toMatchObject({ amountCurrency: "20.00", amountUsd: "20.00" });
      expect(res.body.find((r: any) => r.id === broken).amountCurrency).toBe("5.00");
      expect(ids).toContain(newer);
      expect(ids).not.toContain(older);
      expect(res.body.filter((r: any) => r.txType === "INVOICE")).toHaveLength(1);
    });
  });

  it("names the material supplier on offload rows and falls back for sparse vouchers and bales", async () => {
    await withFactoryWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Rag Mill') RETURNING id`,
        [w.companyId]
      );
      const containerId = await w.one(
        `INSERT INTO factory_containers (company_id, container_number, supplier_id) VALUES ($1, 'MSKU1', $2) RETURNING id`,
        [w.companyId, supplierId]
      );
      const rawId = await w.one(
        `INSERT INTO factory_raw_stock (company_id, container_id, quantity_kg) VALUES ($1, $2, 100) RETURNING id`,
        [w.companyId, containerId]
      );
      const offload = await w.one(
        `INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, reference_id, reference_table, description,
           currency_code, amount_currency, amount_usd)
         VALUES ($1, $2, 'OFFLOAD_RAW_STOCK', $3, 'factory_raw_stock', 'Offloaded container MSKU1: 100 kg', 'USD', 0, 0)
         RETURNING id`,
        [w.companyId, DAY, rawId]
      );
      const bare = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount)
         VALUES ($1, $2, 'Receipt', '2026-02-01', $3, 4) RETURNING id`,
        [w.companyId, `${w.tag}BARE`, DAY]
      );
      await w.q(`UPDATE vouchers SET exchange_rate = '0' WHERE id = $1`, [bare]);
      const zeroPrice = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price)
         VALUES ($1, $2, 'Zero', 'ART-Z', NULL) RETURNING id`,
        [w.companyId, `${w.tag}PZ`]
      );
      const orphanBale = await w.one(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, weight_kg, status)
         VALUES ($1, $2, $2, $3, 20, 'IN_STOCK') RETURNING id`,
        [w.companyId, `${w.tag}BZ`, zeroPrice]
      );
      const zeroStock = await entry(w, {
        txType: "BALE_STOCK_ENTRY",
        amount: "3",
        meta: JSON.stringify({ bales: [{ id: String(orphanBale) }] }),
      });
      const noBales = await entry(w, { txType: "BALE_STOCK_ENTRY", amount: "2", meta: "{}" });

      const res = await w.agent.get("/api/factory/daybook").query({ ...range, currencyCode: "ALL" });
      expect(res.status).toBe(200);
      const all = await w.agent.get("/api/factory/daybook").query(range);
      expect(all.body.find((r: any) => r.id === offload).description).toBe(
        "Offloaded container MSKU1 - Rag Mill: 100 kg"
      );
      expect(all.body.find((r: any) => r.id === -bare)).toMatchObject({
        description: expect.stringMatching(/^Receipt voucher #/),
        currencyCode: "USD",
        fxRateToUsd: "1",
        txDate: DAY,
        effectiveDate: DAY,
      });
      expect(all.body.find((r: any) => r.id === zeroStock).amountCurrency).toBe("3.00");
      expect(all.body.find((r: any) => r.id === noBales).amountCurrency).toBe("2.00");
    });
  });

  it("lists all time newest first when the client sends empty dates, and reports bad dates as errors", async () => {
    await withFactoryWorld(async (w) => {
      const early = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Payment', '2025-01-01', 1) RETURNING id`,
        [w.companyId, `${w.tag}OLD`]
      );
      const late = await voucher(w, "Payment", "2");
      const middle = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Payment', '2025-06-01', 1) RETURNING id`,
        [w.companyId, `${w.tag}MID`]
      );
      const res = await w.agent.get("/api/factory/daybook").query({ startDate: "", endDate: "" });
      expect(res.status).toBe(200);
      expect(res.body.map((r: any) => r.referenceId)).toEqual([late, middle, early]);
      const bad = await w.agent.get("/api/factory/daybook").query({ startDate: "not-a-date", endDate: DAY });
      expect(bad.status).toBe(500);
    });
  });

  it("limits a restricted user to their own and unattributed entries without synthetic vouchers", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hidden_cost_fields)
         VALUES ($1, $2, 'Restricted', ARRAY['daybook_own_only'])`,
        [w.companyId, w.userId]
      );
      const mine = await voucher(w, "Payment", "10");
      const theirs = await voucher(w, "Payment", "11");
      const nobody = await voucher(w, "Payment", "12");
      await voucher(w, "Journal", "13");
      await entry(w, { txType: "PAYMENT", ref: mine, table: "vouchers" });
      await entry(w, { txType: "PAYMENT", ref: theirs, table: "vouchers", by: "someone-else" });
      await entry(w, { txType: "PAYMENT", ref: nobody, table: "vouchers", by: null });
      const res = await w.agent.get("/api/factory/daybook").query(range);
      expect(res.status).toBe(200);
      expect(res.body.map((r: any) => r.referenceId).sort()).toEqual([mine, nobody].sort());
      expect(res.body.every((r: any) => r.id > 0)).toBe(true);
    });
  });
});
