/**
 * server/routes/accountCurrencyRoutes.ts against PostgreSQL over HTTP, one
 * rolled-back company per test: the opening-balance normaliser (Kwacha company
 * mismatch, unknown and other-company accounts, negative amounts, unresolved
 * legacy edits that keep or drop the locked currency metadata) and the balance
 * reads (invalid ids and query values, other-company ids, historical ledger
 * balances with unresolved openings and legacy entries, book basis, dated and
 * undated bank balances, cash currency rows).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function ledger(w: FactoryWorld, type: string, opening: Record<string, unknown> = {}, companyId = w.companyId) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side,
       opening_balance_native_amount, opening_balance_currency, opening_balance_historical_rate,
       opening_balance_base_amount)
     VALUES ($1, $2::varchar, $2::text, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      companyId,
      `${w.tag}${type}${Math.floor(Math.random() * 1e6)}`,
      type,
      opening.balance ?? "0",
      opening.side ?? null,
      opening.native ?? null,
      opening.currency ?? null,
      opening.rate ?? null,
      opening.base ?? null,
    ]
  );
}

async function bank(w: FactoryWorld, companyId = w.companyId) {
  return w.one(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance,
       opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount)
     VALUES ($1, $2, 'Main Bank', 'Rawbank', '001', 50, 50, 'USD', 50) RETURNING id`,
    [companyId, `${w.tag}BK${Math.floor(Math.random() * 1e6)}`]
  );
}

/**
 * One debit line. A non-USD line is a pre-normalisation legacy row (no base
 * amounts), which the currency trigger no longer lets anyone write; it is
 * inserted with triggers off for this statement only, inside the rolled-back
 * transaction.
 */
