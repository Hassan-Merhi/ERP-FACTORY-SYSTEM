/**
 * PATCH /api/voucher-entries/:id (voucherEntryCurrencyEditRoutes) through the
 * real app inside one rolled-back transaction: id and company checks, locked
 * vouchers, role/date refusals, narration-only edits, intercompany legs,
 * Kwacha currency/rate locks, legacy foreign lines, unbalancing edits and
 * closed periods. Every refusal leaves the line untouched.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const patch = (w: FactoryWorld, id: number | string, body: Record<string, unknown>, agent = w.agent) =>
  agent.patch(`/api/voucher-entries/${id}`).send(body);

interface Opts {
  companyId?: number;
  number?: string;
  currency?: string;
  rate?: string | null;
  date?: string;
  sourceModule?: string | null;
  /** false: a legacy foreign line with no native amounts, currency or rate. */
  native?: boolean;
}

async function journal(w: FactoryWorld, opts: Opts = {}) {
  const companyId = opts.companyId ?? w.companyId;
  const account = (code: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, active) VALUES ($1, $2::varchar, $2::text, 'Expense', true) RETURNING id`,
      [companyId, `${w.tag}${code}${Math.floor(Math.random() * 1e6)}`]
    );
  const debit = await account("D");
  const credit = await account("K");
  const id = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, source_module)
     VALUES ($1, $2, 'Journal', $3::date, 100, $4, $5, $6) RETURNING id`,
    [
      companyId,
      opts.number ?? `${w.tag}-J${Math.floor(Math.random() * 1e6)}`,
      opts.date ?? "2026-05-01",
      opts.currency ?? "USD",
      opts.rate ?? null,
      opts.sourceModule ?? null,
    ]
  );
  const foreign = (opts.currency ?? "USD") !== "USD";
  // Foreign lines are written as they stand in history (native amounts and
  // rate as given, or missing), so the normalising trigger is bypassed for
  // this insert only; the whole world is rolled back afterwards.
  if (foreign) await w.q(`SET LOCAL session_replication_role = replica`);
  const [line] = await w.q<{ id: number }>(
    `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration,
       transaction_currency, transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
       historical_exchange_rate, rate_convention)
     VALUES ($1, $4, $2, 100, 0, 'first', $5, $6, 0, 100, 0, $7, $8),
            ($1, $4, $3, 0, 100, 'second', $5, 0, $6, 0, 100, $7, $8) RETURNING id`,
    [
      id,
      debit,
      credit,
      companyId,
      foreign ? (opts.native === false ? null : opts.currency) : "USD",
      foreign ? (opts.native === false ? null : String(100 * Number(opts.rate ?? 1))) : "100",
      foreign ? (opts.native === false ? null : opts.rate) : "1",
      foreign ? (opts.native === false ? null : "TRANSACTION_PER_BASE") : "IDENTITY",
    ]
  );
  if (foreign) await w.q(`SET LOCAL session_replication_role = origin`);
  return { id, line: Number(line.id), debit, credit };
}

const lineOf = async (w: FactoryWorld, id: number) =>
  (
    await w.q(
      `SELECT debit_amount::text AS debit, credit_amount::text AS credit, narration, transaction_currency,
              transaction_debit_amount::text AS tx_debit, historical_exchange_rate::text AS rate
         FROM voucher_entries WHERE id = $1`,
      [id]
    )
  )[0];

