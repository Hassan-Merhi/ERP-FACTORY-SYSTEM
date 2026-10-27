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
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { getMonetaryFxValuation } from "../server/services/accounting/monetaryFxValuationService";
import { saveCompanyExchangeRate } from "../server/services/accounting/exchangeRateWrites";
import { MonetaryFxError } from "../server/services/accounting/monetaryFxRates";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { registerStatsNetProfitRoutes } from "../server/routes/stats/statsNetProfitRoutes";
import { registerStatsMultiCurrencyRoutes } from "../server/routes/stats/statsMultiCurrencyRoutes";
import { registerStatsSalesRoutes } from "../server/routes/stats/statsSalesRoutes";
import { registerCustomerMasterRoutes } from "../server/routes/customers/customerMasterRoutes";
import { registerFactoryCustomerCrudRoutes } from "../server/routes/factory/customers-core/crud";
import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";
import { calculateGroupNetPosition } from "../server/helpers/groupNetPosition";
import { serveAccountListForCompany } from "../server/routes/accounts/all";
import { BALANCE_SHEET_FX_TRANSLATION_CODE } from "../server/services/accounting/monetaryFxReportOverlay";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

const PREFIX = "fxmv";
const TODAY = new Date().toISOString().slice(0, 10);

type Handler = (req: unknown, res: unknown, next?: () => unknown) => Promise<unknown> | unknown;
const routes = new Map<string, Handler>();
const middleware: Handler[] = [];
const fakeApp = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: unknown, ...handlers: Handler[]) => {
        if (method === "use" && typeof path === "function") middleware.push(path as Handler, ...handlers);
        else if (typeof path === "string") routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1)!);
      },
  }
) as never;

/** Calls a route through the registered app-level middleware (the live monetary translation). */
async function call(route: string, req: Record<string, unknown>) {
  const handler = routes.get(route);
  if (!handler) throw new Error(`route not registered: ${route}`);
  const [method, path] = route.split(" ");
  let statusCode = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const res: Record<string, any> = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    set: () => res,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
      return res;
    },
  };
  const request = { method, path, params: {}, query: {}, headers: { "x-client-date": TODAY }, body: {}, ...req };
  const dispatch = async (index: number): Promise<void> => {
    if (index < middleware.length) {
      let nextCalled: Promise<void> | undefined;
      await middleware[index](request, res, () => (nextCalled = dispatch(index + 1)));
      if (nextCalled) await nextCalled;
      return;
    }
    await handler(request, res);
  };
  await dispatch(0);
  return { statusCode, body, headers };
}

async function insertId(query: string, params: unknown[]): Promise<number> {
  return (await pool.query<{ id: number }>(query, params)).rows[0].id;
}

type Opening = { amount: string; side: "Dr" | "Cr"; native?: string; currency?: string; base?: string; rate?: string };

function openingColumns(opening?: Opening) {
  if (!opening) return { amount: "0", side: "Dr", native: null, currency: null, base: null, rate: null };
  return {
    amount: opening.amount,
    side: opening.side,
    native: opening.native ?? null,
    currency: opening.currency ?? null,
    base: opening.base ?? null,
    rate: opening.rate ?? null,
  };
}

async function company(code: string, display: string | null, timezone = "Africa/Bamako", type = "erp") {
  const id = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency, display_currency)
     VALUES ($1, $2, $3, 'USD', $4) RETURNING id`,
    [`${PREFIX.toUpperCase()}-${code}`, `${PREFIX} ${code}`, type, display]
  );
  await pool.query(`INSERT INTO company_settings (company_id, timezone) VALUES ($1, $2)`, [id, timezone]);
  return id;
}

async function ledger(companyId: number, code: string, type: string, opening?: Opening) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side,
                                  opening_balance_native_amount, opening_balance_currency,
                                  opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} ${code}`, type, o.amount, o.side, o.native, o.currency, o.rate, o.base]
  );
}

async function bank(companyId: number, code: string, opening?: Opening, linkedLedgerId?: number) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, linked_ledger_id,
                                opening_balance, opening_balance_side, opening_balance_native_amount,
                                opening_balance_currency, opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, 'Test Bank', '000', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} bank ${code}`, linkedLedgerId ?? null,
      o.amount, o.side, o.native, o.currency, o.rate, o.base]
  );
}

async function customer(companyId: number, code: string, ledgerAccountId?: number, opening?: Opening) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id, opening_balance, opening_balance_side,
                            opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} customer ${code}`, ledgerAccountId ?? null,
      o.amount, o.side, o.native, o.currency, o.base]
  );
}

