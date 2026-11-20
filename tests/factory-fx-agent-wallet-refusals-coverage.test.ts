/**
 * FX agent wallet activation, rebaseline and conversion refusals
 * (server/routes/factory/fxAgentWalletRoutes.ts), one rolled-back transaction
 * per test through the full HTTP stack.
 *
 * Pinned: every refusal leaves no wallet, no operation and an unchanged
 * opening; another company's ledger account and wallet are refused; a reused
 * conversion key with different terms is refused while an identical one
 * replays; rebaseline checks the stale-screen figures and writes an audit row.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const TODAY = "2026-03-10";

async function account(w: FactoryWorld, code: string, type = "Asset", opening = "100", currency: string | null = null) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, opening_balance_currency)
     VALUES ($1, $2, $3, $4, $5, 'Dr', $6) RETURNING id`,
    [w.companyId, `${w.tag}${code}`, `FX ${code}`, type, opening, currency]
  );
}

const activate = (w: FactoryWorld, body: Record<string, unknown>) =>
  w.agent
    .post("/api/factory/fx-agent-wallets")
    .set("X-Client-Date", TODAY)
    .send({ confirmUsdSource: true, ...body });

async function wallet(w: FactoryWorld, opening = "100") {
  const ledgerAccountId = await account(w, "AG", "Asset", opening);
  const res = await activate(w, { ledgerAccountId, date: "2026-03-01" });
  expect(res.status, res.text).toBe(201);
  return { ledgerAccountId, walletId: Number(res.body.walletId) };
}

async function walletCount(w: FactoryWorld) {
  const [row] = await w.q<{ wallets: number; ops: number }>(
    `SELECT (SELECT count(*)::int FROM factory_fx_agent_wallets WHERE company_id = $1) AS wallets,
            (SELECT count(*)::int FROM factory_fx_agent_wallet_operations WHERE company_id = $1) AS ops`,
    [w.companyId]
  );
  return row;
}

/** One non-USD voucher line on the account (legacy shape, triggers off for it). */
async function foreignHistory(w: FactoryWorld, accountId: number, date = "2026-02-01") {
  await w.q(`SET LOCAL session_replication_role = replica`);
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
     VALUES ($1, $2, 'Journal', $3, 10, 'EUR') RETURNING id`,
    [w.companyId, `${w.tag}FV${accountId}`, date]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency)
     VALUES ($1, $2, 10, 0, 'EUR')`,
    [voucherId, accountId]
  );
  await w.q(`SET LOCAL session_replication_role = origin`);
}

describe("FX agent wallet activation refusals", () => {
  it("refuses invalid, unconfirmed, non-balance-sheet, non-USD, linked, foreign and empty accounts", async () => {
    await withFactoryWorld(async (w) => {
      const income = await account(w, "IN", "Income");
      const eurOpening = await account(w, "EU", "Asset", "100", "EUR");
      const linked = await account(w, "LK");
      await w.q(
        `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, 'Linked', $3)`,
        [w.companyId, `${w.tag}CU`, linked]
      );
      const foreign = await account(w, "FO");
      await foreignHistory(w, foreign);
      const empty = await account(w, "EM", "Asset", "0");
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Their FX', 'Asset', 100, 'Dr') RETURNING id`,
        [other, `${w.tag}TH`]
      );

      const cases: [Record<string, unknown>, RegExp][] = [
        [{ ledgerAccountId: "abc" }, /Invalid ledger account/],
        [{ ledgerAccountId: theirs, confirmUsdSource: false }, /Confirm this ledger/],
        [{ ledgerAccountId: income }, /active balance-sheet ledger/],
        [{ ledgerAccountId: theirs }, /active balance-sheet ledger/],
        [{ ledgerAccountId: eurOpening }, /non-USD opening balance/],
        [{ ledgerAccountId: linked }, /linked customer or bank/],
        [{ ledgerAccountId: foreign }, /foreign-currency voucher history/],
        [{ ledgerAccountId: empty }, /positive \(debit\) USD asset balance/],
        [{ ledgerAccountId: empty, date: "2099-01-01" }, /Date must not be in the future/],
      ];
      for (const [body, message] of cases) {
        const res = await activate(w, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await walletCount(w)).toEqual({ wallets: 0, ops: 0 });
    });
  });

  it("lists wallets with a dated rate and the GET falls back to today for a bad asOf", async () => {
    await withFactoryWorld(async (w) => {
      const { walletId } = await wallet(w);
      await w.q(
        `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
         VALUES ($1, 'EUR', 1.1, '2026-03-02', 'manual')`,
        [w.companyId]
      );
      const dated = await w.agent.get("/api/factory/fx-agent-wallets?asOf=2026-03-05");
      expect(dated.status, dated.text).toBe(200);
      expect(dated.body).toMatchObject({ setupRequired: false, asOf: "2026-03-05" });
      expect(Number(dated.body.currentRate)).toBe(1.1);
      expect(dated.body.wallets.map((s: { wallet: { id: number } }) => s.wallet.id)).toEqual([walletId]);
      const fallback = await w.agent
        .get("/api/factory/fx-agent-wallets?asOf=yesterday")
        .set("X-Client-Date", "2026-03-01");
      expect(fallback.body).toMatchObject({ asOf: "2026-03-01", currentRate: null });
    });
  });
});

