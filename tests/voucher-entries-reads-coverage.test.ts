/**
 * GET /api/vouchers/:id/entries and GET /api/vouchers/:id/view-entries against
 * PostgreSQL in one rolled-back transaction per test: id validation, company
 * scoping, the account-type mapping of each line target, and sales detail rows
 * with cost redaction for POS users and ERP users with hidden cost fields.
 * Purchase, adjustment and transfer detail rows are in
 * voucher-entries-view-details-coverage.test.ts.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { voucher, ledger, line, item, otherCompany, view } from "./helpers/voucherReadFixture";

const entries = (w: FactoryWorld, id: number | string, agent = w.agent) => agent.get(`/api/vouchers/${id}/entries`);

describe("GET /api/vouchers/:id/entries", () => {
  it("refuses a non-numeric id, an unknown voucher and hides another company's voucher", async () => {
    await withFactoryWorld(async (w) => {
      expect((await entries(w, "abc")).status).toBe(400);
      expect((await view(w, "abc")).status).toBe(400);
      expect((await entries(w, 2147483000)).status).toBe(404);
      expect((await view(w, 2147483000)).status).toBe(404);
      const foreign = await voucher(w, "Journal", { companyId: await otherCompany(w) });
      // The company resource scope middleware refuses the foreign id first
      // (CROSS_COMPANY_ACCESS_DENIED as 404), so the handler's own company
      // check is never reached.
      const res = await entries(w, foreign);
      expect(res.status).toBe(404);
      expect((await view(w, foreign)).status).toBe(404);
      expect(await w.q(`SELECT id FROM vouchers WHERE id = $1`, [foreign])).toHaveLength(1);
    });
  });

  it("maps each line target to the Daybook account type and id", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Journal");
      const cash = await ledger(w);
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number)
         VALUES ($1, $2, 'B', 'B', '1') RETURNING id`,
        [w.companyId, `${w.tag}-B`]
      );
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'S', 's@x.io') RETURNING id`,
        [w.companyId, `${w.tag}-S`]
      );
      const factorySupplier = await w.one(
        `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'FS') RETURNING id`,
        [w.companyId]
      );
      const employee = await w.one(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
         VALUES ($1, $2, 'E', 'L', '2026-01-01') RETURNING id`,
        [w.companyId, `${w.tag}-E`]
      );
      const asset = await w.one(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_date, purchase_amount)
         VALUES ($1, $2, 'Truck', 'Vehicles', '2026-01-01', 10) RETURNING id`,
        [w.companyId, `${w.tag}-FA`]
      );
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'C') RETURNING id`,
        [w.companyId, `${w.tag}-C`]
      );
      await line(w, id, { ledger_account_id: cash }, "6");
      await line(w, id, { bank_account_id: bank }, "0", "1");
      await line(w, id, { supplier_id: supplier }, "0", "1");
      await line(w, id, { factory_supplier_id: factorySupplier }, "0", "1");
      await line(w, id, { employee_id: employee }, "0", "1");
      await line(w, id, { fixed_asset_id: asset }, "0", "1");
      await line(w, id, { customer_id: customer }, "0", "1");
      const res = await entries(w, id);
      expect(res.status).toBe(200);
      const mapped = res.body.map((e: { accountType: string; accountId: number }) => [e.accountType, e.accountId]);
      expect(mapped).toEqual(
        expect.arrayContaining([
          ["ledger", cash],
          ["bank", bank],
          ["supplier", supplier],
          ["factorySupplier", factorySupplier],
          ["employee", employee],
          ["fixedAsset", asset],
          ["customer", customer],
        ])
      );
      expect(mapped).toHaveLength(7);
    });
  });
});

describe("GET /api/vouchers/:id/view-entries: sales", () => {
  async function sale(w: FactoryWorld, locationId: number | null) {
    const id = await voucher(w, "Sales", { locationId });
    await line(w, id, { ledger_account_id: await ledger(w) }, "40");
    const shirt = await item(w, "Shirt", "30");
    await w.q(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
       VALUES ($1, $2, 2, 20, 12, 40, 24, 16)`,
      [id, shirt]
    );
    return { id, shirt };
  }

  it("prices sale lines from the master location of a follower and shows cost to Admin", async () => {
    await withFactoryWorld(async (w) => {
      const follower = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'F') RETURNING id`, [
        w.companyId,
        `${w.tag}F`,
      ]);
      await w.q(
        `INSERT INTO location_price_groups (company_id, master_location_id, follower_location_id) VALUES ($1, $2, $3)`,
        [w.companyId, w.locationId, follower]
      );
      const { id, shirt } = await sale(w, follower);
      await w.q(
        `INSERT INTO stock_item_location_prices (stock_item_id, location_id, selling_price) VALUES ($1, $2, 25)`,
        [shirt, w.locationId]
      );
      const res = await view(w, id);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const row = res.body.find((e: { isStockItem?: boolean }) => e.isStockItem);
      expect(row).toMatchObject({ stockItemName: "Shirt", creditAmount: "40.00" });
      expect(row.costPrice).not.toBeNull();
      expect(row.profit).not.toBeNull();
      expect(row.narration).toMatch(/^Sale of 2(\.0+)? x Shirt @ \$20/);
    });
  });

  it("hides cost and profit from POS users and from ERP users with the hidden cost field", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await sale(w, null);
      await w.q(`UPDATE users SET hidden_erp_cost_fields = ARRAY['sales_profit_cost'] WHERE id = $1`, [w.userId]);
      const hidden = (await view(w, id)).body.find((e: { isStockItem?: boolean }) => e.isStockItem);
      expect(hidden).toMatchObject({ costPrice: null, profit: null, hassansPrice: null });
      await w.q(`UPDATE users SET hidden_erp_cost_fields = '{}' WHERE id = $1`, [w.userId]);
      const pos = await w.agentFor("POS");
      const res = await view(w, id, pos);
      expect(res.status).toBe(200);
      const row = res.body.find((e: { isStockItem?: boolean }) => e.isStockItem);
      expect(row).toMatchObject({ costPrice: null, profit: null, configuredPrice: null });
    });
  });

  it("falls back to the ledger lines when a sale has no item rows", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Sales");
      await line(w, id, { ledger_account_id: await ledger(w) }, "5");
      const res = await view(w, id);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].debitAmount).toBe("5.00");
    });
  });
});
