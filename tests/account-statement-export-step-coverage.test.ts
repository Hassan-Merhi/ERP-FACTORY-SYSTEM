/**
 * Account statement Excel export (accountStatementRoutesStep) over real HTTP
 * in one rolled-back transaction per test. Pins query-shape refusals, the
 * per-family 404s for missing and other-company masters, the customer-owned
 * ledger path, the supplier "posted here" rule and every family's export.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/accounts/statement/export-excel";
const searchOf = (params: string | Record<string, string | number>) =>
  typeof params === "string"
    ? params
    : new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
const exportOf = (w: FactoryWorld, params: string | Record<string, string | number>) =>
  w.agent.get(`${URL}?${searchOf(params)}`).buffer(true);

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`, [
    `${w.tag}OC`,
  ]);
const ledger = (w: FactoryWorld, name: string, companyId = w.companyId) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Expense', 50, 'Cr') RETURNING id`,
    [companyId, `${w.tag}${name}`, name]
  );
async function line(w: FactoryWorld, column: string, id: number, date: string, dr: number, cr: number) {
  const v = await w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
     VALUES ($1, 'Journal', $2, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}V${date}${column}${dr}${cr}`, date, dr || cr]
  );
  const params = [w.companyId, v, id, dr, cr];
  if (column === "ledger_account_id")
    await w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  else if (column === "bank_account_id")
    await w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, bank_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  else if (column === "fixed_asset_id")
    await w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, fixed_asset_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  else if (column === "supplier_id")
    await w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  else
    await w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, employee_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
}
const isWorkbook = (res: { status: number; headers: Record<string, string> }) =>
  res.status === 200 && /spreadsheetml/.test(res.headers["content-type"] ?? "");

describe("query refusals", () => {
  it.each([
    ["accountType=ledger&accountType=bank&accountId=1", "accountType must be a single string value"],
    ["accountType=ledger", "Invalid accountId"],
    ["accountId=1&accountId=2", "Invalid accountId"],
    ["accountId=0", "Invalid accountId"],
    ["accountId=abc", "Invalid accountId"],
    ["accountId=1&startDate=2026-01-01&startDate=2026-02-01", "startDate must be a single YYYY-MM-DD value"],
    ["accountId=1&endDate=2026-01-01&endDate=2026-02-01", "endDate must be a single YYYY-MM-DD value"],
  ])("refuses %s", (query, message) =>
    withFactoryWorld(async (w) => {
      const res = await exportOf(w, query);
      expect([res.status, res.body.message]).toEqual([400, message]);
    })
  );

  it("refuses an invalid date range", () =>
    withFactoryWorld(async (w) => {
      const res = await exportOf(w, "accountId=1&startDate=2026-05-01&endDate=2026-01-01");
      expect(res.status).toBe(400);
    }));
});

describe("missing and other-company masters", () => {
  it("returns 404 for every family when the id is unknown or belongs to another company", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreignLedger = await ledger(w, "Foreign", other);
      const foreignBank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'FB', 'B', '1') RETURNING id`,
        [other, `${w.tag}FB`]
      );
      const foreignAsset = await w.one(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_amount, purchase_date) VALUES ($1, $2, 'FA', 'Plant', 10, '2026-01-01') RETURNING id`,
        [other, `${w.tag}FA`]
      );
      const foreignEmployee = await w.one(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'F', 'E', '2026-01-01') RETURNING id`,
        [other, `${w.tag}FE`]
      );
      const foreignSupplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'FS', '') RETURNING id`,
        [other, `${w.tag}FS`]
      );
      for (const [type, id, message] of [
        ["ledger", foreignLedger, "Account not found"],
        ["bank", foreignBank, "Bank account not found"],
        ["fixed-asset", foreignAsset, "Fixed asset not found"],
        ["employee", foreignEmployee, "Employee not found"],
        ["supplier", foreignSupplier, "Supplier not found"],
        ["supplier", 2147483000, "Supplier not found"],
      ] as const) {
        const res = await exportOf(w, { accountType: type, accountId: id });
        expect([type, res.status, res.body.message]).toEqual([type, 404, message]);
      }
    }));
});

describe("exports", () => {
  it("exports a plain ledger with and without a start date", () =>
    withFactoryWorld(async (w) => {
      const id = await ledger(w, "Rent");
      await line(w, "ledger_account_id", id, "2026-03-01", 100, 0);
      await line(w, "ledger_account_id", id, "2026-01-05", 0, 20);
      expect(isWorkbook(await exportOf(w, { accountId: id }))).toBe(true);
      expect(
        isWorkbook(
          await exportOf(w, { accountType: "ledger", accountId: id, startDate: "2026-02-01", endDate: "2026-12-31" })
        )
      ).toBe(true);
    }));

  it("exports a customer-owned ledger through the customer statement", () =>
    withFactoryWorld(async (w) => {
      const id = await ledger(w, "Owned");
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, 'Owner Co', $3) RETURNING id`,
        [w.companyId, `${w.tag}CU`, id]
      );
      const v = await w.one(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount) VALUES ($1, 'Sales', $2, '2026-02-02', 10) RETURNING id`,
        [w.companyId, `${w.tag}CV`]
      );
      await w.q(
        `INSERT INTO voucher_entries (company_id, voucher_id, customer_id, debit_amount, credit_amount) VALUES ($1, $2, $3, 10, 0)`,
        [w.companyId, v, customer]
      );
      expect(isWorkbook(await exportOf(w, { accountId: id }))).toBe(true);
      expect(isWorkbook(await exportOf(w, { accountId: id, startDate: "2026-01-01", endDate: "2026-12-31" }))).toBe(
        true
      );
    }));

  it("exports bank, fixed-asset, employee and supplier statements", () =>
    withFactoryWorld(async (w) => {
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Main', 'B', '1') RETURNING id`,
        [w.companyId, `${w.tag}B`]
      );
      const asset = await w.one(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_amount, purchase_date) VALUES ($1, $2, 'Press', 'Plant', 10, '2026-01-01') RETURNING id`,
        [w.companyId, `${w.tag}A`]
      );
      const employee = await w.one(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Ann', 'Lee', '2026-01-01') RETURNING id`,
        [w.companyId, `${w.tag}E`]
      );
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', '') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      await line(w, "bank_account_id", bank, "2026-02-01", 30, 0);
      await line(w, "fixed_asset_id", asset, "2026-02-01", 10, 0);
      await line(w, "employee_id", employee, "2026-02-03", 0, 5);
      await line(w, "employee_id", employee, "2026-02-01", 7, 0);
      await line(w, "supplier_id", supplier, "2026-02-01", 0, 40);
      for (const [type, id] of [
        ["bank", bank],
        ["fixed-asset", asset],
        ["employee", employee],
        ["supplier", supplier],
      ] as const) {
        expect([type, isWorkbook(await exportOf(w, { accountType: type, accountId: id }))]).toEqual([type, true]);
      }
    }));

  it("exports a parent company's supplier only once this company posted to it", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [other, w.companyId]);
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Shared', '') RETURNING id`,
        [other, `${w.tag}SS`]
      );
      expect((await exportOf(w, { accountType: "supplier", accountId: supplier })).status).toBe(404);
      await line(w, "supplier_id", supplier, "2026-02-01", 0, 15);
      expect(isWorkbook(await exportOf(w, { accountType: "supplier", accountId: supplier }))).toBe(true);
    }));

  it("exports an unknown account type with no lines", () =>
    withFactoryWorld(async (w) => {
      expect(isWorkbook(await exportOf(w, "accountType=mystery&accountId=1"))).toBe(true);
    }));
});
