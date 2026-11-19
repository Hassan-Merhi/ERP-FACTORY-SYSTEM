import { describe } from "vitest";
import Decimal from "decimal.js";
import { pool } from "../../server/db";
import { deleteAuditLogRowsForTests } from "./auditLogCleanup";
import { withFixtureTransaction } from "./voucherFixtureTransaction";
import { registerStatsNetProfitRoutes } from "../../server/routes/stats/statsNetProfitRoutes";
import { registerStatsMultiCurrencyRoutes } from "../../server/routes/stats/statsMultiCurrencyRoutes";
import { registerStatsSalesRoutes } from "../../server/routes/stats/statsSalesRoutes";
import { registerCustomerMasterRoutes } from "../../server/routes/customers/customerMasterRoutes";
import { registerFactoryCustomerCrudRoutes } from "../../server/routes/factory/customers-core/crud";
import { registerEmployeeNetPositionRoutes } from "../../server/routes/factory/employee-pos/employeeNetPositionRoutes";

export const hasDatabase = Boolean(process.env.DATABASE_URL);

export const databaseDescribe = hasDatabase ? describe : describe.skip;

export const PREFIX = "fxmv";

export const TODAY = new Date().toISOString().slice(0, 10);

export type Handler = (req: unknown, res: unknown, next?: () => unknown) => Promise<unknown> | unknown;

export const routes = new Map<string, Handler>();

export const middleware: Handler[] = [];

export const fakeApp = new Proxy(
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
export async function call(route: string, req: Record<string, unknown>) {
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

export async function insertId(query: string, params: unknown[]): Promise<number> {
  return (await pool.query<{ id: number }>(query, params)).rows[0].id;
}

export type Opening = {
  amount: string;
  side: "Dr" | "Cr";
  native?: string;
  currency?: string;
  base?: string;
  rate?: string;
};

export function openingColumns(opening?: Opening) {
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

export async function company(code: string, display: string | null, timezone = "Africa/Bamako", type = "erp") {
  const id = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency, display_currency)
     VALUES ($1, $2, $3, 'USD', $4) RETURNING id`,
    [`${PREFIX.toUpperCase()}-${code}`, `${PREFIX} ${code}`, type, display]
  );
  await pool.query(`INSERT INTO company_settings (company_id, timezone) VALUES ($1, $2)`, [id, timezone]);
  return id;
}

export async function ledger(companyId: number, code: string, type: string, opening?: Opening) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side,
                                  opening_balance_native_amount, opening_balance_currency,
                                  opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} ${code}`, type, o.amount, o.side, o.native, o.currency, o.rate, o.base]
  );
}

export async function bank(companyId: number, code: string, opening?: Opening, linkedLedgerId?: number) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, linked_ledger_id,
                                opening_balance, opening_balance_side, opening_balance_native_amount,
                                opening_balance_currency, opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, 'Test Bank', '000', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      `${PREFIX}-${code}`,
      `${PREFIX} bank ${code}`,
      linkedLedgerId ?? null,
      o.amount,
      o.side,
      o.native,
      o.currency,
      o.rate,
      o.base,
    ]
  );
}

export async function customer(companyId: number, code: string, ledgerAccountId?: number, opening?: Opening) {
  const o = openingColumns(opening);
  return insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id, opening_balance, opening_balance_side,
                            opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      companyId,
      `${PREFIX}-${code}`,
      `${PREFIX} customer ${code}`,
      ledgerAccountId ?? null,
      o.amount,
      o.side,
      o.native,
      o.currency,
      o.base,
    ]
  );
}

export async function supplier(companyId: number, code: string) {
  return insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, 'x@example.com') RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} supplier ${code}`]
  );
}

export async function rate(companyId: number, from: string, to: string, value: string, date: string) {
  return insertId(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, from, to, value, date]
  );
}

/** A posted voucher. Foreign lines carry the dual-currency evidence the ERP posting writes. */
export type Line = {
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

export let sequence = 0;

export async function voucher(
  companyId: number,
  currency: string,
  lines: Line[],
  voucherDate: string,
  exchangeRate?: string
) {
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
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.customer ?? null,
            line.supplier ?? null,
            new Decimal(baseDebit).toFixed(2),
            new Decimal(baseCredit).toFixed(2),
            line.foreign.currency,
            line.foreign.debit,
            line.foreign.credit,
            baseDebit,
            baseCredit,
            line.foreign.rate,
          ]
        );
      } else if (line.usd) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
             debit_amount, credit_amount, transaction_currency, transaction_debit_amount, transaction_credit_amount,
             base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $6, $7, $6, $7, 1, 'IDENTITY')`,
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.customer ?? null,
            line.supplier ?? null,
            line.usd.debit,
            line.usd.credit,
          ]
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
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.customer ?? null,
            line.supplier ?? null,
            line.unresolved.debit,
            line.unresolved.credit,
          ]
        );
        await client.query("SET LOCAL session_replication_role = origin");
      }
    }
    return created.rows[0].id;
  });
}