describe("FX agent wallet rebaseline", () => {
  const rebaseline = (w: FactoryWorld, id: number | string, body: Record<string, unknown>) =>
    w.agent
      .post(`/api/factory/fx-agent-wallets/${id}/rebaseline`)
      .set("X-Client-Date", TODAY)
      .send({ reason: "Ledger topped up", confirmUsdSource: true, ...body });

  it("validates input and refuses other-company, non-USD, used, foreign, stale, matching and non-positive wallets", async () => {
    await withFactoryWorld(async (w) => {
      const { walletId, ledgerAccountId } = await wallet(w);
      const good = { expectedOpeningUsd: "100", expectedLedgerBookUsd: "100" };
      for (const body of [
        { ...good, reason: "" },
        { ...good, reason: "x".repeat(501) },
        { ...good, expectedOpeningUsd: "1.1234567" },
        { ...good, expectedLedgerBookUsd: "-1" },
        { ...good, confirmUsdSource: false },
      ]) {
        expect((await rebaseline(w, walletId, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await rebaseline(w, "abc", good)).status).toBe(400);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirAccount = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Their', 'Asset') RETURNING id`,
        [other, `${w.tag}TA`]
      );
      const theirWallet = await w.one(
        `INSERT INTO factory_fx_agent_wallets (company_id, ledger_account_id, opening_usd, confirmed_native_usd, activated_on, created_by)
         VALUES ($1, $2, 50, true, '2026-03-01', 'x') RETURNING id`,
        [other, theirAccount]
      );
      const notFound = await rebaseline(w, theirWallet, good);
      expect(notFound.status).toBe(409);
      expect(notFound.body.message).toMatch(/not found/);

      expect((await rebaseline(w, walletId, good)).body.message).toMatch(/already matches/);
      expect((await rebaseline(w, walletId, { ...good, expectedLedgerBookUsd: "90" })).body.message).toMatch(
        /changed. Reload/
      );

      await w.q(`UPDATE ledger_accounts SET opening_balance_currency = 'EUR' WHERE id = $1`, [ledgerAccountId]);
      expect((await rebaseline(w, walletId, good)).body.message).toMatch(/opening currency is not USD/);
      await w.q(`UPDATE ledger_accounts SET opening_balance_currency = NULL WHERE id = $1`, [ledgerAccountId]);

      await foreignHistory(w, ledgerAccountId);
      expect((await rebaseline(w, walletId, good)).body.message).toMatch(/Non-USD voucher history/);

      const [row] = await w.q(`SELECT opening_usd::text FROM factory_fx_agent_wallets WHERE id = $1`, [walletId]);
      expect(Number(row.opening_usd)).toBe(100);
    });
  });

  it("refuses a wallet with FX operations and a non-positive ledger", async () => {
    await withFactoryWorld(async (w) => {
      const first = await wallet(w);
      const convert = await w.agent
        .post(`/api/factory/fx-agent-wallets/${first.walletId}/convert`)
        .set("X-Client-Date", TODAY)
        .send({ usdAmount: "10", rateUsdPerEur: "1.25", requestKey: `${w.tag}-rb-op` });
      expect(convert.status, convert.text).toBe(201);
      const used = await rebaseline(w, first.walletId, { expectedOpeningUsd: "100", expectedLedgerBookUsd: "100" });
      expect(used.body.message).toMatch(/already has FX transactions/);

      const { walletId, ledgerAccountId } = await (async () => {
        const id = await account(w, "AG2", "Asset", "60");
        const res = await activate(w, { ledgerAccountId: id, date: "2026-03-01" });
        return { walletId: Number(res.body.walletId), ledgerAccountId: id };
      })();
      await w.q(`UPDATE ledger_accounts SET opening_balance = 0 WHERE id = $1`, [ledgerAccountId]);
      const zero = await rebaseline(w, walletId, { expectedOpeningUsd: "60", expectedLedgerBookUsd: "0" });
      expect(zero.body.message).toMatch(/must be positive/);
    });
  });

  it("restarts the baseline at the current USD book and audits it", async () => {
    await withFactoryWorld(async (w) => {
      const { walletId, ledgerAccountId } = await wallet(w);
      await w.q(`UPDATE ledger_accounts SET opening_balance = 175 WHERE id = $1`, [ledgerAccountId]);
      const res = await rebaseline(w, walletId, { expectedOpeningUsd: "100", expectedLedgerBookUsd: "175" });
      expect(res.status, res.text).toBe(200);
      expect(res.body).toEqual({ walletId, openingUsd: "175.000000", activatedOn: TODAY });
      const audits = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'factory_fx_agent_wallets' AND record_id = $1`,
        [walletId]
      );
      expect(audits.map((a) => a.action)).toEqual(["repair"]);
    });
  });
});

describe("FX agent wallet conversion refusals", () => {
  const convert = (w: FactoryWorld, id: number | string, body: Record<string, unknown>) =>
    w.agent.post(`/api/factory/fx-agent-wallets/${id}/convert`).set("X-Client-Date", TODAY).send(body);

  it("refuses bad keys, amounts, rates, unknown or foreign wallets, conflicting replays and backdating", async () => {
    await withFactoryWorld(async (w) => {
      const { walletId } = await wallet(w);
      const ok = { usdAmount: "40", rateUsdPerEur: "1.25", requestKey: `${w.tag}-cv-1` };
      const cases: [string | number, Record<string, unknown>, RegExp][] = [
        [walletId, { ...ok, requestKey: "short" }, /idempotency key/],
        ["abc", ok, /idempotency key/],
        [walletId, { ...ok, usdAmount: "0" }, /Positive amount/],
        [walletId, { ...ok, rateUsdPerEur: "x" }, /USD-per-EUR rate/],
        [walletId + 100000, ok, /wallet not found/],
        [walletId, { ...ok, date: "2026-02-01" }, /inactive on selected date/],
        [walletId, { ...ok, usdAmount: "500" }, /Insufficient USD/],
      ];
      for (const [id, body, message] of cases) {
        const res = await convert(w, id, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect((await walletCount(w)).ops).toBe(0);

      const done = await convert(w, walletId, { ...ok, date: "2026-03-05" });
      expect(done.status, done.text).toBe(201);
      const replay = await convert(w, walletId, { ...ok, date: "2026-03-05" });
      expect(replay.body).toEqual({ id: done.body.id, replayed: true });
      for (const changed of [{ usdAmount: "41" }, { rateUsdPerEur: "1.3" }]) {
        const res = await convert(w, walletId, { ...ok, ...changed });
        expect(res.body.message).toMatch(/already belongs to a different conversion/);
      }
      const backdated = await convert(w, walletId, { ...ok, requestKey: `${w.tag}-cv-2`, date: "2026-03-02" });
      expect(backdated.body.message).toMatch(/before a later FX operation/);
      expect((await walletCount(w)).ops).toBe(1);
    });
  });

  it("refuses a wallet whose ledger was changed by hand", async () => {
    await withFactoryWorld(async (w) => {
      const { walletId, ledgerAccountId } = await wallet(w);
      await w.q(`UPDATE ledger_accounts SET opening_balance = 300 WHERE id = $1`, [ledgerAccountId]);
      const res = await convert(w, walletId, { usdAmount: "10", rateUsdPerEur: "1.2", requestKey: `${w.tag}-cv-sync` });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Manual ledger changes detected/);
    });
  });
});
