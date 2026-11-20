/**
 * Chat report phase 5 cases (profit by location, daily report, ledger account
 * balance, cash flow summary, stock transfers) run against PostgreSQL in one
 * rolled-back transaction per test. All five are routed to the phase 5 shard
 * by the report registry.
 *
 * Pinned: company scoping, date windows, deleted / optional vouchers left out,
 * running balances with sideless openings, and the empty answers.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  runPhase5CashFlowSummary,
  runPhase5DailyReport,
  runPhase5LedgerAccountBalance,
  runPhase5ProfitByLocation,
  runPhase5StockTransfers,
} from "../server/chat/reports/implementations/phase5ReportCases2";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);
const window = { dateFrom: "2026-06-01", dateTo: "2026-06-30" };
let seq = 0;

async function voucher(
  w: FactoryWorld,
  type: string,
  date: string,
  total: string,
  extra: { locationId?: number | null; deleted?: boolean; optional?: boolean; description?: string | null } = {}
) {
  const id = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, optional, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      w.companyId,
      `${w.tag}V${++seq}`,
      type,
      date,
      total,
      extra.locationId ?? null,
      extra.optional ?? false,
      extra.description ?? null,
    ]
  );
  if (extra.deleted) await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [id]);
  return id;
}

const ledger = (w: FactoryWorld, name: string, type: string, opening = "0", side: string | null = null) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [w.companyId, `${w.tag}L${++seq}`, name, type, opening, side]
  );
const entry = (w: FactoryWorld, voucherId: number, ledgerId: number, dr: string, cr: string) =>
  w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
    [voucherId, ledgerId, dr, cr]
  );
const stockItem = (w: FactoryWorld, name: string) =>
  w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'PCS') RETURNING id`, [
    w.companyId,
    `${w.tag}I${++seq}`,
    name,
  ]);

describe("profit by location", () => {
  it("groups live sales by location with margins and a total row", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt, ...window };
      expect(await runPhase5ProfitByLocation(base)).toMatchObject({ noData: true, stats: expect.any(Array) });
      const item = await stockItem(w, "Bales");
      const sale = async (
        locationId: number | null,
        sales: string,
        cost: string,
        date = "2026-06-10",
        deleted = false
      ) => {
        const v = await voucher(w, "Sales", date, sales, { locationId, deleted });
        await w.q(
          `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
           VALUES ($1, $2, 1, $3, $4, $3, $4, $3::numeric - $4::numeric)`,
          [v, item, sales, cost]
        );
      };
      await sale(w.locationId, "100", "60");
      await sale(null, "50", "50");
      await sale(w.locationId, "999", "1", "2026-07-02");
      await sale(w.locationId, "999", "1", "2026-06-11", true);
      const res = await runPhase5ProfitByLocation(base);
      expect(res.table.rows).toEqual([
        ["Yard", "1", "100.00", "60.00", "40.00", "40.0%"],
        ["Unassigned", "1", "50.00", "50.00", "0.00", "0.0%"],
        ["TOTAL", "", "150.00", "110.00", "40.00", "26.7%"],
      ]);
      expect(res.stats).toContainEqual({ label: "Best Location", value: "Yard" });
    }));
});

describe("daily report", () => {
  it("lists one day's live vouchers by type with totals", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt, todayStr: "2026-06-15" };
      expect(await runPhase5DailyReport({ ...base, params: { queryType: "daily_report" } })).toMatchObject({
        noData: true,
        title: "Daily Report: 2026-06-15",
      });
      await voucher(w, "Receipt", "2026-06-05", "30", { locationId: w.locationId, description: "Cash in" });
      await voucher(w, "Receipt", "2026-06-05", "20");
      await voucher(w, "Payment", "2026-06-05", "5");
      await voucher(w, "Payment", "2026-06-05", "500", { optional: true });
      await voucher(w, "Payment", "2026-06-05", "700", { deleted: true });
      const res = await runPhase5DailyReport({ ...base, params: { queryType: "x", dateFrom: "2026-06-05" } });
      expect(res.table.rows.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([
        ["Payment", "", "—", "5.00"],
        ["Receipt", "Cash in", "Yard", "30.00"],
        ["Receipt", "", "—", "20.00"],
      ]);
      expect(res.stats).toEqual(
        expect.arrayContaining([
          { label: "Grand Total", value: "55.00", highlight: "positive" },
          { label: "Receipt", value: "50.00" },
          { label: "Payment", value: "5.00" },
        ])
      );
    }));
});

describe("ledger account balance", () => {
  it("asks for an account, reports an unknown one and runs a balance from the opening", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt, ...window };
      expect(await runPhase5LedgerAccountBalance({ ...base, params: { queryType: "x" } })).toMatchObject({
        summary: "Please specify an account name.",
      });
      expect(
        await runPhase5LedgerAccountBalance({ ...base, params: { queryType: "x", entityName: "Nowhere" } })
      ).toMatchObject({ summary: 'No account found matching "Nowhere".' });

      const sales = await ledger(w, "Sales Income", "Income", "100", null);
      const v1 = await voucher(w, "Receipt", "2026-06-02", "30", { description: "First" });
      await entry(w, v1, sales, "30", "0");
      const v2 = await voucher(w, "Sales", "2026-06-03", "200");
      await entry(w, v2, sales, "0", "200");
      const late = await voucher(w, "Sales", "2026-07-03", "999");
      await entry(w, late, sales, "0", "999");
      const res = await runPhase5LedgerAccountBalance({
        ...base,
        params: { queryType: "x", locationName: "sales inc" },
      });
      // A sideless Income opening sits on the credit side.
      expect(res.table!.rows.map((r) => [r[4], r[5], r[6]])).toEqual([
        ["30.00", "—", "70.00 Cr"],
        ["—", "200.00", "270.00 Cr"],
      ]);
      expect(res.stats![0].value).toMatch(/ — Sales Income$/);

      const cash = await ledger(w, "Petty Cash", "Cash", "10", "Dr");
      const v3 = await voucher(w, "Payment", "2026-06-04", "5");
      await entry(w, v3, cash, "0", "5");
      const petty = await runPhase5LedgerAccountBalance({ ...base, params: { queryType: "x", entityName: "petty" } });
      expect(petty.stats![4]).toMatchObject({ value: "5.00 Dr" });
    }));
});

describe("cash flow summary", () => {
  it("sums bank and cash movements only and signs a net outflow", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, fmt, ...window };
      const empty = await runPhase5CashFlowSummary(base);
      expect(empty.noData).toBe(true);
      const cash = await ledger(w, "Till", "Cash");
      const bank = await ledger(w, "Main Bank", " Bank ");
      const rent = await ledger(w, "Rent", "Expense");
      const v1 = await voucher(w, "Receipt", "2026-06-02", "40");
      await entry(w, v1, cash, "40", "0");
      const v2 = await voucher(w, "Payment", "2026-06-03", "90");
      await entry(w, v2, bank, "0", "90");
      await entry(w, v2, rent, "90", "0");
      const res = await runPhase5CashFlowSummary(base);
      expect(res.table.rows).toEqual([
        ["Till", "Cash", "40.00", "0.00", "40.00", "1"],
        ["Main Bank", " Bank ", "0.00", "90.00", "(90.00)", "1"],
        ["TOTAL", "", "40.00", "90.00", "(50.00)", ""],
      ]);
      expect(res.stats[2]).toEqual({ label: "Net Position", value: "(50.00)", highlight: "negative" });
    }));
});

describe("stock transfers", () => {
  it("lists live transfers in the window and filters by location name", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt, fmtDec, ...window };
      expect(await runPhase5StockTransfers({ ...base, params: { queryType: "stock_transfers" } })).toMatchObject({
        noData: true,
        title: "Stock Transfers",
      });
      const store = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Store') RETURNING id`,
        [w.companyId, `${w.tag}ST`]
      );
      const item = await stockItem(w, "Bales");
      const transfer = async (date: string, source: number | null, deleted = false) => {
        const v = await voucher(w, "Stock Transfer", date, "60", { deleted });
        const t = await w.one(
          `INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2) RETURNING id`,
          [v, store]
        );
        await w.q(
          `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, source_location_id, quantity, rate, total_amount)
           VALUES ($1, $2, $3, 3, 20, 60)`,
          [t, item, source]
        );
      };
      await transfer("2026-06-05", w.locationId);
      await transfer("2026-06-06", null);
      await transfer("2026-06-07", w.locationId, true);
      await transfer("2026-07-07", w.locationId);
      const all = await runPhase5StockTransfers({ ...base, params: { queryType: "x" } });
      expect(all.table.rows.map((r) => [r[0], r[3], r[4], r[5], r[6]])).toEqual([
        ["2026-06-06", "3.000 PCS", "—", "Store", "60.00"],
        ["2026-06-05", "3.000 PCS", "Yard", "Store", "60.00"],
      ]);
      expect(all.subtitle).toMatch(/Total value transferred: 120.00$/);
      const yard = await runPhase5StockTransfers({ ...base, params: { queryType: "x", locationName: "yard" } });
      expect([yard.title, yard.table.rows.length]).toEqual(["Stock Transfers: yard", 1]);
    }));
});
