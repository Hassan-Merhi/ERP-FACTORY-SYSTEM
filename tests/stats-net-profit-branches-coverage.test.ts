/**
 * GET /api/stats/net-profit (server/routes/stats/statsNetProfitRoutes.ts):
 * income and expense refunds, factory stock ledgers stripped in ERP mode,
 * the payroll-payable strip, merged stock lines, OTW containers valued at
 * items total when the grand total is zero, owner's capital, and the
 * supplier-partner month-to-date POS profit fields. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const ROUTE = "/api/stats/net-profit";

async function ledgerWorld(w: FactoryWorld) {
  const acct = (code: string, name: string, type: string, subType: string | null = null, opening = "0") =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.companyId, code, name, type, subType, opening]
    );
  const cash = await acct(`${w.tag}C`, "Cash Box", "Cash");
  const ids = {
    cash,
    sales: await acct(`${w.tag}SA`, "Sales", "Income"),
    otherIncome: await acct(`${w.tag}OI`, "Interest Income", "Income", "Indirect Income"),
    rent: await acct(`${w.tag}RE`, "Rent", "Expense", "Indirect Expense"),
    freight: await acct(`${w.tag}FR`, "Freight In", "Direct Expense"),
    factoryStock: await acct("FACTORY_STOCK_IN_HAND", "Factory stock in hand", "Asset", "Current Asset"),
    floor: await acct(`${w.tag}SF`, "Stock on Floor", "Asset", "Current Asset"),
    payroll: await acct(`${w.tag}PP`, "Payroll Payable", "Liability", "Current Liability"),
    payrollAsset: await acct("PAY_PAYABLE", "Staff payroll clearing", "Asset", "Current Asset"),
    profit: await acct(`${w.tag}PR`, "Retained", "Profit", null, "500"),
  };
  let n = 0;
  const post = async (debitAccount: number, creditAccount: number, amount: string) => {
    const voucherId = await w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Journal', '2026-03-10', $3) RETURNING id`,
      [w.companyId, `${w.tag}-J${++n}`, amount]
    );
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, $4, 0, 'dr'), ($1, $3, 0, $4, 'cr')`,
      [voucherId, debitAccount, creditAccount, amount]
    );
  };
  await post(cash, ids.sales, "1000");
  await post(ids.otherIncome, cash, "20"); // income refund
  await post(ids.rent, cash, "300");
  await post(cash, ids.freight, "15"); // expense refund
  await post(ids.factoryStock, cash, "50");
  await post(ids.floor, cash, "70");
  await post(cash, ids.payroll, "25");
  await post(ids.payrollAsset, cash, "5");
  return ids;
}

describe("GET /api/stats/net-profit", () => {
  it("classifies refunds, strips factory stock and payroll ledgers, and values OTW containers", async () => {
    await withFactoryWorld(async (w) => {
      const ids = await ledgerWorld(w);
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'S', 's@x.test') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      await w.q(
        `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, grand_total, items_total)
         VALUES ($1, $2, '2026-01-05', $3, 'OTW', 0, 400), ($1, $4, '2026-01-06', $3, 'OTW', 250, 999)`,
        [w.companyId, `${w.tag}C1`, supplier, `${w.tag}C2`]
      );
      const item = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bale', 'pcs') RETURNING id`,
        [w.companyId, `${w.tag}I`]
      );
      await w.q(
        `INSERT INTO inventory (company_id, stock_item_id, location_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 4, 10, 40)`,
        [w.companyId, item, w.locationId]
      );

      const res = await w.agent.get(ROUTE);
      expect(res.status).toBe(200);
      const income = res.body.income?.accounts ?? res.body.incomeAccounts;
      const expenses = res.body.expenses?.accounts ?? res.body.expensesAccounts;
      expect(income).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ids.sales, value: 1000, category: "Income" }),
          expect.objectContaining({ id: ids.otherIncome, value: -20, category: "Indirect Income (Refund)" }),
        ])
      );
      expect(expenses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ids.rent, value: 300 }),
          expect.objectContaining({ id: ids.freight, value: -15, category: expect.stringContaining("(Refund)") }),
        ])
      );
      expect(res.body.totalIncome).toBe(980);
      expect(res.body.totalExpenses).toBe(285);
      expect(res.body.netProfit).toBe(695);

      const forUs = res.body.forUs.accounts as Array<{ name: string; code?: string; value: number }>;
      expect(forUs.some((a) => a.code === "FACTORY_STOCK_IN_HAND")).toBe(false);
      expect(forUs.some((a) => a.code === "PAY_PAYABLE")).toBe(false);
      expect(res.body.onUs.accounts.some((a: { name: string }) => a.name === "Payroll Payable")).toBe(false);
      expect(forUs).toEqual(
        expect.arrayContaining([
          { name: "Stock In Hand / Stock on Floor", code: "COMPUTED", value: 110, category: "Inventory" },
          expect.objectContaining({ code: "STOCK_OTW", value: 650 }),
        ])
      );
      expect(res.body).not.toHaveProperty("spPosProfitPeriodStartDate");
    });
  });

  it("renames a single stock line, and reports the supplier-partner POS profit window", async () => {
    await withFactoryWorld(async (w) => {
      const floor = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2, 'Stock on Floor', 'Asset', 'Current Asset') RETURNING id`,
        [w.companyId, `${w.tag}SF`]
      );
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Cash', 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}C`]
      );
      const voucherId = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount) VALUES ($1, $2, 'Journal', '2026-03-10', 30) RETURNING id`,
        [w.companyId, `${w.tag}-J`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration) VALUES ($1, $2, 30, 0, 'd'), ($1, $3, 0, 30, 'c')`,
        [voucherId, floor, cash]
      );
      await w.q(
        `INSERT INTO company_settings (company_id, sp_pos_profit_baseline_date) VALUES ($1, '2026-03-15')
         ON CONFLICT (company_id) DO UPDATE SET sp_pos_profit_baseline_date = EXCLUDED.sp_pos_profit_baseline_date`,
        [w.companyId]
      );

      const erp = await w.agent.get(ROUTE).query({ toDate: "2026-03-31" });
      expect(erp.body.forUs.accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: floor, name: "Stock In Hand / Stock on Floor", value: 30 }),
        ])
      );

      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const res = await w.agent.get(ROUTE).query({ toDate: "2026-03-30" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        spPosProfit: 0,
        spPosProfitPeriodStartDate: "2026-03-15",
        spPosProfitAsOfDate: "2026-03-30",
        spPosProfitBaselineDate: "2026-03-15",
      });

      const april = await w.agent.get(ROUTE).query({ toDate: "2026-04-30" });
      expect(april.body.spPosProfitPeriodStartDate).toBe("2026-04-01");
    });
  });
});
