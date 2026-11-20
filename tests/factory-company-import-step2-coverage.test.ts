/**
 * POST /api/factory/import-company-data, master-data stage
 * (companyImportRoutesStep2) through the real app inside one rolled-back
 * transaction: file-level refusals that write nothing, then a payload with
 * every master table - self-referencing ledger and stock-group trees (parent
 * after child, a parent that is missing), colliding codes, and the foreign
 * keys each table is remapped through.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/import-company-data";

const upload = (w: FactoryWorld, payload: unknown, agent = w.agent) =>
  agent
    .post(URL)
    .attach("file", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)), "c.json");

async function counts(w: FactoryWorld) {
  const [row] = await w.q(
    `SELECT (SELECT COUNT(*)::int FROM ledger_accounts WHERE company_id = $1) AS ledgers,
            (SELECT COUNT(*)::int FROM locations WHERE company_id = $1) AS locations,
            (SELECT COUNT(*)::int FROM stock_items WHERE company_id = $1) AS items,
            (SELECT COUNT(*)::int FROM customers WHERE company_id = $1) AS customers`,
    [w.companyId]
  );
  return row;
}

function payload(tag: string, existingLocationCode: string) {
  return {
    sourceCompanyId: 987650,
    tables: {
      locations: [
        { id: 1, code: existingLocationCode, name: "Clash", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: 2, code: `${tag}NEWLOC`, name: "Fresh" },
      ],
      ledger_accounts: [
        { id: 12, code: `${tag}GC`, name: "Grandchild", accountType: "Asset", parentId: 11 },
        { id: 11, code: `${tag}CH`, name: "Child", accountType: "Asset", parentId: 10 },
        { id: 10, code: `${tag}RT`, name: "Root", accountType: "Asset", parentId: null },
        { id: 13, code: `${tag}OR`, name: "Orphan", accountType: "Asset", parentId: 999 },
      ],
      bank_accounts: [
        {
          id: 20,
          code: `${tag}BK`,
          name: "Bank",
          bankName: "B",
          accountNumber: "1",
          linkedLedgerId: 10,
        },
      ],
      stock_groups: [
        { id: 31, code: `${tag}SG2`, name: "Sub", parentId: 30 },
        { id: 30, code: `${tag}SG1`, name: "Top", parentId: null },
      ],
      stock_items: [{ id: 40, code: `${tag}IT`, name: "Item", uom: "kg", stockGroupId: 31 }],
      inventory: [{ id: 50, locationId: 2, stockItemId: 40, quantity: "5" }],
      company_settings: [{ id: 60, parentCreditAccountId: 11 }],
      exchange_rates: [{ id: 70, effectiveDate: "2026-02-01", fromCurrency: "EUR", toCurrency: "USD", rate: "1.1" }],
      customers: [{ id: 80, code: `${tag}CU`, legalName: "Cust", ledgerAccountId: 12 }],
      customer_balances: [
        { id: 90, customerId: 80, balance: "10", transactionDate: "2026-02-01", transactionType: "OPENING" },
      ],
      factory_settings: [{ id: 100 }],
      factory_suppliers: [{ id: 110, name: "Supp" }],
      factory_categories: [{ id: 120, name: "Cat" }],
      factory_bale_products: [{ id: 130, code: `${tag}BP`, name: "Prod", categoryId: 120 }],
      factory_fx_rates: [{ id: 140, currencyCode: "EUR", effectiveDate: "2026-02-01", rateToUsd: "1.1" }],
      factory_bale_sequences: [{ id: 150 }],
    },
  };
}

describe("company import master data", () => {
  it("refuses bad files, its own export and a company that already has data", () =>
    withFactoryWorld(async (w) => {
      const before = await counts(w);
      const noFile = await w.agent.post(URL);
      expect(noFile.status).toBe(400);
      expect(noFile.body.message).toBe("No file uploaded");
      expect((await upload(w, "{not json")).body.message).toBe("Uploaded file is not valid JSON");
      expect((await upload(w, { tables: {} })).body.message).toBe("Invalid export file format");
      const own = await upload(w, { sourceCompanyId: w.companyId, tables: {} });
      expect(own.status).toBe(400);
      expect(own.body.message).toMatch(/same company/);
      const manager = await w.agentFor("Manager");
      expect((await upload(w, payload(w.tag, "X"), manager)).status).toBe(403);

      await w.q(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-01-01', 0)`,
        [w.companyId, `${w.tag}-V`]
      );
      const busy = await upload(w, payload(w.tag, "X"));
      expect(busy.status).toBe(400);
      expect(busy.body.message).toMatch(/already has data/);
      expect(await counts(w)).toEqual(before);
    }));

  it("refuses a file with an unbalanced voucher before writing", () =>
    withFactoryWorld(async (w) => {
      const before = await counts(w);
      const res = await upload(w, {
        sourceCompanyId: 987651,
        tables: {
          ...payload(w.tag, "X").tables,
          vouchers: [{ id: 1, voucherNumber: "U1", voucherType: "Journal", voucherDate: "2026-01-01" }],
          voucher_entries: [{ id: 2, voucherId: 1, ledgerAccountId: 10, debitAmount: "5", creditAmount: "0" }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("IMPORT_UNBALANCED_VOUCHERS");
      expect(await counts(w)).toEqual(before);
    }));

  it("imports every master table with remapped keys and unique codes", () =>
    withFactoryWorld(async (w) => {
      const [loc] = await w.q<{ code: string }>(`SELECT code FROM locations WHERE id = $1`, [w.locationId]);
      const res = await upload(w, payload(w.tag, loc.code));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.details).toMatchObject({
        locations: 2,
        ledger_accounts: 4,
        bank_accounts: 1,
        stock_groups: 2,
        stock_items: 1,
        inventory: 1,
        company_settings: 1,
        exchange_rates: 1,
        customers: 1,
        customer_balances: 1,
        factory_settings: 1,
        factory_suppliers: 1,
        factory_categories: 1,
        factory_bale_products: 1,
        factory_fx_rates: 1,
        factory_bale_sequences: 1,
      });

      const locations = await w.q<{ code: string; name: string }>(
        `SELECT code, name FROM locations WHERE company_id = $1 AND name IN ('Clash', 'Fresh') ORDER BY name`,
        [w.companyId]
      );
      expect(locations).toEqual([
        { code: `${loc.code}_C${w.companyId}`, name: "Clash" },
        { code: `${w.tag}NEWLOC`, name: "Fresh" },
      ]);

      const ledgers = await w.q<{ name: string; parent: string | null; id: number }>(
        `SELECT l.id, l.name, p.name AS parent FROM ledger_accounts l LEFT JOIN ledger_accounts p ON p.id = l.parent_id
          WHERE l.company_id = $1 AND l.code LIKE $2 ORDER BY l.name`,
        [w.companyId, `${w.tag}%`]
      );
      expect(ledgers.map((l) => [l.name, l.parent])).toEqual([
        ["Child", "Root"],
        ["Grandchild", "Child"],
        ["Orphan", null],
        ["Root", null],
      ]);
      const byName = new Map(ledgers.map((l) => [l.name, Number(l.id)]));

      const [bank] = await w.q(`SELECT linked_ledger_id FROM bank_accounts WHERE company_id = $1`, [w.companyId]);
      expect(Number(bank.linked_ledger_id)).toBe(byName.get("Root"));
      const [settings] = await w.q(`SELECT parent_credit_account_id FROM company_settings WHERE company_id = $1`, [
        w.companyId,
      ]);
      expect(Number(settings.parent_credit_account_id)).toBe(byName.get("Child"));
      const [customer] = await w.q(
        `SELECT c.ledger_account_id, b.balance::text AS balance FROM customers c
           JOIN customer_balances b ON b.customer_id = c.id WHERE c.company_id = $1`,
        [w.companyId]
      );
      expect([Number(customer.ledger_account_id), customer.balance]).toEqual([byName.get("Grandchild"), "10.00"]);

      const [item] = await w.q(
        `SELECT g.name AS grp, pg.name AS parent, i.quantity::text AS qty, l.name AS location
           FROM stock_items s JOIN stock_groups g ON g.id = s.stock_group_id
           LEFT JOIN stock_groups pg ON pg.id = g.parent_id
           JOIN inventory i ON i.stock_item_id = s.id JOIN locations l ON l.id = i.location_id
          WHERE s.company_id = $1`,
        [w.companyId]
      );
      expect(item).toMatchObject({ grp: "Sub", parent: "Top", location: "Fresh" });
      const [product] = await w.q(
        `SELECT c.name FROM factory_bale_products p JOIN factory_categories c ON c.id = p.category_id
          WHERE p.company_id = $1`,
        [w.companyId]
      );
      expect(product.name).toBe("Cat");

      const audit = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'companies' AND record_id = $1 AND action = 'import'`,
        [w.companyId]
      );
      expect(audit).toHaveLength(1);
    }));

  it("imports an empty export and rows that carry no id", () =>
    withFactoryWorld(async (w) => {
      const empty = await upload(w, { sourceCompanyId: 987652, tables: {} });
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ success: true, totalRecords: 0, details: {} });

      const res = await upload(w, {
        sourceCompanyId: 987653,
        tables: {
          ledger_accounts: [
            { code: `${w.tag}N1`, name: "No id root", accountType: "Asset", parentId: null },
            { id: 1, code: `${w.tag}N2`, name: "Parent", accountType: "Asset", parentId: null },
            { code: `${w.tag}N3`, name: "No id child", accountType: "Asset", parentId: 1 },
            { code: `${w.tag}N4`, name: "No id orphan", accountType: "Asset", parentId: 77 },
          ],
          factory_suppliers: [{ name: "No id supplier" }],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.details).toEqual({ ledger_accounts: 4, factory_suppliers: 1 });
      const rows = await w.q<{ name: string; parent: string | null }>(
        `SELECT l.name, p.name AS parent FROM ledger_accounts l LEFT JOIN ledger_accounts p ON p.id = l.parent_id
          WHERE l.company_id = $1 AND l.code LIKE $2 ORDER BY l.code`,
        [w.companyId, `${w.tag}N%`]
      );
      expect(rows).toEqual([
        { name: "No id root", parent: null },
        { name: "Parent", parent: null },
        { name: "No id child", parent: "Parent" },
        { name: "No id orphan", parent: null },
      ]);
    }));
});