describe("voucher entry currency edit", () => {
  it("validates the id and hides other companies' lines", () =>
    withFactoryWorld(async (w) => {
      expect((await patch(w, "abc", { narration: "x" })).status).toBe(400);
      expect((await patch(w, 0, { narration: "x" })).status).toBe(400);
      expect((await patch(w, 2147483000, { narration: "x" })).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await journal(w, { companyId: other });
      const before = await lineOf(w, theirs.line);
      const res = await patch(w, theirs.line, { narration: "hijack", debitAmount: "5" });
      expect(res.status).toBe(404);
      expect(await lineOf(w, theirs.line)).toEqual(before);
    }));

  it("refuses locked vouchers and roles that may not edit", () =>
    withFactoryWorld(async (w) => {
      for (const opts of [
        { number: `MIG-${w.tag}` },
        { number: `GC-${w.tag}` },
        { sourceModule: "INTERCOMPANY_CONTAINER" },
        { sourceModule: "SP_MIGRATION_READONLY" },
      ]) {
        const f = await journal(w, opts);
        const res = await patch(w, f.line, { narration: "nope" });
        expect(res.status, JSON.stringify(opts)).toBe(403);
        expect((await lineOf(w, f.line)).narration).toBe("first");
      }
      const f = await journal(w, { date: "2026-01-02" });
      const manager = await w.agentFor("Manager");
      const old = await patch(w, f.line, { narration: "late" }, manager);
      expect(old.status).toBe(403);
      expect(old.body.message).toBe("Insufficient permissions to edit this voucher entry");
      const user = await w.agentFor("Normal User");
      expect((await patch(w, f.line, { narration: "late" }, user)).status).toBe(403);
      expect((await lineOf(w, f.line)).narration).toBe("first");

      const today = new Date().toISOString().slice(0, 10);
      const fresh = await journal(w, { date: today });
      const ok = await patch(w, fresh.line, { narration: "same day" }, manager);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    }));

  it("edits the narration alone with an audit record, and rejects an empty edit", () =>
    withFactoryWorld(async (w) => {
      const f = await journal(w);
      const empty = await patch(w, f.line, {});
      expect(empty.status).toBe(400);
      expect(empty.body.message).toBe("No supported updates supplied");
      const res = await patch(w, f.line, { narration: "renamed" });
      expect(res.status).toBe(200);
      expect(res.body.narration).toBe("renamed");
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'voucher_entries' AND record_id = $1 AND action = 'update'`,
        [f.line]
      );
      expect(audit).toEqual([{ action: "update" }]);
    }));

  it("refuses amount edits on an intercompany transfer leg", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}P`,
      ]);
      const f = await journal(w);
      const g = await journal(w, { companyId: other });
      await w.q(
        `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
           from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id)
         VALUES ('Cash', $1, $2, '2026-05-01', 100, $3, $4, $5, $6)`,
        [w.companyId, other, f.debit, g.debit, f.id, g.id]
      );
      const res = await patch(w, f.line, { debitAmount: "90" });
      expect(res.status).toBe(409);
      expect((await lineOf(w, f.line)).debit).toBe("100.00");
    }));

  it("locks the currency, rate and native amounts of Kwacha lines", () =>
    withFactoryWorld(async (w) => {
      const f = await journal(w, { currency: "ZMW", rate: "25" });
      const before = await lineOf(w, f.line);
      const currency = await patch(w, f.line, { transactionCurrency: "usd", debitAmount: "1" });
      expect(currency.body.code).toBe("ZMW_ENTRY_CURRENCY_LOCKED");
      const rate = await patch(w, f.line, { historicalExchangeRate: "30" });
      expect(rate.status).toBe(409);
      expect(rate.body.code).toBe("ZMW_ENTRY_RATE_LOCKED");
      expect(await lineOf(w, f.line)).toEqual(before);

      const eurLine = await journal(w, { currency: "ZMW", rate: "25" });
      await w.q(`SET LOCAL session_replication_role = replica`);
      await w.q(`UPDATE voucher_entries SET transaction_currency = 'EUR' WHERE id = $1`, [eurLine.line]);
      await w.q(`SET LOCAL session_replication_role = origin`);
      expect((await patch(w, eurLine.line, { debitAmount: "1" })).body.code).toBe("ZMW_ENTRY_CURRENCY_LOCKED");

      const noRate = await journal(w, { currency: "ZMW", rate: null, native: false });
      expect((await patch(w, noRate.line, { debitAmount: "1" })).body.code).toBe("ZMW_ENTRY_RATE_LOCKED");

      const noNative = await journal(w, { currency: "ZMW", rate: "25" });
      await w.q(`SET LOCAL session_replication_role = replica`);
      await w.q(
        `UPDATE voucher_entries SET transaction_debit_amount = NULL, transaction_credit_amount = NULL WHERE id = $1`,
        [noNative.line]
      );
      await w.q(`SET LOCAL session_replication_role = origin`);
      const unresolved = await patch(w, noNative.line, { debitAmount: "1" });
      expect([unresolved.status, unresolved.body.code]).toEqual([409, "ZMW_ENTRY_NATIVE_AMOUNT_UNRESOLVED"]);
    }));

  it("refuses an amount on a legacy foreign line without a transaction amount", () =>
    withFactoryWorld(async (w) => {
      const f = await journal(w, { currency: "EUR", rate: "1.1", native: false });
      const before = await lineOf(w, f.line);
      const res = await patch(w, f.line, { debitAmount: "50" });
      expect([res.status, res.body.code]).toEqual([409, "HISTORICAL_CURRENCY_DATA_UNRESOLVED"]);
      expect(await lineOf(w, f.line)).toEqual(before);
    }));

  it("refuses an edit that unbalances the voucher, a bad rate, and a closed period", () =>
    withFactoryWorld(async (w) => {
      const f = await journal(w);
      const before = await lineOf(w, f.line);
      const unbalanced = await patch(w, f.line, { debitAmount: "120" });
      expect(unbalanced.status).toBe(400);
      expect(await lineOf(w, f.line)).toEqual(before);

      const eur = await journal(w, { currency: "EUR", rate: "1.1" });
      const badRate = await patch(w, eur.line, { transactionDebitAmount: "10", historicalExchangeRate: "-3" });
      expect(badRate.status).toBe(400);

      const same = await patch(w, f.line, { debitAmount: "100", narration: "kept" });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(same.body.narration).toBe("kept");

      const closed = await journal(w, { date: "2025-06-01" });
      await w.q(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, net_income, total_income, total_expense, retained_earnings_account_id)
         VALUES ($1, '2025-01-01', '2025-12-31', $2, $3, 0, 0, 0, $4)`,
        [w.companyId, w.userId, closed.id, closed.credit]
      );
      const locked = await patch(w, closed.line, { debitAmount: "100" });
      expect(locked.status).toBe(409);
    }));
});
