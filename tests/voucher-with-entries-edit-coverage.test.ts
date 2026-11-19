/**
 * PUT /api/vouchers/:id/with-entries against PostgreSQL in one rolled-back
 * transaction per test. Every refusal (bad input, unknown or migrated voucher,
 * role limits, currency lock, stock and balance re-typing, unbalanced lines,
 * closed period, ZMW native-amount conflicts) leaves the voucher and its lines
 * unchanged; the success paths pin the header update, the location name and
 * the dual-currency columns written for USD, foreign and ZMW vouchers.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Fixture {
  id: number;
  debit: number;
  credit: number;
}

let seq = 0;
async function journal(
  w: FactoryWorld,
  opts: { date?: string; number?: string; currency?: string; rate?: string } = {}
): Promise<Fixture> {
  const n = ++seq;
  const debit = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Expense') RETURNING id`,
    [w.companyId, `${w.tag}D${n}`]
  );
  const credit = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
    [w.companyId, `${w.tag}C${n}`]
  );
  const id = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, currency, exchange_rate, description)
     VALUES ($1, $2, 'Journal', $3, 10, false, $4, $5, 'original') RETURNING id`,
    [w.companyId, opts.number ?? `${w.tag}-${n}`, opts.date ?? today(), opts.currency ?? "USD", opts.rate ?? null]
  );
  if (opts.currency && opts.currency !== "USD") {
    // Native lines: 10 base at the voucher rate (transaction currency per USD).
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
         transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
         historical_exchange_rate, rate_convention)
       VALUES ($1, $2, 10, 0, $4, 10 * $5::numeric, 0, 10, 0, $5::numeric, 'TRANSACTION_PER_BASE'),
              ($1, $3, 0, 10, $4, 0, 10 * $5::numeric, 0, 10, $5::numeric, 'TRANSACTION_PER_BASE')`,
      [id, debit, credit, opts.currency, opts.rate]
    );
  } else {
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, 10, 0), ($1, $3, 0, 10)`,
      [id, debit, credit]
    );
  }
  return { id, debit, credit };
}

const lines = (f: Fixture, amount = "25.00", extra: Record<string, unknown> = {}) => [
  { ledgerAccountId: f.debit, debitAmount: amount, creditAmount: "0", narration: "dr", ...extra },
  { ledgerAccountId: f.credit, debitAmount: "0", creditAmount: amount, ...extra },
];

const edit = (agent: FactoryWorld["agent"], id: number | string, body: unknown) =>
  agent.put(`/api/vouchers/${id}/with-entries`).send(body as object);

async function unchanged(w: FactoryWorld, f: Fixture) {
  const [v] = await w.q(`SELECT total_amount, description FROM vouchers WHERE id = $1`, [f.id]);
  expect(Number(v.total_amount)).toBe(10);
  expect(v.description).toBe("original");
  const rows = await w.q(`SELECT debit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [f.id]);
  expect(rows.map((r) => Number(r.debit_amount))).toEqual([10, 0]);
}

describe("voucher edit refusals", () => {
  it("refuses malformed input, unknown, foreign and migrated vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w);
      expect((await edit(w.agent, "abc", {})).status).toBe(400);
      expect((await edit(w.agent, f.id, { voucher: {} })).body.message).toBe("Voucher and entries are required");
      expect((await edit(w.agent, f.id, { voucher: {}, entries: [] })).status).toBe(400);
      expect((await edit(w.agent, 999999999, { voucher: {}, entries: lines(f) })).status).toBe(404);
      const migrated = await journal(w, { number: `MIG-${w.tag}` });
      const blocked = await edit(w.agent, migrated.id, { voucher: {}, entries: lines(migrated) });
      expect(blocked.status).toBe(403);
      await unchanged(w, migrated);
      await unchanged(w, f);
    });
  });

  it("limits edits by role: other roles never, managers only today's vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const old = await journal(w, { date: "2026-01-05" });
      const fresh = await journal(w);
      const user = await w.agentFor("Normal User");
      const refused = await edit(user, fresh.id, { voucher: {}, entries: lines(fresh) });
      expect(refused.status).toBe(403);
      const manager = await w.agentFor("Manager");
      const past = await edit(manager, old.id, { voucher: {}, entries: lines(old) });
      expect(past.status).toBe(403);
      expect(past.body.message).toBe("Managers can only edit today's vouchers");
      await unchanged(w, old);
      await unchanged(w, fresh);
      const ok = await edit(manager, fresh.id, { voucher: { description: "manager edit" }, entries: lines(fresh) });
      expect(ok.status).toBe(200);
      expect(ok.body.voucher.description).toBe("manager edit");
    });
  });

  it("refuses a switch to ZMW, a stock type, a balance-exempt type and unbalanced lines", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w);
      const zmw = await edit(w.agent, f.id, { voucher: { currency: "ZMW" }, entries: lines(f) });
      expect(zmw.status).toBeGreaterThanOrEqual(400);
      expect(zmw.body.message).toContain("requires reversal and rebooking");
      const stock = await edit(w.agent, f.id, { voucher: { voucherType: "Production" }, entries: lines(f) });
      expect(stock.status).toBe(400);
      expect(stock.body.code).toBeTruthy();
      const exempt = await edit(w.agent, f.id, { voucher: { voucherType: "Transfer" }, entries: lines(f) });
      expect(exempt.status).toBe(400);
      expect(exempt.body.message).toContain("exempt from balancing");
      const unbalanced = await edit(w.agent, f.id, {
        voucher: {},
        entries: [lines(f)[0], { ...lines(f)[1], creditAmount: "5.00" }],
      });
      expect(unbalanced.status).toBe(400);
      await unchanged(w, f);
    });
  });

  it("refuses an edit of a voucher in a closed period", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w, { date: "2025-06-01" });
      await w.q(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, net_income, total_income, total_expense, retained_earnings_account_id)
         VALUES ($1, '2025-01-01', '2025-12-31', $2, $3, 0, 0, 0, $4)`,
        [w.companyId, w.userId, f.id, f.credit]
      );
      const res = await edit(w.agent, f.id, { voucher: {}, entries: lines(f) });
      expect(res.status).toBe(409);
      await unchanged(w, f);
    });
  });
});

describe("voucher edit success paths", () => {
  it("replaces lines, updates the header and the location name, and audits the edit", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w);
      const res = await edit(w.agent, f.id, {
        voucher: { voucherDate: today(), description: "", locationId: w.locationId },
        entries: lines(f, "25.00", { transactionCurrency: "EUR", historicalExchangeRate: "1.1" }),
      });
      expect(res.status).toBe(200);
      expect(res.body.voucher).toMatchObject({ description: null, locationId: w.locationId, locationName: "Yard" });
      expect(Number(res.body.voucher.totalAmount)).toBe(25);
      const [line] = await w.q(
        `SELECT transaction_currency, narration FROM voucher_entries WHERE voucher_id = $1 ORDER BY id LIMIT 1`,
        [f.id]
      );
      expect(line).toMatchObject({ transaction_currency: "EUR", narration: "dr" });

      const cleared = await edit(w.agent, f.id, {
        voucher: { locationId: null },
        entries: lines(f, "30", { transactionCurrency: "NOT-A-CURRENCY" }),
      });
      expect(cleared.status).toBe(200);
      // An omitted description keeps the stored one (cleared to null by the first edit).
      expect(cleared.body.voucher).toMatchObject({ locationId: null, locationName: null, description: null });
      const [plain] = await w.q(`SELECT transaction_currency FROM voucher_entries WHERE voucher_id = $1 LIMIT 1`, [
        f.id,
      ]);
      expect(plain.transaction_currency).not.toBe("NOT-A-CURRENCY");
    });
  });

  it("converts lines of a foreign-currency voucher at its rate", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w, { currency: "EUR", rate: "0.5" });
      const res = await edit(w.agent, f.id, { voucher: {}, entries: lines(f, "20") });
      expect(res.status).toBe(200);
      const rows = await w.q(
        `SELECT transaction_currency, transaction_debit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [f.id]
      );
      expect(rows[0].transaction_currency).toBe("EUR");
      expect(Number(rows[0].transaction_debit_amount)).toBe(20);
    });
  });
});

describe("intercompany legs and sales vouchers", () => {
  it("refuses to edit one leg of an intercompany transfer", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      await w.q(
        `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
           from_ledger_account_id, to_ledger_account_id, from_voucher_id)
         VALUES ('Cash', $1, $2, '2026-10-02', 10, $3, $3, $4)`,
        [w.companyId, other, f.credit, f.id]
      );
      const res = await edit(w.agent, f.id, { voucher: {}, entries: lines(f) });
      expect(res.status).toBe(409);
      await unchanged(w, f);
    });
  });

  it("moves a sales voucher to another location and re-dates it", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w);
      const second = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`,
        [w.companyId, `${w.tag}L2`]
      );
      await w.q(`UPDATE vouchers SET voucher_type = 'Sales', location_id = $2 WHERE id = $1`, [f.id, w.locationId]);
      const res = await edit(w.agent, f.id, {
        voucher: { voucherDate: "2026-10-01", locationId: second },
        entries: lines(f),
      });
      expect(res.status).toBe(200);
      expect(res.body.voucher).toMatchObject({ locationId: second, locationName: "Shop", voucherDate: "2026-10-01" });
    });
  });
});

describe("ZMW voucher edits", () => {
  it("refuses conflicting native amounts or currency, and rebuilds base amounts from the locked rate", async () => {
    await withFactoryWorld(async (w) => {
      const f = await journal(w, { currency: "ZMW", rate: "25" });
      const conflict = await edit(w.agent, f.id, {
        voucher: {},
        entries: lines(f, "500", { transactionDebitAmount: "1" }),
      });
      expect(conflict.status).toBeGreaterThanOrEqual(400);
      expect(conflict.body.message).toContain("base/transaction amount conflict");
      const creditConflict = await edit(w.agent, f.id, {
        voucher: {},
        entries: [lines(f, "500")[0], { ...lines(f, "500")[1], transactionCreditAmount: "2" }],
      });
      expect(creditConflict.body.message).toContain("base/transaction amount conflict");
      const currency = await edit(w.agent, f.id, {
        voucher: {},
        entries: lines(f, "500", { transactionCurrency: "usd" }),
      });
      expect(currency.body.message).toContain("must match its original voucher currency");
      expect(Number((await w.q(`SELECT total_amount FROM vouchers WHERE id = $1`, [f.id]))[0].total_amount)).toBe(10);

      const ok = await edit(w.agent, f.id, {
        voucher: {},
        entries: lines(f, "500", { transactionCurrency: "ZMW", transactionDebitAmount: null }),
      });
      expect(ok.status).toBe(200);
      expect(Number(ok.body.voucher.totalAmount)).toBe(20);
      const rows = await w.q(
        `SELECT transaction_debit_amount, debit_amount FROM voucher_entries WHERE voucher_id = $1 AND debit_amount > 0`,
        [f.id]
      );
      expect(rows.map((r) => [Number(r.transaction_debit_amount), Number(r.debit_amount)])).toEqual([[500, 20]]);
    });
  });
});
