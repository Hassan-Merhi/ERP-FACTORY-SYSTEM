/**
 * FX monetary valuation against a real PostgreSQL schema (CI's database
 * service). Every figure is derived from the fixture rows below, never from
 * the engine under test:
 *
 *   - a USD-base company whose display currency is CFA (Mali), with rates
 *     605 CFA/USD (Oct 20) and 612 CFA/USD (Oct 25), and a FUTURE 650 that
 *     must never apply;
 *   - a USD-base company whose display currency is ZMW (Zambia), with one
 *     direct quote and, in one scenario, a contradicting same-day inverse;
 *   - a USD-only company with no rate at all;
 *   - a company quoting EUR the reverse way (EUR -> USD = USD per EUR).
 *
 * The policy under test: when the effective rate changes, only the CURRENT
 * USD equivalent of cash/bank, customers (both signs), explicit loans (both
 * signs) and approved monetary assets changes. Original CFA/ZMW/EUR amounts,
 * posted vouchers, historical USD, inventory, suppliers and generic assets
 * never change, and no FX journal is written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass, requireRole: () => pass };
});

import Decimal from "decimal.js";
import { db, pool } from "../server/db";
import { getMonetaryFxValuation } from "../server/services/accounting/monetaryFxValuationService";
import { saveCompanyExchangeRate } from "../server/services/accounting/exchangeRateWrites";
import { MonetaryFxError } from "../server/services/accounting/monetaryFxRates";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { calculateGroupNetPosition } from "../server/helpers/groupNetPosition";
import { serveAccountListForCompany } from "../server/routes/accounts/all";
import { BALANCE_SHEET_FX_TRANSLATION_CODE } from "../server/services/accounting/monetaryFxReportOverlay";
import {
  databaseDescribe,
  PREFIX,
  TODAY,
  call,
  rate,
  cleanup,
  bookSnapshot,
  usd,
  mali,
  zambia,
  usdOnly,
  euroCo,
  factory,
  ids,
  seedMonetaryFxValuationFixture,
} from "./helpers/monetaryFxValuationFixture";

/**
 * Since the Net Position FX gain/loss work (#3163) a revalued monetary row keeps its booked
 * USD in `value` and reports the current-rate amount in `currentTranslatedBaseBalance`, with
 * the difference shown as its own FX gain/loss row. This asserts the row appears exactly once,
 * is marked revalued, carries the expected identity fields and translates to the expected
 * current-rate amount (compared by magnitude: liabilities are stored negative).
 */
function expectAtCurrentRate(
  rows: Array<Record<string, unknown>>,
  currentRateAmount: number,
  identity: Record<string, unknown>
): void {
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(identity);
  expect(Math.abs(Number(rows[0].currentTranslatedBaseBalance))).toBeCloseTo(currentRateAmount, 2);
}