async function post(w: FactoryWorld, accountId: number, amount: string, currency: string | null, date = "2026-02-01") {
  const legacy = currency !== null && currency !== "USD";
  if (legacy) await w.q(`SET LOCAL session_replication_role = replica`);
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
     VALUES ($1, $2, 'Journal', $3, $4, $5) RETURNING id`,
    [w.companyId, `${w.tag}V${Math.floor(Math.random() * 1e7)}`, date, amount, currency]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, 0)`,
    [voucherId, accountId, amount]
  );
  if (legacy) await w.q(`SET LOCAL session_replication_role = origin`);
}

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}O`]);

describe("opening balance normaliser", () => {
  it("refuses a Kwacha opening outside a USD-base, ZMW-display company", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.post("/api/ledger-accounts").send({
        code: `${w.tag}Z`,
        name: "Kwacha Cash",
        accountType: "Cash",
        openingBalance: "100",
        openingBalanceCurrency: "zmw",
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ZMW_OPENING_COMPANY_MISMATCH");
      const rows = await w.q(`SELECT 1 FROM ledger_accounts WHERE company_id = $1 AND code = $2`, [
        w.companyId,
        `${w.tag}Z`,
      ]);
      expect(rows).toEqual([]);
    }));

  it("refuses unknown and other-company accounts and negative openings", () =>
    withFactoryWorld(async (w) => {
      const foreign = await ledger(w, "Expense", {}, await otherCompany(w));
      for (const path of [`/api/ledger-accounts/${foreign}`, "/api/bank-accounts/2147483000"]) {
        const res = await w.agent.put(path).send({ openingBalance: "10" });
        expect(res.status, path).toBe(404);
      }
      const negative = await w.agent
        .post("/api/ledger-accounts")
        .send({ code: `${w.tag}N`, name: "Neg", accountType: "Expense", openingBalance: "-5" });
      expect(negative.status).toBe(400);
      expect(negative.body.message).toMatch(/finite non-negative/);
    }));

  it("keeps locked currency metadata for an unchanged legacy edit and unresolves a changed one", () =>
    withFactoryWorld(async (w) => {
      const id = await ledger(w, "Expense", {
        balance: "20",
        native: "40000",
        currency: "CFA",
        rate: "2000",
        base: "20",
        side: "Dr",
      });
      const same = await w.agent
        .put(`/api/ledger-accounts/${id}`)
        .send({ openingBalance: "20", openingBalanceSide: "Dr", name: "Renamed" });
      expect(same.status, same.text).toBe(200);
      const [kept] = await w.q(
        `SELECT opening_balance_currency, opening_balance_native_amount::float8 AS native FROM ledger_accounts WHERE id = $1`,
        [id]
      );
      expect(kept).toEqual({ opening_balance_currency: "CFA", native: 40000 });

      const negative = await w.agent.put(`/api/ledger-accounts/${id}`).send({ openingBalance: "-1" });
      expect(negative.status).toBe(400);

      const changed = await w.agent
        .put(`/api/ledger-accounts/${id}`)
        .send({ openingBalance: "25", openingBalanceSide: "Dr" });
      expect(changed.status).toBe(200);
      const [unresolved] = await w.q(
        `SELECT opening_balance::float8 AS raw, opening_balance_currency, opening_balance_base_amount FROM ledger_accounts WHERE id = $1`,
        [id]
      );
      expect(unresolved).toEqual({ raw: 25, opening_balance_currency: null, opening_balance_base_amount: null });

      const blank = await w.agent.post("/api/ledger-accounts").send({
        companyId: w.companyId,
        code: `${w.tag}U`,
        name: "Unresolved",
        accountType: "Expense",
        openingBalance: "7",
        openingBalanceSide: "Dr",
      });
      expect(blank.status, blank.text).toBe(201);
      const [row] = await w.q(
        `SELECT opening_balance::float8 AS raw, opening_balance_currency FROM ledger_accounts WHERE company_id = $1 AND code = $2`,
        [w.companyId, `${w.tag}U`]
      );
      expect(row).toEqual({ raw: 7, opening_balance_currency: null });
    }));
});

describe("ledger balance reads", () => {
  it("refuses invalid ids, query values and other-company accounts", () =>
    withFactoryWorld(async (w) => {
      const id = await ledger(w, "Expense");
      const base = `/api/accounts/ledger`;
      expect((await w.agent.get(`${base}/0/balance`)).status).toBe(400);
      expect((await w.agent.get(`${base}/${id}/balance`).query({ asOf: "2026/01/01" })).status).toBe(400);
      expect((await w.agent.get(`${base}/${id}/balance`).query({ balanceBasis: "live" })).status).toBe(400);
      expect((await w.agent.get(`${base}/abc/currency-balances`)).status).toBe(400);
      const foreign = await ledger(w, "Cash", {}, await otherCompany(w));
      expect((await w.agent.get(`${base}/${foreign}/balance`)).status).toBe(404);
      expect((await w.agent.get(`${base}/${foreign}/balance`).query({ asOf: "2026-12-31" })).status).toBe(404);
      expect((await w.agent.get(`${base}/${foreign}/currency-balances`)).status).toBe(404);
    }));

  it("adds unresolved openings and legacy entries to a historical ledger balance", () =>
    withFactoryWorld(async (w) => {
      const id = await ledger(w, "Liability", { balance: "30", side: "Cr" });
      await post(w, id, "100", "USD", "2026-01-10");
      await post(w, id, "500", "CFA", "2026-03-10");
      const res = await w.agent.get(`/api/accounts/ledger/${id}/balance`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        historicalBaseBalance: "100.000000",
        openingBalanceCurrencyUnresolved: true,
        unresolvedOpeningBalanceRaw: "-30.000000",
        unresolvedLegacyEntryCount: 1,
        totalsProvisional: true,
        balance: 570,
      });
      const dated = await w.agent.get(`/api/accounts/ledger/${id}/balance`).query({ asOf: "2026-02-01" });
      expect(dated.body).toMatchObject({ unresolvedLegacyEntryCount: 0, balance: 70 });
      const book = await w.agent.get(`/api/accounts/ledger/${id}/balance`).query({ balanceBasis: "book" });
      expect(book.status).toBe(200);
      expect(book.body.balanceBasis).toBe("book");

      const resolved = await ledger(w, "Asset", { balance: "10", native: "10", currency: "USD", base: "10" });
      const ok = await w.agent.get(`/api/accounts/ledger/${resolved}/balance`);
      expect(ok.body).toMatchObject({ balance: 10, totalsProvisional: false, unresolvedOpeningBalanceRaw: null });
      expect((await w.agent.get(`/api/accounts/ledger/${resolved}/currency-balances`)).body).toEqual([]);
    }));

  it("reads cash ledger balances on both bases and lists currency rows", () =>
    withFactoryWorld(async (w) => {
      const cash = await ledger(w, "Cash", { balance: "5", native: "5", currency: "USD", base: "5" });
      await post(w, cash, "20", "USD");
      const current = await w.agent.get(`/api/accounts/ledger/${cash}/balance`);
      expect(current.status).toBe(200);
      expect(current.body.balance).toBe(25);
      const book = await w.agent.get(`/api/accounts/ledger/${cash}/balance`).query({ balanceBasis: "book" });
      expect(book.body).toMatchObject({ balance: 25, balanceBasis: "book" });
      const rows = await w.agent.get(`/api/accounts/ledger/${cash}/currency-balances`);
      expect(rows.status).toBe(200);
      expect(rows.body).toEqual([
        expect.objectContaining({ currency: "USD", net: 25, totalDebit: 25, totalCredit: 0 }),
      ]);
    }));

  it("reads bank balances undated, dated and on the book basis", () =>
    withFactoryWorld(async (w) => {
      const id = await bank(w);
      const current = await w.agent.get(`/api/accounts/ledger/${id}/balance`);
      expect(current.status, current.text).toBe(200);
      expect(current.body.balance).toBe(50);
      const book = await w.agent.get(`/api/accounts/ledger/${id}/balance`).query({ balanceBasis: "book" });
      expect(book.body).toMatchObject({ balanceBasis: "book" });
      const dated = await w.agent.get(`/api/accounts/ledger/${id}/balance`).query({ asOf: "2026-06-30" });
      expect(dated.body).toEqual({ balance: 50, asOf: "2026-06-30" });
      const datedBook = await w.agent
        .get(`/api/accounts/ledger/${id}/balance`)
        .query({ asOf: "2026-06-30", balanceBasis: "book" });
      expect(datedBook.body).toMatchObject({ asOf: "2026-06-30", balanceBasis: "book" });
      const rows = await w.agent.get(`/api/accounts/ledger/${id}/currency-balances`);
      expect(rows.status).toBe(200);
      expect(Array.isArray(rows.body)).toBe(true);
      expect((await w.agent.get(`/api/accounts/ledger/2147483000/balance`)).status).toBe(404);
    }));
});

describe("Kwacha openings, revaluation and Zambia transfers", () => {
  it("lets a USD-base, ZMW-display company record a Kwacha cash opening", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET display_currency = 'ZMW' WHERE id = $1`, [w.companyId]);
      const res = await w.agent.post("/api/ledger-accounts").send({
        companyId: w.companyId,
        code: `${w.tag}K`,
        name: "Kwacha Cash",
        accountType: "Cash",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        openingBalanceCurrency: "ZMW",
      });
      expect(res.status, res.text).toBe(201);
      const rows = await w.q(
        `SELECT opening_balance::float8 AS opening FROM ledger_accounts WHERE company_id = $1 AND code = $2`,
        [w.companyId, `${w.tag}K`]
      );
      expect(rows).toEqual([{ opening: 0 }]);
    }));

  it("returns the cash/bank revaluation for the company", () =>
    withFactoryWorld(async (w) => {
      await bank(w);
      const res = await w.agent.get("/api/bank-accounts/revaluation");
      expect(res.status).toBe(200);
      expect(res.body).toBeTypeOf("object");
    }));

  it("refuses Zambia transfers for other roles and invalid requests without posting", () =>
    withFactoryWorld(async (w) => {
      const vouchers = async () =>
        (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;
      const before = await vouchers();
      const staff = await w.agentFor("Staff");
      expect((await staff.post("/api/accounts/multi-currency/zambia-transfer").send({})).status).toBe(403);
      const invalid = await w.agent.post("/api/accounts/multi-currency/zambia-transfer").send({ amount: "abc" });
      expect(invalid.status).toBeGreaterThanOrEqual(400);
      expect(invalid.status).toBeLessThan(500);
      expect(await vouchers()).toBe(before);
    }));
});
