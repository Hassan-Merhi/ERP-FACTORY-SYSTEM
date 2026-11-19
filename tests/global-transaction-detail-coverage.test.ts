/**
 * Global transaction detail and view-entries routes against PostgreSQL in one
 * rolled-back transaction per test: id validation, unknown vouchers, a voucher
 * of a company the user cannot access, account-name resolution for every
 * entry kind, and the item views for Sales, Stock Transfer, Production /
 * Consumption / Mixed and Purchase vouchers.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const detail = (w: FactoryWorld, id: number | string) => w.agent.get(`/api/global/transactions/${id}/detail`);
const view = (w: FactoryWorld, id: number | string) => w.agent.get(`/api/global/transactions/${id}/view-entries`);

let seq = 0;
const voucher = (w: FactoryWorld, type: string, companyId = w.companyId) =>
  w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
     VALUES ($1, $2, $3, '2026-10-02', 10, false) RETURNING id`,
    [companyId, `${w.tag}-${++seq}`, type]
  );

const item = (w: FactoryWorld, code: string) =>
  w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'pcs') RETURNING id`,
    [w.companyId, code]
  );

const supplier = (w: FactoryWorld) =>
  w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme Supply', 'a@example.com') RETURNING id`,
    [w.companyId, `${w.tag}S`]
  );

/** One entry per account kind, each resolving its own display name. */
async function entriesForEveryKind(w: FactoryWorld, voucherId: number) {
  const c = w.companyId;
  const ledger = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Cash Ledger', 'Asset') RETURNING id`,
    [c, `${w.tag}L`]
  );
  const bank = await w.one(
    `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name) VALUES ($1, $2, 'Main Bank', '1', 'B') RETURNING id`,
    [c, `${w.tag}B`]
  );
  const asset = await w.one(
    `INSERT INTO fixed_assets (company_id, code, name, category, purchase_date, purchase_amount)
     VALUES ($1, $2, 'Forklift', 'Vehicles', '2026-01-01', 100) RETURNING id`,
    [c, `${w.tag}FA`]
  );
  const supplierId = await supplier(w);
  const both = await w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Ann', 'Lee', '2026-01-01') RETURNING id`,
    [c, `${w.tag}E1`]
  );
  const firstOnly = await w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Bo', '', '2026-01-01') RETURNING id`,
    [c, `${w.tag}E2`]
  );
  const factorySupplier = await w.one(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Bale Farm') RETURNING id`,
    [c]
  );
  const customer = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Buyer Ltd') RETURNING id`,
    [c, `${w.tag}CU`]
  );
  const insert = (column: string, id: number | null) =>
    w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, fixed_asset_id, supplier_id,
         employee_id, factory_supplier_id, customer_id, debit_amount, credit_amount)
       VALUES ($1,
         CASE WHEN $2 = 'ledger' THEN $3::int END, CASE WHEN $2 = 'bank' THEN $3::int END,
         CASE WHEN $2 = 'asset' THEN $3::int END, CASE WHEN $2 = 'supplier' THEN $3::int END,
         CASE WHEN $2 = 'employee' THEN $3::int END, CASE WHEN $2 = 'factory' THEN $3::int END,
         CASE WHEN $2 = 'customer' THEN $3::int END, 1, 0)`,
      [voucherId, column, id]
    );
  await insert("ledger", ledger);
  await insert("bank", bank);
  await insert("asset", asset);
  await insert("supplier", supplierId);
  await insert("employee", both);
  await insert("employee", firstOnly);
  await insert("factory", factorySupplier);
  await insert("customer", customer);
}

const NAMES = ["Cash Ledger", "Main Bank", "Forklift", "Acme Supply", "Ann Lee", "Bo", "Bale Farm", "Buyer Ltd"];

describe("global transaction refusals", () => {
  it("refuses malformed ids, unknown vouchers and vouchers of an inaccessible company", async () => {
    await withFactoryWorld(async (w) => {
      for (const send of [detail, view]) {
        expect((await send(w, "abc")).status).toBe(400);
        expect((await send(w, 999999999)).status).toBe(404);
      }
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await voucher(w, "Journal", other);
      // The access boundary answers 404 so another company's voucher ids are not disclosed.
      const refusedDetail = await detail(w, foreign);
      expect(refusedDetail.status).toBe(404);
      expect(refusedDetail.body.voucher).toBeUndefined();
      expect((await view(w, foreign)).status).toBe(404);
    });
  });
});

describe("global transaction detail and base entries", () => {
  it("resolves the account name of every entry kind in detail and view-entries", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Journal");
      await entriesForEveryKind(w, id);
      const res = await detail(w, id);
      expect(res.status).toBe(200);
      expect(res.body.voucher).toMatchObject({ id, companyId: w.companyId, voucherType: "Journal" });
      expect(res.body.entries.map((e: { accountName: string | null }) => e.accountName)).toEqual(NAMES);
      const entries = await view(w, id);
      expect(entries.body.map((e: { accountName: string | null }) => e.accountName)).toEqual(NAMES);
    });
  });

  it("falls back to base entries for typed vouchers that have no item rows", async () => {
    await withFactoryWorld(async (w) => {
      for (const type of ["Sales", "Stock Transfer", "Production", "Purchase"]) {
        const id = await voucher(w, type);
        const res = await view(w, id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      }
    });
  });
});

describe("global transaction item views", () => {
  it("adds sales item rows with configured-price profit", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Sales");
      const stock = await item(w, `${w.tag}I`);
      await w.q(
        `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price)
         VALUES ($1, $2, 2, 12, 8, 24, 16, 8, 10), ($1, $2, 1, 5, 4, 5, 4, 1, NULL)`,
        [id, stock]
      );
      const res = await view(w, id);
      expect(res.status).toBe(200);
      const rows = res.body.filter((r: { isStockItem?: boolean }) => r.isStockItem);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hassansPrice: "10.00", hassansProfit: "4.00", hassansPercentage: "20.0" }),
          expect.objectContaining({ hassansPrice: null, hassansProfit: null, stockItemCode: `${w.tag}I` }),
        ])
      );
    });
  });

  it("lists stock transfer items, and base entries when the transfer has none", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Transfer");
      const stock = await item(w, `${w.tag}T`);
      const transfer = await w.one(
        `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id) VALUES ($1, $2, $2) RETURNING id`,
        [id, w.locationId]
      );
      const empty = await view(w, id);
      expect(empty.body).toEqual([]);
      await w.q(
        `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 3, 2, 6)`,
        [transfer, stock]
      );
      const res = await view(w, id);
      expect(res.body).toEqual([
        expect.objectContaining({
          stockItemId: stock,
          creditAmount: "6.00",
          accountName: `${w.tag}T`,
          isStockItem: true,
        }),
      ]);
    });
  });

  it("labels production, consumption and mixed adjustment items", async () => {
    await withFactoryWorld(async (w) => {
      const stock = await item(w, `${w.tag}P`);
      const adjust = async (type: string, quantities: number[]) => {
        const id = await voucher(w, type);
        const adjustment = await w.one(
          `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, $3) RETURNING id`,
          [id, w.locationId, type]
        );
        for (const qty of quantities) {
          await w.q(
            `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, $3, 1, 4)`,
            [adjustment, stock, qty]
          );
        }
        return (await view(w, id)).body as Array<{ adjustmentType: string; debitAmount: string; creditAmount: string }>;
      };
      const emptyMixed = await adjust("Mixed", []);
      expect(emptyMixed).toEqual([]);
      expect((await adjust("Production", [4]))[0]).toMatchObject({ adjustmentType: "Production", creditAmount: "0" });
      expect((await adjust("Consumption", [4]))[0]).toMatchObject({ adjustmentType: "Consumption", debitAmount: "0" });
      const mixed = await adjust("Mixed", [4, -4]);
      expect(mixed.map((r) => r.adjustmentType).sort()).toEqual(["Consumption", "Production"]);
    });
  });

  it("returns purchase lines with the enriched purchase order header", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Purchase");
      const supplierId = await supplier(w);
      const container = await w.one(
        `INSERT INTO containers (company_id, supplier_id, container_number, import_date) VALUES ($1, $2, $3, '2026-01-01') RETURNING id`,
        [w.companyId, supplierId, `${w.tag}C`]
      );
      const stock = await item(w, `${w.tag}PO`);
      const po = await w.one(
        `INSERT INTO purchase_orders (company_id, po_number, supplier_id, container_id, voucher_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [w.companyId, `${w.tag}PO`, supplierId, container, id]
      );
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Typed name', 2, 3, 6)`,
        [po, stock]
      );
      const res = await view(w, id);
      expect(res.status).toBe(200);
      expect(res.body.purchaseOrder).toMatchObject({
        id: po,
        supplierName: "Acme Supply",
        containerNumber: `${w.tag}C`,
      });
      expect(res.body.items).toEqual([
        expect.objectContaining({ isPurchaseItem: true, stockItemName: `${w.tag}PO`, debitAmount: "6.00" }),
      ]);
      expect(res.body.entries).toHaveLength(1);
    });
  });
});
