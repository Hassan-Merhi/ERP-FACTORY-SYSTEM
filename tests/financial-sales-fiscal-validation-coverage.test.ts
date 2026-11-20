/**
 * server/routes/financialSalesRoutes.ts over HTTP against PostgreSQL, one
 * rolled-back company per test.
 *
 * Pinned: fiscal close refuses non-admin roles, missing fields, a
 * non-numeric account, bad or reversed dates, an unknown, non-Equity or
 * other-company retained earnings account, all without writing a closure;
 * reopen refuses non-admins, bad ids, a blank reason and an unknown closure.
 * The sales summary folds credit sales into one "Credit Sales" group, merges
 * cash and credit rows per location and skips location-less cash sales; the
 * per-location details and transactions validate the id, honour date ranges,
 * list the credit-sales group under -1 and name the cash account used.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item, nextSeq, otherCompany } from "./helpers/voucherReadFixture";

async function equity(w: FactoryWorld, companyId = w.companyId, type = "Equity") {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
    [companyId, `${w.tag}RE${nextSeq()}`, type]
  );
}

const closures = (w: FactoryWorld) => w.q(`SELECT id FROM fiscal_period_closures WHERE company_id = $1`, [w.companyId]);

describe("fiscal period close and reopen validation", () => {
  it("refuses every malformed close without writing a closure", () =>
    withFactoryWorld(async (w) => {
      const good = await equity(w);
      const asset = await equity(w, w.companyId, "Asset");
      const foreign = await equity(w, await otherCompany(w));
      const base = { periodStartDate: "2026-01-01", periodEndDate: "2026-03-31", retainedEarningsAccountId: good };
      const cases: Array<[Record<string, unknown>, number, RegExp]> = [
        [{ ...base, periodEndDate: undefined }, 400, /are required/],
        [{ ...base, retainedEarningsAccountId: "abc" }, 400, /Invalid retained earnings account ID/],
        [{ ...base, periodStartDate: "not-a-date" }, 400, /Invalid date format/],
        [{ ...base, periodStartDate: "2026-04-01" }, 400, /before or equal/],
        [{ ...base, retainedEarningsAccountId: 999999999 }, 400, /not found/],
        [{ ...base, retainedEarningsAccountId: asset }, 400, /must be an Equity account/],
        [{ ...base, retainedEarningsAccountId: foreign }, 403, /different company/],
      ];
      for (const [body, status, message] of cases) {
        const res = await w.agent.post("/api/fiscal-period/close").send(body);
        expect(res.status, JSON.stringify(body)).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await closures(w)).toEqual([]);

      const manager = await w.agentFor("Manager");
      expect((await manager.post("/api/fiscal-period/close").send(base)).status).toBe(403);
      expect((await manager.post("/api/fiscal-period/1/reopen").send({ reason: "x" })).status).toBe(403);
    }));

  it("refuses a bad closure id, a blank reason and an unknown closure on reopen", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/fiscal-period/abc/reopen").send({ reason: "fix" })).status).toBe(400);
      expect((await w.agent.post("/api/fiscal-period/0/reopen").send({ reason: "fix" })).status).toBe(400);
      const blank = await w.agent.post("/api/fiscal-period/5/reopen").send({ reason: "   " });
      expect(blank.status).toBe(400);
      expect(blank.body.message).toMatch(/reason is required/);
      const noReason = await w.agent.post("/api/fiscal-period/5/reopen").send({});
      expect(noReason.status).toBe(400);
      const unknown = await w.agent.post("/api/fiscal-period/999999999/reopen").send({ reason: "Correction" });
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      expect(unknown.status).toBeLessThan(500);
      expect((await w.agent.get("/api/fiscal-period/closures")).body).toEqual([]);
    }));
});

describe("fiscal period closures read", () => {
  it("answers 503 when the closures table or a column is missing (DDL rolled back with the test)", () =>
    withFactoryWorld(async (w) => {
      for (const ddl of [
        `ALTER TABLE fiscal_period_closures RENAME COLUMN notes TO notes_hidden`,
        `ALTER TABLE fiscal_period_closures RENAME TO fiscal_period_closures_hidden`,
      ]) {
        await w.q(`SAVEPOINT closures_schema`);
        await w.q(ddl);
        const res = await w.agent.get("/api/fiscal-period/closures");
        await w.q(`ROLLBACK TO SAVEPOINT closures_schema`);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe("FISCAL_PERIOD_SCHEMA_OUTDATED");
      }
      expect((await w.agent.get("/api/fiscal-period/closures")).status).toBe(200);
    }));
});

async function sale(
  w: FactoryWorld,
  stockItemId: number,
  opts: { locationId?: number | null; credit?: boolean; date?: string; total: string; cashAccount?: number }
) {
  const v = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, is_credit_sale)
     VALUES ($1, $2, 'Sales', $3, $4, $5, $6) RETURNING id`,
    [
      w.companyId,
      `${w.tag}S${nextSeq()}`,
      opts.date ?? "2026-05-10",
      opts.total,
      opts.locationId ?? null,
      !!opts.credit,
    ]
  );
  await w.q(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, total_sales, cost_price, total_cost, profit)
     VALUES ($1, $2, 2, $3::numeric / 2, $3, 1, 2, $3::numeric - 2)`,
    [v, stockItemId, opts.total]
  );
  if (opts.cashAccount) {
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, 0)`,
      [v, opts.cashAccount, opts.total]
    );
  }
  return v;
}

describe("financial sales", () => {
  it("groups credit sales, merges per-location rows and skips location-less cash sales", () =>
    withFactoryWorld(async (w) => {
      const product = await item(w, "Shirts");
      const blank = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, '') RETURNING id`, [
        w.companyId,
        `${w.tag}B`,
      ]);
      await sale(w, product, { locationId: w.locationId, total: "10" });
      await sale(w, product, { locationId: w.locationId, total: "15" });
      await sale(w, product, { locationId: w.locationId, credit: true, total: "20" });
      await sale(w, product, { locationId: blank, credit: true, total: "5" });
      await sale(w, product, { locationId: blank, total: "7" });
      await sale(w, product, { total: "99" });
      await sale(w, product, { locationId: w.locationId, total: "1000", date: "2025-01-01" });

      const res = await w.agent.get("/api/financial/sales").query({ startDate: "2026-01-01", endDate: "2026-12-31" });
      expect(res.status).toBe(200);
      const byId = new Map(res.body.map((r: { locationId: number }) => [r.locationId, r]));
      expect(byId.get(w.locationId)).toMatchObject({ locationName: "Yard", totalSales: 25, totalTransactions: 2 });
      expect(byId.get(blank)).toMatchObject({ locationName: "Unknown", totalSales: 7 });
      expect(byId.get(-1)).toMatchObject({ locationName: "Credit Sales", totalSales: 25, totalTransactions: 2 });
      expect(res.body).toHaveLength(3);
      const all = await w.agent.get("/api/financial/sales");
      expect(all.body.find((r: { locationId: number }) => r.locationId === w.locationId).totalSales).toBe(1025);
    }));

  it("reports per-location details and transactions with cash accounts", () =>
    withFactoryWorld(async (w) => {
      const product = await item(w, "Shoes");
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Till One', 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}TILL`]
      );
      const withCash = await sale(w, product, { locationId: w.locationId, total: "30", cashAccount: cash });
      await sale(w, product, { locationId: w.locationId, total: "12", date: "2026-04-01" });
      const credit = await sale(w, product, { credit: true, total: "40" });

      expect((await w.agent.get("/api/financial/sales/abc/details")).status).toBe(400);
      const details = await w.agent
        .get(`/api/financial/sales/${w.locationId}/details`)
        .query({ startDate: "2026-05-01", endDate: "2026-05-31" });
      expect(details.body).toEqual({
        locationId: w.locationId,
        totalQuantity: 1,
        totalAmount: 30,
        totalTransactions: 1,
      });

      expect((await w.agent.get("/api/financial/sales/abc/transactions")).status).toBe(400);
      const txns = await w.agent
        .get(`/api/financial/sales/${w.locationId}/transactions`)
        .query({ startDate: "2026-05-01", endDate: "2026-05-31" });
      expect(txns.body).toEqual([
        expect.objectContaining({
          id: withCash,
          cashAccountName: "Till One",
          totalAmount: 30,
          totalQuantity: 2,
          itemCount: 1,
        }),
      ]);
      const allLocation = await w.agent.get(`/api/financial/sales/${w.locationId}/transactions`);
      expect(allLocation.body.map((t: { cashAccountName: string | null }) => t.cashAccountName)).toEqual([
        "Till One",
        null,
      ]);
      const creditGroup = await w.agent.get("/api/financial/sales/-1/transactions");
      expect(creditGroup.body.map((t: { id: number }) => t.id)).toEqual([credit]);
      const none = await w.agent
        .get(`/api/financial/sales/${w.locationId}/transactions`)
        .query({ startDate: "2030-01-01" });
      expect(none.body).toEqual([]);
    }));

  it("returns nothing for another company's location id", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
        [other, `${w.tag}FAR`]
      );
      const details = await w.agent.get(`/api/financial/sales/${foreign}/details`);
      const txns = await w.agent.get(`/api/financial/sales/${foreign}/transactions`);
      // Not refused, but every query is company-scoped, so nothing of the other company is returned.
      expect(details.status).toBe(200);
      expect(details.body).toEqual({ locationId: foreign, totalQuantity: 0, totalAmount: 0, totalTransactions: 0 });
      expect(txns.status).toBe(200);
      expect(txns.body).toEqual([]);
    }));
});