async function supplier(companyId: number, code: string) {
  return insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, 'x@example.com') RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} supplier ${code}`]
  );
}

async function rate(companyId: number, from: string, to: string, value: string, date: string) {
  return insertId(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, from, to, value, date]
  );
}

/** A posted voucher. Foreign lines carry the dual-currency evidence the ERP posting writes. */
type Line = {
  ledger?: number;
  bank?: number;
  customer?: number;
  supplier?: number;
  /** Original-currency amounts (foreign voucher) with the historical rate (foreign per USD). */
  foreign?: { currency: string; debit: string; credit: string; rate: string };
  /** USD voucher line (no dual-currency fields: a legacy/USD voucher). */
  usd?: { debit: string; credit: string };
  /** Deliberately incomplete foreign evidence: voucher in CFA, line without transaction fields. */
  unresolved?: { debit: string; credit: string };
};
let sequence = 0;
async function voucher(companyId: number, currency: string, lines: Line[], voucherDate: string, exchangeRate?: string) {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Journal', $3, 0, $4, $5) RETURNING id`,
      [companyId, `${PREFIX}-${sequence}`, voucherDate, currency, exchangeRate ?? null]
    );
    for (const line of lines) {
      if (line.foreign) {
        const r = new Decimal(line.foreign.rate);
        const baseDebit = new Decimal(line.foreign.debit).div(r).toDecimalPlaces(6).toFixed(6);
        const baseCredit = new Decimal(line.foreign.credit).div(r).toDecimalPlaces(6).toFixed(6);
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
             debit_amount, credit_amount, transaction_currency, transaction_debit_amount, transaction_credit_amount,
             base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'TRANSACTION_PER_BASE')`,
          [created.rows[0].id, line.ledger ?? null, line.bank ?? null, line.customer ?? null, line.supplier ?? null,
            new Decimal(baseDebit).toFixed(2), new Decimal(baseCredit).toFixed(2), line.foreign.currency,
            line.foreign.debit, line.foreign.credit, baseDebit, baseCredit, line.foreign.rate]
        );
      } else if (line.usd) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
             debit_amount, credit_amount, transaction_currency, transaction_debit_amount, transaction_credit_amount,
             base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $6, $7, $6, $7, 1, 'IDENTITY')`,
          [created.rows[0].id, line.ledger ?? null, line.bank ?? null, line.customer ?? null, line.supplier ?? null,
            line.usd.debit, line.usd.credit]
        );
      } else if (line.unresolved) {
        // A pre-normalization legacy row: the currency guard would normalize a
        // new CFA line, so the trigger is bypassed for this statement only, the
        // way such rows actually exist in older company data.
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
             debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [created.rows[0].id, line.ledger ?? null, line.bank ?? null, line.customer ?? null, line.supplier ?? null,
            line.unresolved.debit, line.unresolved.credit]
        );
        await client.query("SET LOCAL session_replication_role = origin");
      }
    }
    return created.rows[0].id;
  });
}

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX} %`]);
  for (const { id } of companies.rows) {
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]).catch(() => undefined);
    for (const table of ["exchange_rates", "customer_balances", "bank_accounts", "customers", "suppliers", "ledger_accounts", "company_settings"]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query("DELETE FROM companies WHERE id = $1", [id]);
  }
}

/** Snapshot of everything a rate change must never touch. */
async function bookSnapshot(companyId: number) {
  const entries = await pool.query(
    `SELECT ve.id, ve.debit_amount, ve.credit_amount, ve.transaction_currency, ve.transaction_debit_amount,
            ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate,
            v.currency, v.exchange_rate, v.voucher_date, v.deleted_at
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = $1 ORDER BY ve.id`,
    [companyId]
  );
  const vouchers = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [companyId]);
  const openings = await pool.query(
    `SELECT 'ledger' AS kind, id, opening_balance, opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount
       FROM ledger_accounts WHERE company_id = $1
     UNION ALL
     SELECT 'bank', id, opening_balance, opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount
       FROM bank_accounts WHERE company_id = $1
     UNION ALL
     SELECT 'customer', id, opening_balance, opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount
       FROM customers WHERE company_id = $1
     ORDER BY 1, 2`,
    [companyId]
  );
  return { entries: entries.rows, voucherCount: vouchers.rows[0].n, openings: openings.rows };
}

const usd = (cfa: string, perUsd: string) => new Decimal(cfa).div(perUsd).toDecimalPlaces(6).toFixed(6);

let mali = 0;
let zambia = 0;
let usdOnly = 0;
let euroCo = 0;
let factory = 0;
const ids: Record<string, number> = {};

databaseDescribe("FX monetary valuation (database)", () => {
  beforeAll(async () => {
    await cleanup();
    mali = await company("MALI", "CFA");
    zambia = await company("ZAMBIA", "ZMW", "Africa/Lusaka");
    usdOnly = await company("USDONLY", null, "UTC");
    euroCo = await company("EURO", "EUR", "Europe/Paris");
    factory = await company("FACT", "CFA", "Africa/Bamako", "factory");

    // ── Rates. The future 650 must never be selected.
    await rate(mali, "USD", "CFA", "605", "2026-10-20");
    ids.maliRate612 = await rate(mali, "USD", "CFA", "612", "2026-10-25");
    await rate(mali, "USD", "CFA", "650", "2099-01-01");
    await rate(zambia, "USD", "ZMW", "25", "2026-10-20");
    // Reverse quote: USD per EUR.
    await rate(euroCo, "EUR", "USD", "1.2", "2026-10-20");

    // ── Mali ledger.
    ids.sales = await ledger(mali, "SALES", "Income");
    ids.custLedger = await ledger(mali, "CUSTLEDGER", "Asset");
    ids.c1 = await customer(mali, "C1", ids.custLedger);
    // The 61,200 CFA example, posted at 605 (historical USD 101.157025).
    await voucher(mali, "CFA", [
      { ledger: ids.custLedger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ], "2026-10-21", "605");
    // A customer in credit (customer-tagged line, no other target): 12,100 CFA.
    ids.c2 = await customer(mali, "C2");
    await voucher(mali, "CFA", [
      { customer: ids.c2, foreign: { currency: "CFA", debit: "0", credit: "12100", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "12100", credit: "0", rate: "605" } },
    ], "2026-10-21", "605");
    // Cash: a resolved CFA opening (121,000 CFA booked as 200 USD) plus a USD line (mixed currencies).
    ids.cash = await ledger(mali, "CASH", "Cash",
      { amount: "200.00", side: "Dr", native: "121000", currency: "CFA", base: "200.000000", rate: "605" });
    await voucher(mali, "USD", [
      { ledger: ids.cash, usd: { debit: "10.00", credit: "0" } },
      { ledger: ids.sales, usd: { debit: "0", credit: "10.00" } },
    ], "2026-10-22");
    // Bank linked to the cash ledger (bank_accounts.linked_ledger_id): a
    // bank-only CFA line (30,250 CFA) stays on the bank; a line naming both the
    // ledger and the bank (6,050 CFA) belongs to the ledger only (engine rule).
    ids.bank = await bank(mali, "BNK", undefined, ids.cash);
    await voucher(mali, "CFA", [
      { bank: ids.bank, foreign: { currency: "CFA", debit: "30250", credit: "0", rate: "605" } },
      { ledger: ids.cash, bank: ids.bank, foreign: { currency: "CFA", debit: "6050", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "36300", rate: "605" } },
    ], "2026-10-22", "605");
    // Loans: a payable (Cr 61,200 CFA), a receivable (Dr 30,600 CFA) and one
    // that flips sign at 612: Dr 61,200 CFA (100 USD at 612) less a USD credit of 100.50.
    ids.loanPayable = await ledger(mali, "LOANP", "Loans");
    ids.loanReceivable = await ledger(mali, "LOANR", "Loan");
    ids.loanFlip = await ledger(mali, "LOANF", "Loans");
    await voucher(mali, "CFA", [
      { ledger: ids.loanPayable, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
      { ledger: ids.loanReceivable, foreign: { currency: "CFA", debit: "30600", credit: "0", rate: "605" } },
      { ledger: ids.loanFlip, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "30600", rate: "605" } },
    ], "2026-10-23", "605");
    await voucher(mali, "USD", [
      { ledger: ids.loanFlip, usd: { debit: "0", credit: "100.50" } },
      { ledger: ids.sales, usd: { debit: "100.50", credit: "0" } },
    ], "2026-10-23");
    // Never translated: inventory, a supplier, and a generic Asset (needs review).
    ids.inventory = await ledger(mali, "INVENTORY", "Asset");
    await pool.query(`UPDATE ledger_accounts SET code = 'INVENTORY' WHERE id = $1`, [ids.inventory]);
    ids.supplier = await supplier(mali, "S1");
    ids.deposit = await ledger(mali, "DEPOSIT", "Asset");
    await voucher(mali, "CFA", [
      { ledger: ids.inventory, foreign: { currency: "CFA", debit: "60500", credit: "0", rate: "605" } },
      { supplier: ids.supplier, foreign: { currency: "CFA", debit: "0", credit: "60500", rate: "605" } },
      { ledger: ids.deposit, foreign: { currency: "CFA", debit: "6050", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "6050", rate: "605" } },
    ], "2026-10-23", "605");
    // Unresolved evidence: an opening with no currency, and a CFA voucher line without transaction fields.
    ids.cashNoCurrency = await ledger(mali, "CASH2", "Cash", { amount: "50.00", side: "Dr" });
    ids.cashLegacy = await ledger(mali, "CASH3", "Cash");
    await voucher(mali, "CFA", [
      { ledger: ids.cashLegacy, unresolved: { debit: "20.00", credit: "0" } },
      { ledger: ids.sales, unresolved: { debit: "0", credit: "20.00" } },
    ], "2026-10-23", "605");
    // A customer with a posted CFA balance AND an operational amount not yet in
    // the ledger (a cache-only customer_balances row of 5 USD): the ledger part
    // is monetary, the memo is not.
    ids.c3Ledger = await ledger(mali, "C3LEDGER", "Asset");
    ids.c3 = await customer(mali, "C3", ids.c3Ledger);
    await voucher(mali, "CFA", [
      { ledger: ids.c3Ledger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ], "2026-10-21", "605");
    await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, debit_amount, credit_amount, balance, currency, description)
       VALUES ($1, $2, '2026-10-22', 'LEGACY', 5, 0, 5, 'USD', 'legacy cache-only row')`,
      [mali, ids.c3]
    );
    // A currency with no company rate at all (GHS) on its own cash account.
    ids.cashGhs = await ledger(mali, "CASHGHS", "Cash");
    await voucher(mali, "GHS", [
      { ledger: ids.cashGhs, foreign: { currency: "GHS", debit: "150", credit: "0", rate: "15" } },
      { ledger: ids.sales, foreign: { currency: "GHS", debit: "0", credit: "150", rate: "15" } },
    ], "2026-10-23", "15");

    // ── Zambia: a ZMW customer (2,500 ZMW at 25) and a ZMW cash account.
    ids.zSales = await ledger(zambia, "ZSALES", "Income");
    ids.zCash = await ledger(zambia, "ZCASH", "Cash");
    ids.zCustomer = await customer(zambia, "ZC1");
    await voucher(zambia, "ZMW", [
      { customer: ids.zCustomer, foreign: { currency: "ZMW", debit: "2500", credit: "0", rate: "25" } },
      { ledger: ids.zSales, foreign: { currency: "ZMW", debit: "0", credit: "2500", rate: "25" } },
    ], "2026-10-21", "25");
    await voucher(zambia, "ZMW", [
      { ledger: ids.zCash, foreign: { currency: "ZMW", debit: "1000", credit: "0", rate: "25" } },
      { ledger: ids.zSales, foreign: { currency: "ZMW", debit: "0", credit: "1000", rate: "25" } },
    ], "2026-10-21", "25");

    // ── USD-only company: a customer and cash, no rate rows at all.
    ids.uSales = await ledger(usdOnly, "USALES", "Income");
    ids.uCash = await ledger(usdOnly, "UCASH", "Cash", { amount: "300.00", side: "Dr", native: "300", currency: "USD", base: "300", rate: "1" });
    ids.uCustomer = await customer(usdOnly, "UC1");
    await voucher(usdOnly, "USD", [
      { customer: ids.uCustomer, usd: { debit: "75.25", credit: "0" } },
      { ledger: ids.uSales, usd: { debit: "0", credit: "75.25" } },
    ], "2026-10-21");

    // ── Reverse quote company: 100 EUR customer at 1.2 USD per EUR... posted at 1.1.
    ids.eSales = await ledger(euroCo, "ESALES", "Income");
    ids.eCustomer = await customer(euroCo, "EC1");
    await withFixtureTransaction(async (client) => {
      const created = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
         VALUES ($1, $2, 'Journal', '2026-10-21', 0, 'EUR') RETURNING id`,
        [euroCo, `${PREFIX}-eur`]
      );
      // base = 100 EUR * 1.1 USD/EUR = 110 USD, stored as BASE_PER_TRANSACTION evidence.
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, customer_id, debit_amount, credit_amount, transaction_currency,
           transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount, historical_exchange_rate,
           rate_convention)
         VALUES ($1, $2, 110, 0, 'EUR', 100, 0, 110, 0, 1.1, 'BASE_PER_TRANSACTION')`,
        [created.rows[0].id, ids.eCustomer]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
           transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount, historical_exchange_rate,
           rate_convention)
         VALUES ($1, $2, 0, 110, 'EUR', 0, 100, 0, 110, 1.1, 'BASE_PER_TRANSACTION')`,
        [created.rows[0].id, ids.eSales]
      );
    });

    // ── Factory company: CFA cash, a CFA customer with a linked ledger and a CFA loan payable.
    await rate(factory, "USD", "CFA", "612", "2026-10-25");
    ids.fSales = await ledger(factory, "FSALES", "Income");
    ids.fCash = await ledger(factory, "FCASH", "Cash");
    ids.fCustLedger = await ledger(factory, "FCUSTLEDGER", "Asset");
    ids.fCustomer = await customer(factory, "FC1", ids.fCustLedger);
    ids.fLoan = await ledger(factory, "FLOAN", "Loans");
    await voucher(factory, "CFA", [
      { ledger: ids.fCash, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.fCustLedger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.fLoan, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
      { ledger: ids.fSales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ], "2026-10-21", "605");

    // The dated Factory report reconstructs what was KNOWN on the day
    // (created_at): record the factory fixture as created before its vouchers.
    await pool.query(`UPDATE ledger_accounts SET created_at = '2026-10-01 00:00' WHERE company_id = $1`, [factory]);
    await pool.query(`UPDATE customers SET created_at = '2026-10-01 00:00' WHERE company_id = $1`, [factory]);
    await pool.query(`UPDATE vouchers SET created_at = '2026-10-21 08:00' WHERE company_id = $1`, [factory]);
    await pool.query(
      `UPDATE voucher_entries SET created_at = '2026-10-21 08:00' WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [factory]
    );

    registerStatsMultiCurrencyRoutes(fakeApp);
    registerStatsNetProfitRoutes(fakeApp);
    registerEmployeeNetPositionRoutes(fakeApp);
    registerStatsSalesRoutes(fakeApp);
    registerCustomerMasterRoutes(fakeApp);
    registerFactoryCustomerCrudRoutes(fakeApp);
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
        rate: "612.0000000000", direction: "FOREIGN_PER_USD", effectiveDate: "2026-10-25",
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
      expect(e.rates.find((r) => r.currency === "EUR")).toMatchObject({ direction: "USD_PER_FOREIGN", rate: "1.2000000000" });
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
        (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'exchange_rates'`, [mali])).rows[0].n;
      const auditsBefore = await audits();
      const actor = { userId: "1", username: "fx-test", companyId: mali };
      const saved = await saveCompanyExchangeRate(actor, { fromCurrency: "USD", toCurrency: "CFA", rate: "620", effectiveDate: TODAY });
      expect(String(saved.rate)).toMatch(/^620/);
      expect(await audits()).toBe(auditsBefore + 1);

      const valuation = await getMonetaryFxValuation(mali);
      const c1 = row(valuation, `customer:${ids.c1}`);
      expect(c1.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
      expect(c1.historicalBaseUsd).toBe("101.157025");
      expect(c1.currentTranslatedUsd).toBe(usd("61200", "620"));
      expect(row(valuation, `ledger:${ids.loanPayable}`).currentTranslatedUsd).toBe(new Decimal("-61200").div(620).toDecimalPlaces(6).toFixed(6));
      expect(await bookSnapshot(mali)).toEqual(before);

      // Repeating the same rate is a no-op: no second audit row, same valuation.
      const again = await saveCompanyExchangeRate(actor, { fromCurrency: "USD", toCurrency: "CFA", rate: "620", effectiveDate: TODAY });
      expect(again.id).toBe(saved.id);
      expect(await audits()).toBe(auditsBefore + 1);
      expect(await getMonetaryFxValuation(mali)).toEqual(valuation);

      // Back to 612 for the screen tests below (a revision, audited once more).
      await saveCompanyExchangeRate(actor, { fromCurrency: "USD", toCurrency: "CFA", rate: "612", effectiveDate: TODAY });
      expect(await audits()).toBe(auditsBefore + 2);
      expect(row(await getMonetaryFxValuation(mali), `customer:${ids.c1}`).currentTranslatedUsd).toBe("100.000000");
      expect(await bookSnapshot(mali)).toEqual(before);
    });

    it("in one company never changes another company's valuation", async () => {
      const maliBefore = await getMonetaryFxValuation(mali);
      await saveCompanyExchangeRate({ userId: "1", username: "fx-test", companyId: zambia },
        { fromCurrency: "USD", toCurrency: "ZMW", rate: "26", effectiveDate: TODAY });
      expect(row(await getMonetaryFxValuation(zambia), `customer:${ids.zCustomer}`).currentTranslatedUsd)
        .toBe(new Decimal(2500).div(26).toDecimalPlaces(6).toFixed(6));
      expect(await getMonetaryFxValuation(mali)).toEqual(maliBefore);
      await saveCompanyExchangeRate({ userId: "1", username: "fx-test", companyId: zambia },
        { fromCurrency: "USD", toCurrency: "ZMW", rate: "25", effectiveDate: TODAY });
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
          saveCompanyExchangeRate({ userId: "1", username: "fx-test", companyId: zambia },
            { fromCurrency: "USD", toCurrency: "ZMW", rate: "27", effectiveDate: TODAY })
        ).rejects.toMatchObject({ code: "FX_RATE_CONFLICT" } satisfies Partial<MonetaryFxError>);
        const stored = await pool.query(`SELECT rate FROM exchange_rates WHERE company_id = $1 AND from_currency = 'USD' AND to_currency = 'ZMW' AND effective_date = $2`, [zambia, TODAY]);
        expect(String(stored.rows[0].rate)).toMatch(/^25/);
      } finally {
        await pool.query(`DELETE FROM exchange_rates WHERE id = $1`, [inverse]);
      }
      expect(row(await getMonetaryFxValuation(zambia), `customer:${ids.zCustomer}`).currentTranslatedUsd).toBe("100.000000");
    });

    it("cannot store a duplicate rate row for one company, date and pair", async () => {
      await expect(rate(mali, "USD", "CFA", "700", "2026-10-25")).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("ERP Net Position (/api/stats/net-profit)", () => {
    const byName = (accounts: Array<{ name: string }>, name: string) => accounts.filter((a) => a.name === name);

    it("shows cash, bank, customers and loans at the current rate, each once, with correct sides", async () => {
      const { statusCode, body } = await call("GET /api/stats/net-profit", { session: { currentCompanyId: mali }, query: {} });
      expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
      expect(body.currencyRevaluation.valuationMode).toBe("CURRENT");
      expect(body.currencyRevaluation.currentCfaPerUsd).toBe("612.0000000000");
      expect(body.currency.currentCashBankTranslationApplied).toBe(true);

      expect(byName(body.forUs.accounts, `${PREFIX} customer C1`)).toEqual([
        expect.objectContaining({ value: 100, partyKind: "customer", partyId: ids.c1, currencyRevalued: true }),
      ]);
      expect(byName(body.onUs.accounts, `${PREFIX} customer C2`)).toEqual([
        expect.objectContaining({ value: 19.77, currencyRevalued: true }),
      ]);
      expect(byName(body.forUs.accounts, `${PREFIX} CASH`)).toEqual([
        expect.objectContaining({ value: 217.6, currencyRevalued: true }),
      ]);
      expect(byName(body.forUs.accounts, `${PREFIX} bank BNK`)).toEqual([
        expect.objectContaining({ value: 49.43, bankAccountId: ids.bank, currencyRevalued: true }),
      ]);
      expect(byName(body.onUs.accounts, `${PREFIX} LOANP`)).toEqual([expect.objectContaining({ value: 100, currencyRevalued: true })]);
      expect(byName(body.forUs.accounts, `${PREFIX} LOANR`)).toEqual([
        expect.objectContaining({ value: 50, category: "Loan Deposits", currencyRevalued: true }),
      ]);
      // The sign flip moved the loan from What We Have to What We Owe, labelled as a loan, not a deposit.
      expect(byName(body.forUs.accounts, `${PREFIX} LOANF`)).toEqual([]);
      expect(byName(body.onUs.accounts, `${PREFIX} LOANF`)).toEqual([
        expect.objectContaining({ value: 0.5, category: "Loans", currencyRevalued: true }),
      ]);
      // A customer with an unposted memo: its ledger balance is revalued; the memo stays
      // in the "not yet in the ledger" section, never added to the totals.
      expect(byName(body.forUs.accounts, `${PREFIX} customer C3`)).toEqual([
        expect.objectContaining({ value: 100, partyKind: "customer", partyId: ids.c3, currencyRevalued: true }),
      ]);
      expect(body.notInLedger.total).toBe(5);
      // Untouched: inventory, the generic asset, the unresolved accounts and the supplier.
      expect(byName(body.forUs.accounts, `${PREFIX} DEPOSIT`)).toEqual([expect.objectContaining({ value: 10 })]);
      expect(byName(body.forUs.accounts, `${PREFIX} DEPOSIT`)[0]).not.toHaveProperty("currencyRevalued");
      expect(byName(body.forUs.accounts, `${PREFIX} CASH2`)).toEqual([expect.objectContaining({ value: 50 })]);
      expect(byName(body.onUs.accounts, `${PREFIX} supplier S1`)).toEqual([expect.objectContaining({ value: 100 })]);
      const skipped = body.currencyRevaluation.skippedAccountKeys.map((s: { key: string }) => s.key);
      expect(skipped).toEqual(expect.arrayContaining([`ledger:${ids.cashNoCurrency}`, `ledger:${ids.cashLegacy}`, `ledger:${ids.cashGhs}`]));
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
      const dated = await call("GET /api/stats/net-profit", { session: { currentCompanyId: mali }, query: { toDate: "2026-10-24" } });
      expect(dated.statusCode).toBe(200);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} customer C1`)).toEqual([expect.objectContaining({ value: 101.16 })]);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} customer C1`)[0]).not.toHaveProperty("currencyRevalued");
      expect(dated.body.currencyRevaluation?.valuationMode).toBeUndefined();
    });
  });

  describe("Accounts list, Customers and Factory customers", () => {
    async function accountsList(companyId: number, query: Record<string, string> = {}) {
      let body: any;
      const res = { json: (value: unknown) => (body = value), status: () => res, setHeader: () => res } as never;
      await serveAccountListForCompany({ query, headers: { "x-client-date": TODAY }, session: { currentCompanyId: companyId } } as never, res, companyId);
      return body as { accounts: any[] };
    }

    it("lists current USD for eligible accounts, with the linked customer ledger under its customer", async () => {
      const { accounts } = await accountsList(mali);
      const find = (type: string, accountId: number) => accounts.find((a) => a.type === type && a.accountId === accountId);
      expect(find("ledger", ids.custLedger)).toMatchObject({
        balance: "100.00", balanceSide: "Dr", customerId: ids.c1, currencyRevalued: true, historicalBalanceUsd: "101.160000",
        // The Accounts page displays the Parties projection for customer rows.
        partyBalance: "100.00", partyBalanceSide: "Dr", partyLedgerBalance: "100.00",
      });
      // A customer whose Parties projection carries an unposted memo keeps its book figures.
      expect(find("ledger", ids.c3Ledger)).toMatchObject({
        balance: "101.16", partyBalance: "106.16", notInLedgerTotal: "5.00", monetaryFxProvisional: true,
      });
      expect(find("ledger", ids.c3Ledger)).not.toHaveProperty("currencyRevalued");
      expect(find("ledger", ids.cash)).toMatchObject({ balance: "217.60", balanceSide: "Dr", currencyRevalued: true });
      expect(find("bank", ids.bank)).toMatchObject({ balance: "49.43", balanceSide: "Dr", currencyRevalued: true });
      expect(find("ledger", ids.loanPayable)).toMatchObject({ balance: "100.00", balanceSide: "Cr", currencyRevalued: true });
      expect(find("ledger", ids.loanFlip)).toMatchObject({ balance: "0.50", balanceSide: "Cr", currencyRevalued: true });
      expect(find("ledger", ids.cashNoCurrency)).toMatchObject({ balance: "50.00", monetaryFxProvisional: true });
      expect(find("ledger", ids.inventory)).toMatchObject({ balance: "100.00" });
      expect(find("ledger", ids.inventory)).not.toHaveProperty("currencyRevalued");
      expect(find("ledger", ids.deposit)).not.toHaveProperty("currencyRevalued");
    });

    it("keeps a date-filtered Accounts list at booked USD", async () => {
      const { accounts } = await accountsList(mali, { endDate: "2026-10-24" });
      const linked = accounts.find((a) => a.type === "ledger" && a.accountId === ids.custLedger);
      expect(linked).toMatchObject({ balance: "101.16", balanceSide: "Dr" });
      expect(linked).not.toHaveProperty("currencyRevalued");
    });

    it("shows revalued customer balances on ERP Customers stats, both signs", async () => {
      const { statusCode, body } = await call("GET /api/customers/stats", { session: { currentCompanyId: mali }, query: {} });
      expect(statusCode).toBe(200);
      const c1 = body.find((c: { id: number }) => c.id === ids.c1);
      expect(c1).toMatchObject({ balance: 100, balanceSide: "Dr", currencyRevalued: true, historicalBalanceUsd: "101.160000" });
      expect(c1.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
      const c2 = body.find((c: { id: number }) => c.id === ids.c2);
      expect(c2).toMatchObject({ balance: 19.77, balanceSide: "Cr", currencyRevalued: true });
      // The customer master row itself is untouched.
      const master = await pool.query(`SELECT opening_balance FROM customers WHERE id = $1`, [ids.c1]);
      expect(String(master.rows[0].opening_balance)).toMatch(/^0/);
    });

    it("shows revalued Factory customer ledger balances with no operational memo", async () => {
      const { statusCode, body } = await call("GET /api/factory/customers", { session: { factoryCompanyId: mali, currentCompanyId: mali }, query: {} });
      expect(statusCode).toBe(200);
      const c1 = body.find((c: { id: number }) => c.id === ids.c1);
      expect(c1).toMatchObject({ balance: 100, balanceSide: "Dr", ledgerBalance: 100, notInLedgerTotal: 0, currencyRevalued: true });
      // An operational amount not yet posted to the ledger is never repriced: book figures stay.
      const c3 = body.find((c: { id: number }) => c.id === ids.c3);
      expect(c3).toMatchObject({ balance: 106.16, ledgerBalance: 101.16, notInLedgerTotal: 5, monetaryFxProvisional: true });
      expect(c3).not.toHaveProperty("currencyRevalued");
    });

    it("shows revalued balances on ERP Customers stats for a customer that also has a memo", async () => {
      const { body } = await call("GET /api/customers/stats", { session: { currentCompanyId: mali }, query: {} });
      expect(body.find((c: { id: number }) => c.id === ids.c3)).toMatchObject({ balance: 100, balanceSide: "Dr", currencyRevalued: true });
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
        session: { factoryCompanyId: factory, currentCompanyId: factory }, query: {},
      });
      expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
      expect(body.currencyRevaluation).toMatchObject({ valuationMode: "CURRENT", currentMonetaryTranslationApplied: true });
      expect(byName(body.forUs.accounts, `${PREFIX} FCASH`)).toEqual([expect.objectContaining({ value: 100, currencyRevalued: true })]);
      expect(byName(body.forUs.accounts, `${PREFIX} customer FC1`)).toEqual([
        expect.objectContaining({ value: 100, partyKind: "customer", partyId: ids.fCustomer, currencyRevalued: true }),
      ]);
      expect(byName(body.onUs.accounts, `${PREFIX} FLOAN`)).toEqual([expect.objectContaining({ value: 100, currencyRevalued: true })]);
      expect(body.ledgerAssets).toBe(100);
      expect(body.ledgerLiabilities).toBe(100);
      expect(body.netPositionLabel).toMatch(/we have more|we owe more/i);

      const dated = await call("GET /api/factory/net-position", {
        session: { factoryCompanyId: factory, currentCompanyId: factory }, query: { asOf: "2026-10-24" },
      });
      expect(dated.statusCode).toBe(200);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} FCASH`)).toEqual([expect.objectContaining({ value: 101.16 })]);
      expect(byName(dated.body.forUs.accounts, `${PREFIX} FCASH`)[0]).not.toHaveProperty("currencyRevalued");
      expect(dated.body.currencyRevaluation).toBeUndefined();
    });

    it("does not borrow the ERP session's rate for a pinned secondary company", async () => {
      const { body } = await call("GET /api/factory/net-position", {
        session: { factoryCompanyId: factory, currentCompanyId: mali }, query: {},
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
      expect(lines.filter((l) => l.label === `${PREFIX} customer ZC1`)).toEqual([expect.objectContaining({ value: 100 })]);
      expect(lines.filter((l) => l.label === `${PREFIX} ZCASH`)).toEqual([expect.objectContaining({ value: 40 })]);
      const dated = await calculateGroupNetPosition("2026-10-24", new Set([zambia]), false);
      expect(dated.companies[0].forUsLines.filter((l) => l.label === `${PREFIX} customer ZC1`)).toEqual([expect.objectContaining({ value: 100 })]);
    });
  });

  describe("Balance Sheet (/api/reports/balance-sheet)", () => {
    it("shows current USD for monetary lines, balanced by a reporting-only equity line", async () => {
      const { statusCode, body, headers } = await call("GET /api/reports/balance-sheet", { session: { currentCompanyId: mali }, query: {} });
      expect(statusCode).toBe(200);
      expect(headers["Cache-Control"]).toBe("private, no-store");
      const line = (side: "assets" | "liabilities", kind: string, id: number) =>
        body[side].lines.find((l: { kind: string; id: number }) => l.kind === kind && l.id === id);
      expect(line("assets", "customer", ids.c1)).toMatchObject({ balance: "100.00", currencyRevalued: true, historicalBookUsd: "101.16" });
      expect(line("liabilities", "customer", ids.c2)).toMatchObject({ balance: "19.77", currencyRevalued: true });
      expect(line("assets", "bank", ids.bank)).toMatchObject({ balance: "49.43", currencyRevalued: true });
      expect(line("liabilities", "ledger", ids.loanPayable)).toMatchObject({ balance: "100.00", currencyRevalued: true });
      expect(line("assets", "ledger", ids.loanFlip)).toBeUndefined();
      expect(line("liabilities", "ledger", ids.loanFlip)).toMatchObject({ balance: "0.50", currencyRevalued: true });
      expect(line("assets", "ledger", ids.inventory)).toMatchObject({ balance: "100.00" });
      expect(line("assets", "ledger", ids.inventory)).not.toHaveProperty("currencyRevalued");
      const fx = body.equity.lines.find((l: { code: string }) => l.code === BALANCE_SHEET_FX_TRANSLATION_CODE);
      expect(fx).toMatchObject({ journalPosted: false });
      // The statement still foots: assets − liabilities − equity − unclassified is the
      // trial balance's own difference, unchanged by the translation.
      const book = await call("GET /api/reports/balance-sheet", { session: { currentCompanyId: mali }, query: { asOfDate: TODAY } });
      expect(body.difference).toBe(book.body.difference);
      expect(body.balanced).toBe(book.body.balanced);
      expect(body.currencyRevaluation).toMatchObject({ valuationMode: "CURRENT", fxVouchersPosted: false, bookBalancesModified: false });
      // Dated statement: booked USD, no translation.
      expect(book.body.assets.lines.find((l: { kind: string; id: number }) => l.kind === "customer" && l.id === ids.c1))
        .toMatchObject({ balance: "101.16" });
      expect(book.body.equity.lines.find((l: { code: string }) => l.code === BALANCE_SHEET_FX_TRANSLATION_CODE)).toBeUndefined();
      expect(book.body.currencyRevaluation).toBeUndefined();
    });
  });
});