databaseDescribe("FX monetary valuation (database)", () => {
  beforeAll(async () => {
    await seedMonetaryFxValuationFixture();
  }, 180_000);

  afterAll(async () => {
    await cleanup();
  });

  const row = (valuation: Awaited<ReturnType<typeof getMonetaryFxValuation>>, key: string) => {
    const found = valuation.accounts.find((account) => account.accountKey === key);
    if (!found) throw new Error(`no valuation row ${key}: ${valuation.accounts.map((a) => a.accountKey).join(", ")}`);
    return found;
  };

  describe("the valuation engine", () => {
    it("translates 61,200 CFA to 100 USD at 612 and keeps the native amount and historical USD", async () => {
      const valuation = await getMonetaryFxValuation(mali);
      expect(valuation.baseCurrency).toBe("USD");
      expect(valuation.bookBalancesModified).toBe(false);
      expect(valuation.fxVouchersPosted).toBe(false);
      // The future-dated 650 is not the current quote.
      expect(valuation.rates.find((r) => r.currency === "CFA")).toMatchObject({
        rate: "612.0000000000",
        direction: "FOREIGN_PER_USD",
        effectiveDate: "2026-10-25",
      });
      const c1 = row(valuation, `customer:${ids.c1}`);
      expect(c1.category).toBe("customer");
      expect(c1.linkedLedgerId).toBe(ids.custLedger);
      expect(c1.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
      expect(c1.historicalBaseUsd).toBe("101.157025");
      expect(c1.bookClosingUsd).toBe("101.160000");
      expect(c1.currentTranslatedUsd).toBe("100.000000");
      expect(c1.translationDifferenceUsd).toBe("-1.157025");
      expect(c1.provisional).toBe(false);
      // The linked ledger has no row of its own (it belongs to the customer).
      expect(valuation.accounts.find((a) => a.accountKey === `ledger:${ids.custLedger}`)).toBeUndefined();
    });

    it("keeps a customer credit balance on the credit side", async () => {
      const c2 = row(await getMonetaryFxValuation(mali), `customer:${ids.c2}`);
      expect(c2.nativeBalancesByCurrency).toEqual({ CFA: "-12100.000000" });
      expect(c2.historicalBaseUsd).toBe("-20.000000");
      expect(c2.currentTranslatedUsd).toBe(new Decimal("-12100").div(612).toDecimalPlaces(6).toFixed(6));
    });

    it("keeps USD and CFA buckets apart on one cash account and counts a ledger+bank line once", async () => {
      const valuation = await getMonetaryFxValuation(mali);
      const cash = row(valuation, `ledger:${ids.cash}`);
      // 121,000 CFA opening + 6,050 CFA (the line naming both ledger and bank) ; 10 USD.
      expect(cash.nativeBalancesByCurrency).toEqual({ CFA: "127050.000000", USD: "10.000000" });
      expect(cash.currentTranslatedUsd).toBe(new Decimal("127050").div(612).plus(10).toDecimalPlaces(6).toFixed(6));
      expect(cash.historicalBaseUsd).toBe("220.000000");
      const bankRow = row(valuation, `bank:${ids.bank}`);
      expect(bankRow.category).toBe("cash_bank");
      expect(bankRow.nativeBalancesByCurrency).toEqual({ CFA: "30250.000000" });
      expect(bankRow.currentTranslatedUsd).toBe(usd("30250", "612"));
    });

    it("values loan payables, loan receivables and a loan that changes sign", async () => {
      const valuation = await getMonetaryFxValuation(mali);
      const payable = row(valuation, `ledger:${ids.loanPayable}`);
      expect(payable.category).toBe("loan");
      expect(payable.historicalBaseUsd).toBe("-101.157025");
      expect(payable.currentTranslatedUsd).toBe("-100.000000");
      const receivable = row(valuation, `ledger:${ids.loanReceivable}`);
      expect(receivable.currentTranslatedUsd).toBe("50.000000");
      const flip = row(valuation, `ledger:${ids.loanFlip}`);
      // Book: 101.157025 − 100.50 = 0.657025 (asset); current: 100 − 100.50 = −0.50 (liability).
      expect(flip.historicalBaseUsd).toBe("0.657025");
      expect(flip.currentTranslatedUsd).toBe("-0.500000");
    });

    it("never translates inventory, suppliers or an unapproved generic asset", async () => {
      const valuation = await getMonetaryFxValuation(mali);
      expect(valuation.accounts.find((a) => a.accountKey === `ledger:${ids.inventory}`)).toBeUndefined();
      expect(valuation.accounts.some((a) => a.accountKind === ("supplier" as string))).toBe(false);
      const deposit = row(valuation, `ledger:${ids.deposit}`);
      expect(deposit.eligibility).toBe("needs_review");
      expect(deposit.currentTranslatedUsd).toBeNull();
      expect(deposit.nativeBalancesByCurrency).toEqual({ CFA: "6050.000000" });
      expect(valuation.needsReviewCount).toBe(1);
    });

    it("leaves missing original-currency evidence and a missing rate provisional, without poisoning other accounts", async () => {
      const valuation = await getMonetaryFxValuation(mali);
      const noCurrency = row(valuation, `ledger:${ids.cashNoCurrency}`);
      expect(noCurrency.unresolvedOpening).toBe(true);
      expect(noCurrency.provisional).toBe(true);
      expect(noCurrency.currentTranslatedUsd).toBeNull();
      expect(noCurrency.bookClosingUsd).toBe("50.000000");
      const legacy = row(valuation, `ledger:${ids.cashLegacy}`);
      expect(legacy.unresolvedEntryCount).toBe(1);
      expect(legacy.currentTranslatedUsd).toBeNull();
      const ghs = row(valuation, `ledger:${ids.cashGhs}`);
      expect(ghs.unresolvedCurrencies).toEqual(["GHS"]);
      expect(ghs.currentTranslatedUsd).toBeNull();
      expect(valuation.rateErrorsByCurrency).toEqual({ GHS: "FX_RATE_MISSING" });
      // The CFA accounts beside them are still valued.
      expect(row(valuation, `customer:${ids.c1}`).currentTranslatedUsd).toBe("100.000000");
      expect(valuation.unresolvedAccountCount).toBe(3);
    });

    it("values ZMW with the company's own quote and USD-only companies without any rate", async () => {
      const z = await getMonetaryFxValuation(zambia);
      expect(row(z, `customer:${ids.zCustomer}`).currentTranslatedUsd).toBe("100.000000");
      expect(row(z, `ledger:${ids.zCash}`).currentTranslatedUsd).toBe("40.000000");
      expect(z.rateErrorsByCurrency).toEqual({});

      const u = await getMonetaryFxValuation(usdOnly);
      expect(u.rates).toEqual([]);
      expect(u.rateErrorsByCurrency).toEqual({});
      const uCash = row(u, `ledger:${ids.uCash}`);
      expect(uCash.nativeBalancesByCurrency).toEqual({ USD: "300.000000" });
      expect(uCash.currentTranslatedUsd).toBe("300.000000");
      expect(uCash.translationDifferenceUsd).toBe("0.000000");
      const uCustomer = row(u, `customer:${ids.uCustomer}`);
      expect(uCustomer.currentTranslatedUsd).toBe("75.250000");
      expect(uCustomer.translationDifferenceUsd).toBe("0.000000");
    });

    it("multiplies a reverse USD-per-EUR quote", async () => {
      const e = await getMonetaryFxValuation(euroCo);
      expect(e.rates.find((r) => r.currency === "EUR")).toMatchObject({
        direction: "USD_PER_FOREIGN",
        rate: "1.2000000000",
      });
      const c = row(e, `customer:${ids.eCustomer}`);
      expect(c.nativeBalancesByCurrency).toEqual({ EUR: "100.000000" });
      expect(c.historicalBaseUsd).toBe("110.000000");
      expect(c.currentTranslatedUsd).toBe("120.000000");
    });

    it("is read-only and idempotent: repeated reads are identical and change nothing", async () => {
      const before = await bookSnapshot(mali);
      const first = await getMonetaryFxValuation(mali);
      const second = await getMonetaryFxValuation(mali);
      expect(second).toEqual(first);
      expect(await bookSnapshot(mali)).toEqual(before);
    });
  });

  describe("a rate change", () => {
    it("moves only the current USD; original amounts, vouchers and historical USD stay; no FX journal", async () => {
      const before = await bookSnapshot(mali);
      const audits = async () =>
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'exchange_rates'`,
            [mali]
          )
        ).rows[0].n;
      const auditsBefore = await audits();
      const actor = { userId: "1", username: "fx-test", companyId: mali };
      const saved = await saveCompanyExchangeRate(actor, {
        fromCurrency: "USD",
        toCurrency: "CFA",
        rate: "620",
        effectiveDate: TODAY,
      });
      expect(String(saved.rate)).toMatch(/^620/);
      expect(await audits()).toBe(auditsBefore + 1);

      const valuation = await getMonetaryFxValuation(mali);
      const c1 = row(valuation, `customer:${ids.c1}`);
      expect(c1.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
      expect(c1.historicalBaseUsd).toBe("101.157025");
      expect(c1.currentTranslatedUsd).toBe(usd("61200", "620"));
      expect(row(valuation, `ledger:${ids.loanPayable}`).currentTranslatedUsd).toBe(
        new Decimal("-61200").div(620).toDecimalPlaces(6).toFixed(6)
      );
      expect(await bookSnapshot(mali)).toEqual(before);

      // Repeating the same rate is a no-op: no second audit row, same valuation.
      const again = await saveCompanyExchangeRate(actor, {
        fromCurrency: "USD",
        toCurrency: "CFA",
        rate: "620",
        effectiveDate: TODAY,
      });
      expect(again.id).toBe(saved.id);
      expect(await audits()).toBe(auditsBefore + 1);
      expect(await getMonetaryFxValuation(mali)).toEqual(valuation);

      // Back to 612 for the screen tests below (a revision, audited once more).
      await saveCompanyExchangeRate(actor, {
        fromCurrency: "USD",
        toCurrency: "CFA",
        rate: "612",
        effectiveDate: TODAY,
      });
      expect(await audits()).toBe(auditsBefore + 2);
      expect(row(await getMonetaryFxValuation(mali), `customer:${ids.c1}`).currentTranslatedUsd).toBe("100.000000");
      expect(await bookSnapshot(mali)).toEqual(before);
    });

    it("in one company never changes another company's valuation", async () => {
      const maliBefore = await getMonetaryFxValuation(mali);
      await saveCompanyExchangeRate(
        { userId: "1", username: "fx-test", companyId: zambia },
        { fromCurrency: "USD", toCurrency: "ZMW", rate: "26", effectiveDate: TODAY }
      );
      expect(row(await getMonetaryFxValuation(zambia), `customer:${ids.zCustomer}`).currentTranslatedUsd).toBe(
        new Decimal(2500).div(26).toDecimalPlaces(6).toFixed(6)
      );
      expect(await getMonetaryFxValuation(mali)).toEqual(maliBefore);
      await saveCompanyExchangeRate(
        { userId: "1", username: "fx-test", companyId: zambia },
        { fromCurrency: "USD", toCurrency: "ZMW", rate: "25", effectiveDate: TODAY }
      );
    });

    it("rejects a contradicting same-day reverse quote and flags conflicting stored rates per currency", async () => {
      // A stored ZMW -> USD 0.05 (20 per USD) on the same day as USD -> ZMW 25.
      const inverse = await rate(zambia, "ZMW", "USD", "0.05", TODAY);
      try {
        const z = await getMonetaryFxValuation(zambia);
        expect(z.rateErrorsByCurrency).toEqual({ ZMW: "FX_RATE_CONFLICT" });
        expect(row(z, `customer:${ids.zCustomer}`).currentTranslatedUsd).toBeNull();
        expect(row(z, `customer:${ids.zCustomer}`).nativeBalancesByCurrency).toEqual({ ZMW: "2500.000000" });
        // A save that would leave the conflict in place is refused and not audited.
        await expect(
          saveCompanyExchangeRate(
            { userId: "1", username: "fx-test", companyId: zambia },
            { fromCurrency: "USD", toCurrency: "ZMW", rate: "27", effectiveDate: TODAY }
          )
        ).rejects.toMatchObject({ code: "FX_RATE_CONFLICT" } satisfies Partial<MonetaryFxError>);
        const stored = await pool.query(
          `SELECT rate FROM exchange_rates WHERE company_id = $1 AND from_currency = 'USD' AND to_currency = 'ZMW' AND effective_date = $2`,
          [zambia, TODAY]
        );
        expect(String(stored.rows[0].rate)).toMatch(/^25/);
      } finally {
        await pool.query(`DELETE FROM exchange_rates WHERE id = $1`, [inverse]);
      }
      expect(row(await getMonetaryFxValuation(zambia), `customer:${ids.zCustomer}`).currentTranslatedUsd).toBe(
        "100.000000"
      );
    });

    it("cannot store a duplicate rate row for one company, date and pair", async () => {
      await expect(rate(mali, "USD", "CFA", "700", "2026-10-25")).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("ERP Net Position (/api/stats/net-profit)", () => {
    const byName = (accounts: Array<{ name: string }>, name: string) => accounts.filter((a) => a.name === name);

    it("shows cash, bank, customers and loans at the current rate, each once, with correct sides", async () => {
      const { statusCode, body } = await call("GET /api/stats/net-profit", {
        session: { currentCompanyId: mali },
        query: {},
      });
      expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
      expect(body.currencyRevaluation.valuationMode).toBe("CURRENT");
      expect(body.currencyRevaluation.currentCfaPerUsd).toBe("612.0000000000");
      expect(body.currency.currentCashBankTranslationApplied).toBe(true);

      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} customer C1`), 100, {
        partyKind: "customer",
        partyId: ids.c1,
        currencyRevalued: true,
      });
      expectAtCurrentRate(byName(body.onUs.accounts, `${PREFIX} customer C2`), 19.77, { currencyRevalued: true });
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} CASH`), 217.6, { currencyRevalued: true });
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} bank BNK`), 49.43, {
        bankAccountId: ids.bank,
        currencyRevalued: true,
      });
      expectAtCurrentRate(byName(body.onUs.accounts, `${PREFIX} LOANP`), 100, { currencyRevalued: true });
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} LOANR`), 50, {
        category: "Loan Deposits",
        currencyRevalued: true,
      });
      // Since #3163 the row stays on its booked side: this loan is booked as a deposit (What We
      // Have) even though it translates to an amount owed at the current rate. The sign flip is
      // carried by its current-rate balance and by the FX gain/loss row, not by moving the row.
      expect(byName(body.onUs.accounts, `${PREFIX} LOANF`)).toEqual([]);
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} LOANF`), 0.5, {
        category: "Loans Deposits",
        currencyRevalued: true,
      });
      expect(Number(byName(body.forUs.accounts, `${PREFIX} LOANF`)[0].currentTranslatedBaseBalance)).toBeLessThan(0);
      // A customer with an unposted memo: its ledger balance is revalued; the memo stays
      // in the "not yet in the ledger" section, never added to the totals.
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} customer C3`), 100, {
        partyKind: "customer",
        partyId: ids.c3,
        currencyRevalued: true,
      });
      expect(body.notInLedger.total).toBe(5);
      // Untouched: inventory, the generic asset, the unresolved accounts and the supplier.
      expect(byName(body.forUs.accounts, `${PREFIX} DEPOSIT`)).toEqual([expect.objectContaining({ value: 10 })]);
      expect(byName(body.forUs.accounts, `${PREFIX} DEPOSIT`)[0]).not.toHaveProperty("currencyRevalued");
      expect(byName(body.forUs.accounts, `${PREFIX} CASH2`)).toEqual([expect.objectContaining({ value: 50 })]);
      expect(byName(body.onUs.accounts, `${PREFIX} supplier S1`)).toEqual([expect.objectContaining({ value: 100 })]);
      const skipped = body.currencyRevaluation.skippedAccountKeys.map((s: { key: string }) => s.key);
      expect(skipped).toEqual(
        expect.arrayContaining([`ledger:${ids.cashNoCurrency}`, `ledger:${ids.cashLegacy}`, `ledger:${ids.cashGhs}`])
      );
      // Totals are the sum of the rows shown.
      const sum = (rows: Array<{ value: number }>) => Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100;
      expect(body.forUsTotal).toBeCloseTo(sum(body.forUs.accounts), 2);
      expect(body.onUsTotal).toBeCloseTo(sum(body.onUs.accounts), 2);
      expect(body.netPosition).toBeCloseTo(body.forUsTotal - body.onUsTotal, 2);
    });

    it("does not translate twice on repeated reads and keeps a dated snapshot at booked USD", async () => {
      const a = await call("GET /api/stats/net-profit", { session: { currentCompanyId: mali }, query: {} });
      const b = await call("GET /api/stats/net-profit", { session: { currentCompanyId: mali }, query: {} });
      expect(b.body.forUsTotal).toBe(a.body.forUsTotal);
      expect(b.body.netPosition).toBe(a.body.netPosition);
      const dated = await call("GET /api/stats/net-profit", {
        session: { currentCompanyId: mali },
        query: { toDate: "2026-10-24" },
      });
      expect(dated.statusCode).toBe(200);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} customer C1`)).toEqual([
        expect.objectContaining({ value: 101.16 }),
      ]);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} customer C1`)[0]).not.toHaveProperty("currencyRevalued");
      expect(dated.body.currencyRevaluation?.valuationMode).toBeUndefined();
    });
  });

  describe("Accounts list, Customers and Factory customers", () => {
    async function accountsList(companyId: number, query: Record<string, string> = {}) {
      let body: any;
      const res = { json: (value: unknown) => (body = value), status: () => res, setHeader: () => res } as never;
      await serveAccountListForCompany(
        { query, headers: { "x-client-date": TODAY }, session: { currentCompanyId: companyId } } as never,
        res,
        companyId
      );
      return body as { accounts: any[] };
    }

    it("lists current USD for eligible accounts, with the linked customer ledger under its customer", async () => {
      const { accounts } = await accountsList(mali);
      const find = (type: string, accountId: number) =>
        accounts.find((a) => a.type === type && a.accountId === accountId);
      expect(find("ledger", ids.custLedger)).toMatchObject({
        balance: "100.00",
        balanceSide: "Dr",
        customerId: ids.c1,
        currencyRevalued: true,
        historicalBalanceUsd: "101.160000",
        // The Accounts page displays the Parties projection for customer rows.
        partyBalance: "100.00",
        partyBalanceSide: "Dr",
        partyLedgerBalance: "100.00",
      });
      // A customer whose Parties projection carries an unposted memo keeps its book figures.
      expect(find("ledger", ids.c3Ledger)).toMatchObject({
        balance: "101.16",
        partyBalance: "106.16",
        notInLedgerTotal: "5.00",
        monetaryFxProvisional: true,
      });
      expect(find("ledger", ids.c3Ledger)).not.toHaveProperty("currencyRevalued");
      expect(find("ledger", ids.cash)).toMatchObject({ balance: "217.60", balanceSide: "Dr", currencyRevalued: true });
      expect(find("bank", ids.bank)).toMatchObject({ balance: "49.43", balanceSide: "Dr", currencyRevalued: true });
      expect(find("ledger", ids.loanPayable)).toMatchObject({
        balance: "100.00",
        balanceSide: "Cr",
        currencyRevalued: true,
      });
      expect(find("ledger", ids.loanFlip)).toMatchObject({
        balance: "0.50",
        balanceSide: "Cr",
        currencyRevalued: true,
      });
      expect(find("ledger", ids.cashNoCurrency)).toMatchObject({ balance: "50.00", monetaryFxProvisional: true });
      expect(find("ledger", ids.inventory)).toMatchObject({ balance: "100.00" });
      expect(find("ledger", ids.inventory)).not.toHaveProperty("currencyRevalued");
      expect(find("ledger", ids.deposit)).not.toHaveProperty("currencyRevalued");
    });

    it("keeps the posted USD book balance for operational account views without affecting live FX reports", async () => {
      const { accounts: translatedAccounts } = await accountsList(mali);
      const { accounts: bookAccounts } = await accountsList(mali, { balanceBasis: "book" });
      const liveCash = translatedAccounts.find((a) => a.type === "ledger" && a.accountId === ids.cash);
      const bookCash = bookAccounts.find((a) => a.type === "ledger" && a.accountId === ids.cash);
      const party = await getPartyBalances(db, { companyId: mali, kind: "ledger", ids: [ids.cash] });

      expect(liveCash).toMatchObject({ balance: "217.60", currencyRevalued: true });
      expect(bookCash).toBeDefined();
      expect(bookCash.balance).toBe(new Decimal(party.parties[0].closing).abs().toFixed(2));
      expect(bookCash.balanceSide).toBe(new Decimal(party.parties[0].closing).isNegative() ? "Cr" : "Dr");
      expect(bookCash).not.toHaveProperty("currencyRevalued");
    });

    it("keeps a date-filtered Accounts list at booked USD", async () => {
      const { accounts } = await accountsList(mali, { endDate: "2026-10-24" });
      const linked = accounts.find((a) => a.type === "ledger" && a.accountId === ids.custLedger);
      expect(linked).toMatchObject({ balance: "101.16", balanceSide: "Dr" });
      expect(linked).not.toHaveProperty("currencyRevalued");
    });

    it("shows revalued customer balances on ERP Customers stats, both signs", async () => {
      const { statusCode, body } = await call("GET /api/customers/stats", {
        session: { currentCompanyId: mali },
        query: {},
      });
      expect(statusCode).toBe(200);
      const c1 = body.find((c: { id: number }) => c.id === ids.c1);
      expect(c1).toMatchObject({
        balance: 100,
        balanceSide: "Dr",
        currencyRevalued: true,
        historicalBalanceUsd: "101.160000",
      });
      expect(c1.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
      const c2 = body.find((c: { id: number }) => c.id === ids.c2);
      expect(c2).toMatchObject({ balance: 19.77, balanceSide: "Cr", currencyRevalued: true });
      // The customer master row itself is untouched.
      const master = await pool.query(`SELECT opening_balance FROM customers WHERE id = $1`, [ids.c1]);
      expect(String(master.rows[0].opening_balance)).toMatch(/^0/);
    });

    it("shows revalued Factory customer ledger balances with no operational memo", async () => {
      const { statusCode, body } = await call("GET /api/factory/customers", {
        session: { factoryCompanyId: mali, currentCompanyId: mali },
        query: {},
      });
      expect(statusCode).toBe(200);
      const c1 = body.find((c: { id: number }) => c.id === ids.c1);
      expect(c1).toMatchObject({
        balance: 100,
        balanceSide: "Dr",
        ledgerBalance: 100,
        notInLedgerTotal: 0,
        currencyRevalued: true,
      });
      // An operational amount not yet posted to the ledger is never repriced: book figures stay.
      const c3 = body.find((c: { id: number }) => c.id === ids.c3);
      expect(c3).toMatchObject({
        balance: 106.16,
        ledgerBalance: 101.16,
        notInLedgerTotal: 5,
        monetaryFxProvisional: true,
      });
      expect(c3).not.toHaveProperty("currencyRevalued");
    });

    it("shows revalued balances on ERP Customers stats for a customer that also has a memo", async () => {
      const { body } = await call("GET /api/customers/stats", { session: { currentCompanyId: mali }, query: {} });
      expect(body.find((c: { id: number }) => c.id === ids.c3)).toMatchObject({
        balance: 100,
        balanceSide: "Dr",
        currencyRevalued: true,
      });
    });

    it("the balance engine's own customer balance is unchanged by the valuation", async () => {
      const { parties } = await getPartyBalances(db, { companyId: mali, kind: "customer", ids: [ids.c1] });
      expect(parties[0].closing).toBe("101.16");
      expect(parties[0].historicalBaseClosing).toBe("101.16");
    });
  });

  describe("Factory Net Position (/api/factory/net-position)", () => {
    const byName = (accounts: Array<{ name: string }>, name: string) => accounts.filter((a) => a.name === name);

    it("revalues today's cash, customer and loan rows and keeps a dated report at booked USD", async () => {
      const { statusCode, body } = await call("GET /api/factory/net-position", {
        session: { factoryCompanyId: factory, currentCompanyId: factory },
        query: {},
      });
      expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
      expect(body.currencyRevaluation).toMatchObject({
        valuationMode: "CURRENT",
        currentMonetaryTranslationApplied: true,
      });
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} FCASH`), 100, { currencyRevalued: true });
      expectAtCurrentRate(byName(body.forUs.accounts, `${PREFIX} customer FC1`), 100, {
        partyKind: "customer",
        partyId: ids.fCustomer,
        currencyRevalued: true,
      });
      expectAtCurrentRate(byName(body.onUs.accounts, `${PREFIX} FLOAN`), 100, { currencyRevalued: true });
      // Since #3163 the ledger totals are the booked USD of the rows shown (101.16); the
      // current-rate amount (100) is reported per row and the difference as FX gain/loss.
      expect(body.ledgerAssets).toBe(101.16);
      expect(body.ledgerLiabilities).toBe(101.16);
      expect(body.netPositionLabel).toMatch(/we have more|we owe more/i);

      const dated = await call("GET /api/factory/net-position", {
        session: { factoryCompanyId: factory, currentCompanyId: factory },
        query: { asOf: "2026-10-24" },
      });
      expect(dated.statusCode).toBe(200);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} FCASH`)).toEqual([
        expect.objectContaining({ value: 101.16 }),
      ]);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} FCASH`)[0]).not.toHaveProperty("currencyRevalued");
      expect(dated.body.currencyRevaluation).toBeUndefined();
    });

    it("does not borrow the ERP session's rate for a pinned secondary company", async () => {
      const { body } = await call("GET /api/factory/net-position", {
        session: { factoryCompanyId: factory, currentCompanyId: mali },
        query: {},
      });
      expect(byName(body.forUs.accounts, `${PREFIX} FCASH`)).toEqual([expect.objectContaining({ value: 101.16 })]);
      expect(body.currencyRevaluation).toBeUndefined();
    });
  });

  describe("Group Net Position", () => {
    it("carries each company's current translation into the group view", async () => {
      const group = await calculateGroupNetPosition(TODAY, new Set([zambia]), true);
      expect(group.companies).toHaveLength(1);
      const lines = group.companies[0].forUsLines;
      expect(lines.filter((l) => l.label === `${PREFIX} customer ZC1`)).toEqual([
        expect.objectContaining({ value: 100 }),
      ]);
      expect(lines.filter((l) => l.label === `${PREFIX} ZCASH`)).toEqual([expect.objectContaining({ value: 40 })]);
      const dated = await calculateGroupNetPosition("2026-10-24", new Set([zambia]), false);
      expect(dated.companies[0].forUsLines.filter((l) => l.label === `${PREFIX} customer ZC1`)).toEqual([
        expect.objectContaining({ value: 100 }),
      ]);
    });
  });

  describe("Balance Sheet (/api/reports/balance-sheet)", () => {
    it("shows current USD for monetary lines, balanced by a reporting-only equity line", async () => {
      const { statusCode, body, headers } = await call("GET /api/reports/balance-sheet", {
        session: { currentCompanyId: mali },
        query: {},
      });
      expect(statusCode).toBe(200);
      expect(headers["Cache-Control"]).toBe("private, no-store");
      const line = (side: "assets" | "liabilities", kind: string, id: number) =>
        body[side].lines.find((l: { kind: string; id: number }) => l.kind === kind && l.id === id);
      expect(line("assets", "customer", ids.c1)).toMatchObject({
        balance: "100.00",
        currencyRevalued: true,
        historicalBookUsd: "101.16",
      });
      expect(line("liabilities", "customer", ids.c2)).toMatchObject({ balance: "19.77", currencyRevalued: true });
      expect(line("assets", "bank", ids.bank)).toMatchObject({ balance: "49.43", currencyRevalued: true });
      expect(line("liabilities", "ledger", ids.loanPayable)).toMatchObject({
        balance: "100.00",
        currencyRevalued: true,
      });
      expect(line("assets", "ledger", ids.loanFlip)).toBeUndefined();
      expect(line("liabilities", "ledger", ids.loanFlip)).toMatchObject({ balance: "0.50", currencyRevalued: true });
      expect(line("assets", "ledger", ids.inventory)).toMatchObject({ balance: "100.00" });
      expect(line("assets", "ledger", ids.inventory)).not.toHaveProperty("currencyRevalued");
      const fx = body.equity.lines.find((l: { code: string }) => l.code === BALANCE_SHEET_FX_TRANSLATION_CODE);
      expect(fx).toMatchObject({ journalPosted: false });
      // The statement still foots: assets − liabilities − equity − unclassified is the
      // trial balance's own difference, unchanged by the translation.
      const book = await call("GET /api/reports/balance-sheet", {
        session: { currentCompanyId: mali },
        query: { asOfDate: TODAY },
      });
      expect(body.difference).toBe(book.body.difference);
      expect(body.balanced).toBe(book.body.balanced);
      expect(body.currencyRevaluation).toMatchObject({
        valuationMode: "CURRENT",
        fxVouchersPosted: false,
        bookBalancesModified: false,
      });
      // Dated statement: booked USD, no translation.
      expect(
        book.body.assets.lines.find((l: { kind: string; id: number }) => l.kind === "customer" && l.id === ids.c1)
      ).toMatchObject({ balance: "101.16" });
      expect(
        book.body.equity.lines.find((l: { code: string }) => l.code === BALANCE_SHEET_FX_TRANSLATION_CODE)
      ).toBeUndefined();
      expect(book.body.currencyRevaluation).toBeUndefined();
    });
  });
});
