/**
 * The account list (accounts/all.ts: /api/accounts/all, the Factory Accounts
 * and Agent Ledger lists) through the real app in one rolled-back
 * transaction: ledger, bank, fixed-asset, employee and supplier families with
 * their opening sides, a customer-owned ledger, the factory worker advances
 * memo, date windows, the analytics profile, the book-balance basis and the
 * suppliers of other companies that must stay hidden.
 */
import { describe, expect, it, vi } from "vitest";

import { storage } from "../server/storage";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;
const code = (w: FactoryWorld) => `${w.tag}-${++seq}`;

async function seedFamilies(w: FactoryWorld) {
  const ledger = (name: string, type: string, opening = "0", side: string | null = null) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.companyId, code(w), name, type, opening, side]
    );
  const cash = await ledger("Till", "Cash", "50", "Dr");
  const income = await ledger("Sales", "Income");
  const bank = await w.one(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Main', 'BK', '1', 20, 'Cr') RETURNING id`,
    [w.companyId, code(w)]
  );
  const asset = await w.one(
    `INSERT INTO fixed_assets (company_id, code, name, category, purchase_amount, purchase_date)
     VALUES ($1, $2, 'Press', 'Machinery', 900, '2026-01-01') RETURNING id`,
    [w.companyId, code(w)]
  );
  const employee = await w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Ada', 'Ng', '2026-01-01') RETURNING id`,
    [w.companyId, code(w)]
  );
  const v = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Receipt', '2026-06-10', 30) RETURNING id`,
    [w.companyId, code(w)]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 30, 0), ($1, $3, 0, 30)`,
    [v, cash, income]
  );
  return { cash, income, bank, asset, employee };
}

const byId = (body: { accounts: Array<{ id: string }> }) => Object.fromEntries(body.accounts.map((a) => [a.id, a]));

describe("account list", () => {
  it("lists every family with opening sides, date windows and the analytics profile for a trading company", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'trading' WHERE id = $1`, [w.companyId]);
      const ids = await seedFamilies(w);
      const own = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Own Supplier', '', 15, 'Cr') RETURNING id`,
        [w.companyId, code(w)]
      );
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'trading') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Foreign Supplier', '') RETURNING id`,
        [other, code(w)]
      );

      const all = await w.agent.get("/api/accounts/all?balanceBasis=book");
      expect(all.status).toBe(200);
      expect(all.body.allPosted).toBe(true);
      const accounts = byId(all.body);
      expect(accounts[`ledger-${ids.cash}`]).toMatchObject({ balance: "80.00", balanceSide: "Dr", openingBalance: 50 });
      expect(accounts[`ledger-${ids.income}`]).toMatchObject({
        balance: "30.00",
        balanceSide: "Cr",
        openingBalanceSide: "Cr",
      });
      expect(accounts[`bank-${ids.bank}`]).toMatchObject({ name: "Main (BK)", balanceSide: "Cr", openingBalance: 20 });
      expect(accounts[`asset-${ids.asset}`]).toMatchObject({ type: "fixedAsset", openingBalanceSide: "Dr" });
      expect(accounts[`employee-${ids.employee}`]).toMatchObject({
        name: "Ada Ng",
        balance: "0.00",
        balanceSide: "Cr",
      });
      expect(accounts[`supplier-${own}`]).toMatchObject({ name: "Own Supplier", openingBalanceSide: "Cr" });
      expect(accounts[`supplier-${foreign}`]).toBeUndefined();

      const windowed = await w.agent.get("/api/accounts/all?startDate=2026-06-11&endDate=2026-12-31");
      expect(windowed.body).toMatchObject({ asOfDate: "2026-12-31", allPosted: false });
      expect(byId(windowed.body)[`ledger-${ids.cash}`]).toMatchObject({ openingBalance: 80, balance: "80.00" });
      expect(byId(windowed.body)[`supplier-${own}`]).toMatchObject({ openingBalance: 15 });

      const analytics = await w.agent.get("/api/accounts/all?profile=analytics");
      const types = new Set(analytics.body.accounts.map((a: { type: string }) => a.type));
      expect([...types].sort()).toEqual(["bank", "fixedAsset", "ledger"]);
      expect(analytics.body.accounts[0]).toHaveProperty("accountType");
    }));

  it("shows a customer-owned ledger and the factory worker advances memo on the factory lists", () =>
    withFactoryWorld(async (w) => {
      const advances = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Factory  Worker Advances', 'Asset') RETURNING id`,
        [w.companyId, code(w)]
      );
      const ar = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'AR Amina', 'Asset') RETURNING id`,
        [w.companyId, code(w)]
      );
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name, ledger_account_id, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Amina', $3, 40, 'Dr') RETURNING id`,
        [w.companyId, code(w), ar]
      );
      const workerId = await w.one(
        `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Bilal') RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_worker_advances (company_id, worker_id, amount, remaining_balance, advance_date)
         VALUES ($1, $2, 25, 25, '2026-05-01')`,
        [w.companyId, workerId]
      );
      for (const url of ["/api/factory/accounts/list", "/api/factory/agents/accounts"]) {
        const res = await w.agent.get(url);
        expect(res.status).toBe(200);
        const accounts = byId(res.body);
        expect(accounts[`ledger-${advances}`]).toMatchObject({ balance: "0.00", notInLedgerTotal: "25.00" });
        expect(accounts[`ledger-${ar}`]).toMatchObject({
          customerId: customer,
          balance: "40.00",
          balanceSide: "Dr",
          balanceBasis: "ledger",
        });
        expect(res.body.accounts.some((a: { type: string }) => a.type === "supplier")).toBe(false);
      }
      const dated = await w.agent.get("/api/factory/accounts/list?startDate=2026-01-01");
      expect(byId(dated.body)[`ledger-${ar}`]).toMatchObject({ openingBalance: 40 });
    }));

  it("retries a deadlocked read once and answers 500 when the read keeps failing", () =>
    withFactoryWorld(async (w) => {
      const original = storage.getCompanyById;
      const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
      const spy = vi.spyOn(storage, "getCompanyById").mockRejectedValueOnce({ cause: deadlock });
      try {
        const retried = await w.agent.get("/api/accounts/all");
        expect(retried.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRejectedValue(new Error("boom"));
        const failed = await w.agent.get("/api/accounts/all");
        expect([failed.status, failed.body.code]).toEqual([500, "ACCOUNT_LIST_READ_FAILED"]);
      } finally {
        spy.mockRestore();
        expect(storage.getCompanyById).toBe(original);
      }
    }));
});