export async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX} %`]);
  for (const { id } of companies.rows) {
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]).catch(() => undefined);
    for (const table of [
      "exchange_rates",
      "customer_balances",
      "bank_accounts",
      "customers",
      "suppliers",
      "ledger_accounts",
      "company_settings",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query("DELETE FROM companies WHERE id = $1", [id]);
  }
}

/** Snapshot of everything a rate change must never touch. */
export async function bookSnapshot(companyId: number) {
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

export const usd = (cfa: string, perUsd: string) => new Decimal(cfa).div(perUsd).toDecimalPlaces(6).toFixed(6);

export let mali = 0;

export let zambia = 0;

export let usdOnly = 0;

export let euroCo = 0;

export let factory = 0;

export const ids: Record<string, number> = {};

/** Seeds the four FX companies, their rates, ledgers, parties and vouchers, and registers the routes under test. */
export async function seedMonetaryFxValuationFixture() {
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
  await voucher(
    mali,
    "CFA",
    [
      { ledger: ids.custLedger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ],
    "2026-10-21",
    "605"
  );
  // A customer in credit (customer-tagged line, no other target): 12,100 CFA.
  ids.c2 = await customer(mali, "C2");
  await voucher(
    mali,
    "CFA",
    [
      { customer: ids.c2, foreign: { currency: "CFA", debit: "0", credit: "12100", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "12100", credit: "0", rate: "605" } },
    ],
    "2026-10-21",
    "605"
  );
  // Cash: a resolved CFA opening (121,000 CFA booked as 200 USD) plus a USD line (mixed currencies).
  ids.cash = await ledger(mali, "CASH", "Cash", {
    amount: "200.00",
    side: "Dr",
    native: "121000",
    currency: "CFA",
    base: "200.000000",
    rate: "605",
  });
  await voucher(
    mali,
    "USD",
    [
      { ledger: ids.cash, usd: { debit: "10.00", credit: "0" } },
      { ledger: ids.sales, usd: { debit: "0", credit: "10.00" } },
    ],
    "2026-10-22"
  );
  // Bank linked to the cash ledger (bank_accounts.linked_ledger_id): a
  // bank-only CFA line (30,250 CFA) stays on the bank; a line naming both the
  // ledger and the bank (6,050 CFA) belongs to the ledger only (engine rule).
  ids.bank = await bank(mali, "BNK", undefined, ids.cash);
  await voucher(
    mali,
    "CFA",
    [
      { bank: ids.bank, foreign: { currency: "CFA", debit: "30250", credit: "0", rate: "605" } },
      { ledger: ids.cash, bank: ids.bank, foreign: { currency: "CFA", debit: "6050", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "36300", rate: "605" } },
    ],
    "2026-10-22",
    "605"
  );
  // Loans: a payable (Cr 61,200 CFA), a receivable (Dr 30,600 CFA) and one
  // that flips sign at 612: Dr 61,200 CFA (100 USD at 612) less a USD credit of 100.50.
  ids.loanPayable = await ledger(mali, "LOANP", "Loans");
  ids.loanReceivable = await ledger(mali, "LOANR", "Loan");
  ids.loanFlip = await ledger(mali, "LOANF", "Loans");
  await voucher(
    mali,
    "CFA",
    [
      { ledger: ids.loanPayable, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
      { ledger: ids.loanReceivable, foreign: { currency: "CFA", debit: "30600", credit: "0", rate: "605" } },
      { ledger: ids.loanFlip, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "30600", rate: "605" } },
    ],
    "2026-10-23",
    "605"
  );
  await voucher(
    mali,
    "USD",
    [
      { ledger: ids.loanFlip, usd: { debit: "0", credit: "100.50" } },
      { ledger: ids.sales, usd: { debit: "100.50", credit: "0" } },
    ],
    "2026-10-23"
  );
  // Never translated: inventory, a supplier, and a generic Asset (needs review).
  ids.inventory = await ledger(mali, "INVENTORY", "Asset");
  await pool.query(`UPDATE ledger_accounts SET code = 'INVENTORY' WHERE id = $1`, [ids.inventory]);
  ids.supplier = await supplier(mali, "S1");
  ids.deposit = await ledger(mali, "DEPOSIT", "Asset");
  await voucher(
    mali,
    "CFA",
    [
      { ledger: ids.inventory, foreign: { currency: "CFA", debit: "60500", credit: "0", rate: "605" } },
      { supplier: ids.supplier, foreign: { currency: "CFA", debit: "0", credit: "60500", rate: "605" } },
      { ledger: ids.deposit, foreign: { currency: "CFA", debit: "6050", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "6050", rate: "605" } },
    ],
    "2026-10-23",
    "605"
  );
  // Unresolved evidence: an opening with no currency, and a CFA voucher line without transaction fields.
  ids.cashNoCurrency = await ledger(mali, "CASH2", "Cash", { amount: "50.00", side: "Dr" });
  ids.cashLegacy = await ledger(mali, "CASH3", "Cash");
  await voucher(
    mali,
    "CFA",
    [
      { ledger: ids.cashLegacy, unresolved: { debit: "20.00", credit: "0" } },
      { ledger: ids.sales, unresolved: { debit: "0", credit: "20.00" } },
    ],
    "2026-10-23",
    "605"
  );
  // A customer with a posted CFA balance AND an operational amount not yet in
  // the ledger (a cache-only customer_balances row of 5 USD): the ledger part
  // is monetary, the memo is not.
  ids.c3Ledger = await ledger(mali, "C3LEDGER", "Asset");
  ids.c3 = await customer(mali, "C3", ids.c3Ledger);
  await voucher(
    mali,
    "CFA",
    [
      { ledger: ids.c3Ledger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.sales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ],
    "2026-10-21",
    "605"
  );
  await pool.query(
    `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, debit_amount, credit_amount, balance, currency, description)
       VALUES ($1, $2, '2026-10-22', 'LEGACY', 5, 0, 5, 'USD', 'legacy cache-only row')`,
    [mali, ids.c3]
  );
  // A currency with no company rate at all (GHS) on its own cash account.
  ids.cashGhs = await ledger(mali, "CASHGHS", "Cash");
  await voucher(
    mali,
    "GHS",
    [
      { ledger: ids.cashGhs, foreign: { currency: "GHS", debit: "150", credit: "0", rate: "15" } },
      { ledger: ids.sales, foreign: { currency: "GHS", debit: "0", credit: "150", rate: "15" } },
    ],
    "2026-10-23",
    "15"
  );

  // ── Zambia: a ZMW customer (2,500 ZMW at 25) and a ZMW cash account.
  ids.zSales = await ledger(zambia, "ZSALES", "Income");
  ids.zCash = await ledger(zambia, "ZCASH", "Cash");
  ids.zCustomer = await customer(zambia, "ZC1");
  await voucher(
    zambia,
    "ZMW",
    [
      { customer: ids.zCustomer, foreign: { currency: "ZMW", debit: "2500", credit: "0", rate: "25" } },
      { ledger: ids.zSales, foreign: { currency: "ZMW", debit: "0", credit: "2500", rate: "25" } },
    ],
    "2026-10-21",
    "25"
  );
  await voucher(
    zambia,
    "ZMW",
    [
      { ledger: ids.zCash, foreign: { currency: "ZMW", debit: "1000", credit: "0", rate: "25" } },
      { ledger: ids.zSales, foreign: { currency: "ZMW", debit: "0", credit: "1000", rate: "25" } },
    ],
    "2026-10-21",
    "25"
  );

  // ── USD-only company: a customer and cash, no rate rows at all.
  ids.uSales = await ledger(usdOnly, "USALES", "Income");
  ids.uCash = await ledger(usdOnly, "UCASH", "Cash", {
    amount: "300.00",
    side: "Dr",
    native: "300",
    currency: "USD",
    base: "300",
    rate: "1",
  });
  ids.uCustomer = await customer(usdOnly, "UC1");
  await voucher(
    usdOnly,
    "USD",
    [
      { customer: ids.uCustomer, usd: { debit: "75.25", credit: "0" } },
      { ledger: ids.uSales, usd: { debit: "0", credit: "75.25" } },
    ],
    "2026-10-21"
  );

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
  await voucher(
    factory,
    "CFA",
    [
      { ledger: ids.fCash, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.fCustLedger, foreign: { currency: "CFA", debit: "61200", credit: "0", rate: "605" } },
      { ledger: ids.fLoan, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
      { ledger: ids.fSales, foreign: { currency: "CFA", debit: "0", credit: "61200", rate: "605" } },
    ],
    "2026-10-21",
    "605"
  );

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
}
