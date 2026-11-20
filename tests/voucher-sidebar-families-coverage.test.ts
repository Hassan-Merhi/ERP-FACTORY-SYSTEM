/**
 * /api/accounts/voucher-sidebar against PostgreSQL in one rolled-back
 * transaction per test (real HTTP). Pins every account family's balance sign:
 * Cr-opening banks, Dr-opening employees, group / system ledgers dropped,
 * optional vouchers excluded, Cr customers, factory-supplier container /
 * broker-commission / payment / voucher folding, ERP supplier openings for a
 * parent and a child company, the Golden Coast cash presentation, and the
 * per-company TTL cache.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/accounts/voucher-sidebar";
type Row = { id: number | string; type: string; name: string; balance: number | string; balanceSide?: string };
const find = (rows: Row[], type: string, name: string) => rows.find((r) => r.type === type && r.name === name);

async function voucher(w: FactoryWorld, optional = false) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, optional)
     VALUES ($1, 'Journal', $2, '2026-02-01', 0, $3) RETURNING id`,
    [w.companyId, `${w.tag}V${Math.random().toString(36).slice(2, 8)}`, optional]
  );
}
const entry = (w: FactoryWorld, voucherId: number, column: string, id: number, dr: number, cr: number) => {
  const params = [w.companyId, voucherId, id, dr, cr];
  if (column === "ledger")
    return w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  if (column === "bank")
    return w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, bank_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  if (column === "asset")
    return w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, fixed_asset_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  if (column === "employee")
    return w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, employee_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  if (column === "supplier")
    return w.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
      params
    );
  return w.q(
    `INSERT INTO voucher_entries (company_id, voucher_id, factory_supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
    params
  );
};
const ledger = (
  w: FactoryWorld,
  name: string,
  extra: { side?: string; opening?: number; subType?: string; parentId?: number } = {}
) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, sub_type, parent_id)
     VALUES ($1, $2, $3, 'Expense', $4, $5, $6, $7) RETURNING id`,
    [
      w.companyId,
      `${w.tag}${name}`,
      name,
      extra.opening ?? 0,
      extra.side ?? "Dr",
      extra.subType ?? null,
      extra.parentId ?? null,
    ]
  );

describe("factory company sidebar", () => {
  it("folds every family's balance and serves the cached copy on the next call", () =>
    withFactoryWorld(async (w) => {
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Overdraft', 'B', '1', 100, 'Cr') RETURNING id`,
        [w.companyId, `${w.tag}B`]
      );
      const asset = await w.one(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_amount, purchase_date, opening_balance)
         VALUES ($1, $2, 'Press', 'Plant', 10, '2026-01-01', 40) RETURNING id`,
        [w.companyId, `${w.tag}A`]
      );
      const employee = await w.one(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Ann', 'Lee', '2026-01-01', 10, 'Dr') RETURNING id`,
        [w.companyId, `${w.tag}E`]
      );
      const group = await ledger(w, "Group Head");
      await ledger(w, "Child", { parentId: group });
      await ledger(w, "System Stock", { subType: "sp_stock" });
      const rent = await ledger(w, "Rent", { opening: 5, side: "Cr" });
      await w.q(
        `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side) VALUES ($1, $2, 'Credit Cust', 30, 'Cr')`,
        [w.companyId, `${w.tag}CU`]
      );
      const broker = await w.one(
        `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, 'Broker', 0) RETURNING id`,
        [w.companyId]
      );
      const main = await w.one(
        `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, 'Mill', 50) RETURNING id`,
        [w.companyId]
      );
      const sub = await w.one(
        `INSERT INTO factory_suppliers (company_id, name, parent_id) VALUES ($1, 'Mill Sub', $2) RETURNING id`,
        [w.companyId, main]
      );
      await w.q(
        `INSERT INTO factory_containers (company_id, container_number, supplier_id, total_kg, actual_received_kg, rate_per_kg, freight, fx_rate_to_usd,
           commission_supplier_id, commission_amount, commission_currency_code, currency_code)
         VALUES ($1, $2, $3, 100, NULL, 2, 10, NULL, $4, 20, NULL, 'EUR'),
                ($1, $5, $6, 100, 50, 1, 0, 2, $4, 5, 'USD', NULL),
                ($1, $7, NULL, 0, 0, 0, 0, NULL, $4, 7, NULL, NULL)`,
        [w.companyId, `${w.tag}C1`, main, broker, `${w.tag}C2`, sub, `${w.tag}C3`]
      );
      await w.q(
        `INSERT INTO factory_supplier_payments (company_id, supplier_id, amount, amount_usd, date) VALUES ($1, $2, 30, 30, '2026-02-01')`,
        [w.companyId, sub]
      );
      const live = await voucher(w);
      await entry(w, live, "bank", bank, 0, 20);
      await entry(w, live, "asset", asset, 0, 15);
      await entry(w, live, "employee", employee, 0, 4);
      await entry(w, live, "ledger", rent, 25, 0);
      await entry(w, live, "factory", main, 12, 0);
      const optional = await voucher(w, true);
      await entry(w, optional, "ledger", rent, 999, 0);

      const res = await w.agent.get(URL);
      expect(res.status).toBe(200);
      const rows = res.body as Row[];
      expect(find(rows, "bank", "Overdraft")?.balance).toBe(-120);
      expect(find(rows, "fixedAsset", "Press")?.balance).toBe(25);
      expect(find(rows, "employee", "Ann Lee")).toMatchObject({ balance: "6.00", balanceSide: "Dr" });
      expect(find(rows, "ledger", "Rent")?.balance).toBe(20);
      expect(find(rows, "ledger", "Group Head")).toBeUndefined();
      expect(find(rows, "ledger", "System Stock")).toBeUndefined();
      expect(find(rows, "customer", "Credit Cust")?.balance).toBe(-30);
      // Mill: 50 opening + (100*2+10) + (50*1+0)*2 - 30 paid - 12 voucher-paid = 318
      expect(find(rows, "factorySupplier", "Mill")?.balance).toBe(-318);
      // Broker: 20 EUR at fx 1 + 5 USD (other supplier's container) + 7 (no main supplier)
      expect(find(rows, "factorySupplier", "Broker")?.balance).toBe(-32);
      expect(rows.some((r) => r.type === "supplier")).toBe(false);

      await w.q(`UPDATE bank_accounts SET name = 'Renamed' WHERE id = $1`, [bank]);
      const cached = await w.agent.get(URL);
      expect(find(cached.body, "bank", "Overdraft")).toBeDefined();
    }));
});

describe("ERP company sidebar", () => {
  const supplier = (w: FactoryWorld, name: string, opening: number, side: string | null) =>
    w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side) VALUES ($1, $2, $3, '', $4, $5) RETURNING id`,
      [w.companyId, `${w.tag}${name}`, name, opening, side]
    );

  it("applies supplier openings by side in a parent company", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [w.companyId]);
      const drSide = await supplier(w, "DrSup", 10, "Dr");
      await supplier(w, "CrSup", 10, "Cr");
      const v = await voucher(w);
      await entry(w, v, "supplier", drSide, 0, 4);
      await w.q(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Idle Bank', 'B', '1')`,
        [w.companyId, `${w.tag}IB`]
      );
      await w.q(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_amount, purchase_date) VALUES ($1, $2, 'Idle Asset', 'Plant', 1, '2026-01-01')`,
        [w.companyId, `${w.tag}IA`]
      );
      await w.q(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Owed', 'Worker', '2026-01-01', 8, NULL)`,
        [w.companyId, `${w.tag}OE`]
      );
      await w.q(
        `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side) VALUES ($1, $2, 'Debtor', 12, 'Dr')`,
        [w.companyId, `${w.tag}DC`]
      );
      const rows = (await w.agent.get(URL)).body as Row[];
      expect(find(rows, "bank", "Idle Bank")?.balance).toBe(0);
      expect(find(rows, "fixedAsset", "Idle Asset")?.balance).toBe(0);
      expect(find(rows, "employee", "Owed Worker")).toMatchObject({ balance: "8.00", balanceSide: "Cr" });
      expect(find(rows, "customer", "Debtor")?.balance).toBe(12);
      expect(find(rows, "supplier", "DrSup")?.balance).toBe(6);
      expect(find(rows, "supplier", "CrSup")?.balance).toBe(-10);
    }));

  it("shows only active suppliers without openings in a child company", () =>
    withFactoryWorld(async (w) => {
      const parent = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'erp') RETURNING id`,
        [`${w.tag}P`]
      );
      await w.q(`UPDATE companies SET company_type = 'erp', parent_company_id = $1 WHERE id = $2`, [
        parent,
        w.companyId,
      ]);
      const active = await supplier(w, "Active", 100, "Cr");
      await supplier(w, "Idle", 100, "Cr");
      const v = await voucher(w);
      await entry(w, v, "supplier", active, 0, 9);
      const rows = (await w.agent.get(URL)).body as Row[];
      expect(find(rows, "supplier", "Active")?.balance).toBe(-9);
      expect(find(rows, "supplier", "Idle")).toBeUndefined();
    }));
});

describe("supplier partner sidebar", () => {
  it("presents the GC sales cash payable as positive cash", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const cash = await ledger(w, "GC Sales Cash", { subType: "sp_payable", opening: 70, side: "Cr" });
      await ledger(w, "Other Payable", { subType: "sp_payable", opening: 5, side: "Cr" });
      const v = await voucher(w);
      await entry(w, v, "ledger", cash, 10, 0);
      const rows = (await w.agent.get(URL)).body as Row[];
      expect(find(rows, "ledger", "GC Sales Cash")?.balance).toBe(60);
      expect(find(rows, "ledger", "Other Payable")?.balance).toBe(-5);
    }));
});
