/**
 * Accounting audit wave 10, part 2: one customer engine.
 *
 * Every customer reader takes its figure, and every customer statement its
 * lines, from the one balance engine (ledgerBalanceEngine.ts +
 * partyLineRules.ts):
 *   - the sum over all parties equals the trial balance, and each posted line
 *     is attributed to exactly one party (a customer-tagged line on another
 *     ledger or on a bank is that target's; a ledger linked to two customers
 *     belongs to the lower id; a line naming a bank and its linked ledger is
 *     counted once);
 *   - /api/customers/stats, getCustomerBalance, the overdue reminder, the
 *     paginated customer statement, customer transactions and the account
 *     pre-period balance equal getPartyBalances;
 *   - amounts that never reached the ledger (factory POS credit sales and
 *     deposits, factory invoices with no INV-GL journal) are memo lines: listed
 *     on the customer transactions as `notInLedger` rows, never in the rows or
 *     the pre-period figure;
 *   - the factory customer pages show the engine closing plus the memo total,
 *     with the combined figure kept in `balance` and the split alongside.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  return { ...actual, requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() };
});
vi.mock("../server/routes/helpers/supplierBalanceHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/routes/helpers/supplierBalanceHelpers")>();
  return { ...actual, authorizeCompanyIdParam: async (_req: unknown, companyId: number) => companyId };
});

import { db, pool } from "../server/db";
import { getPartyBalance, getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import {
  loadCustomerLedgerLines,
  loadCustomerNotInLedger,
} from "../server/services/accounting/balances/customerLedgerStatement";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { getCustomersWithBalances } from "../server/routes/customers/customerBalanceQuery";
import { getCustomerBalance } from "../server/storage/accounting/customer-balances";
import { loadOverdueCustomerBalances } from "../server/services/scheduler/overdueCustomerQuery";
import { runCustomerBalanceStatement } from "../server/routes/account-transaction-pagination/customerBalanceStatement";
import { registerAccountTransactionRoutes } from "../server/routes/accountTransactionRoutes";
import { registerAccountStatementRoutes } from "../server/routes/accountStatementRoutes";
import { registerAccountLedgerBalanceRoutes } from "../server/routes/accounts/ledger-balance";
import { serveAccountListForCompany } from "../server/routes/accounts/all";
import { registerFactoryCustomerCrudRoutes } from "../server/routes/factory/customers-core/crud";
import { registerFactoryCustomerStatementRoutes } from "../server/routes/factory/customers-core/statement";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w10eng";
const KINDS = ["ledger", "bank", "fixedAsset", "supplier", "employee", "factorySupplier", "customer"] as const;

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;
const routes = new Map<string, Handler>();
const fakeApp = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: string, ...handlers: Handler[]) => {
        if (typeof path === "string") routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1)!);
      },
  }
) as never;

async function call(route: string, req: Record<string, unknown>) {
  const handler = routes.get(route);
  if (!handler) throw new Error(`route not registered: ${route}`);
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    set: () => res,
    setHeader: () => res,
  };
  await handler({ params: {}, query: {}, headers: { "x-client-date": "2026-10-08" }, body: {}, ...req }, res);
  return { statusCode, body };
}

let erp: number;
let factory: number;
let cash: number;
let sales: number;
let stray: number;
let custLedger: number;
let sharedLedger: number;
let bankLedger: number;
let bank: number;
let c1: number;
let c2: number;
let c3: number;
let c4: number;
let supplier: number;
let employee: number;
let fCash: number;
let fSales: number;
let fCustLedger: number;
let fCustomer: number;
let unpostedOrder: number;
let postedOrder: number;
let sequence = 0;

type Line = {
  ledger?: number;
  bank?: number;
  customer?: number;
  supplier?: number;
  employee?: number;
  debit: string;
  credit: string;
};

async function voucher(companyId: number, lines: Line[], voucherDate: string, number?: string) {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, 'Journal', $3, 0, 'USD') RETURNING id`,
      [companyId, number ?? `${PREFIX}-${sequence}`, voucherDate]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
                                      employee_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          created.rows[0].id,
          line.ledger ?? null,
          line.bank ?? null,
          line.customer ?? null,
          line.supplier ?? null,
          line.employee ?? null,
          line.debit,
          line.credit,
        ]
      );
    }
    return created.rows[0].id;
  });
}

async function insertId(query: string, params: unknown[]): Promise<number> {
  return (await pool.query<{ id: number }>(query, params)).rows[0].id;
}

async function ledger(companyId: number, code: string, type: string, opening = "0", side = "Dr") {
  return insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} ${code}`, type, opening, side]
  );
}

async function customer(companyId: number, code: string, opening: string, ledgerId: number | null, terms?: number) {
  return insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id,
                            payment_terms_days)
     VALUES ($1, $2, $3, $4, 'Dr', $5, $6) RETURNING id`,
    [companyId, `${PREFIX}${code}`, `${PREFIX} customer ${code}`, opening, ledgerId, terms ?? null]
  );
}

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX}%`]);
  for (const { id } of companies.rows) {
    await pool.query(
      "DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)",
      [id]
    );
    await pool.query("DELETE FROM customer_orders WHERE company_id = $1", [id]);
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await pool.query("DELETE FROM customer_balances WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM employees WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM bank_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM companies WHERE id = $1", [id]);
  }
}

beforeAll(async () => {
  await cleanup();
  erp = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}E`, `${PREFIX} erp company`]
  );
  factory = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}F`, `${PREFIX} factory company`]
  );

  // ── ERP company ─────────────────────────────────────────────────────────
  cash = await ledger(erp, "CASH", "Asset", "1000", "Dr");
  sales = await ledger(erp, "SALES", "Income", "0", "Cr");
  stray = await ledger(erp, "STRAY", "Asset");
  custLedger = await ledger(erp, "CUST1", "Asset");
  sharedLedger = await ledger(erp, "SHARED", "Asset");
  bankLedger = await ledger(erp, "BANKLEDGER", "Bank");
  bank = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance,
                                opening_balance_side, linked_ledger_id)
     VALUES ($1, $2, $3, 'Bank', '001', 50, 'Dr', $4) RETURNING id`,
    [erp, `${PREFIX}-B1`, `${PREFIX} bank`, bankLedger]
  );
  c1 = await customer(erp, "C1", "100", custLedger, 1);
  c2 = await customer(erp, "C2", "0", null);
  c3 = await customer(erp, "C3", "0", sharedLedger);
  c4 = await customer(erp, "C4", "10", sharedLedger);
  supplier = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 0, 'Cr') RETURNING id`,
    [erp, `${PREFIX}S1`, `${PREFIX} supplier`, `${PREFIX}@example.test`]
  );
  employee = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Wave', 'Ten', '2026-01-01') RETURNING id`,
    [erp, `${PREFIX}E1`]
  );

  // C1: invoiced 300 on its linked ledger (09-02), paid 50 on a customer-only line (09-04).
  await voucher(
    erp,
    [
      { ledger: custLedger, customer: c1, debit: "300.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "300.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    erp,
    [
      { ledger: cash, debit: "50.00", credit: "0" },
      { customer: c1, debit: "0", credit: "50.00" },
    ],
    "2026-09-04"
  );
  // A C1-tagged line on another ledger is that ledger's.
  await voucher(
    erp,
    [
      { ledger: cash, debit: "20.00", credit: "0" },
      { ledger: stray, customer: c1, debit: "0", credit: "20.00" },
    ],
    "2026-09-05"
  );
  // C2 (no ledger): a C2-tagged bank line is the bank's; the customer-only line is C2's.
  await voucher(
    erp,
    [
      { bank, customer: c2, debit: "30.00", credit: "0" },
      { customer: c2, debit: "0", credit: "30.00" },
    ],
    "2026-09-06"
  );
  // A line on the ledger C3 and C4 both link goes to the lower id (C3), whatever it is tagged with.
  await voucher(
    erp,
    [
      { ledger: sharedLedger, customer: c4, debit: "80.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "80.00" },
    ],
    "2026-09-07"
  );
  // A line naming a bank and its linked ledger is counted once (the ledger's).
  await voucher(
    erp,
    [
      { ledger: bankLedger, bank, debit: "25.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "25.00" },
    ],
    "2026-09-08"
  );
  await voucher(
    erp,
    [
      { supplier, debit: "10.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "10.00" },
      { ledger: cash, debit: "5.00", credit: "0" },
      { employee, debit: "0", credit: "5.00" },
    ],
    "2026-09-09"
  );

  // ── Factory company ─────────────────────────────────────────────────────
  fCash = await ledger(factory, "FCASH", "Asset");
  fSales = await ledger(factory, "FSALES", "Income", "0", "Cr");
  const fCharge = await ledger(factory, "FCHARGE", "Income", "0", "Cr");
  fCustLedger = await ledger(factory, "FCUST", "Asset");
  fCustomer = await customer(factory, "FC1", "0", fCustLedger);
  // Invoice 1 (finalized before the cut-over: no INV-GL journal): 500, of which a
  // 40 charge has its own CHARGE- voucher on the customer ledger.
  unpostedOrder = await insertId(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total, finalized_at)
     VALUES ($1, $2, '2026-09-01', 'FINALIZED', 'W10-INV-1', 500, '2026-09-01T10:00:00Z') RETURNING id`,
    [factory, fCustomer]
  );
  const chargeVoucher = await voucher(
    factory,
    [
      { ledger: fCustLedger, customer: fCustomer, debit: "40.00", credit: "0" },
      { ledger: fCharge, debit: "0", credit: "40.00" },
    ],
    "2026-09-01",
    `CHARGE-W10-INV-1-${factory}`
  );
  await pool.query(
    `INSERT INTO customer_order_charges (order_id, name, amount, charge_type, voucher_id)
     VALUES ($1, 'Freight', 40, 'FREIGHT', $2)`,
    [unpostedOrder, chargeVoucher]
  );
  // Invoice 2 (after the cut-over): its INV-GL journal is in the ledger.
  postedOrder = await insertId(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total, finalized_at)
     VALUES ($1, $2, '2026-09-10', 'FINALIZED', 'W10-INV-2', 300, '2026-09-10T10:00:00Z') RETURNING id`,
    [factory, fCustomer]
  );
  await voucher(
    factory,
    [
      { ledger: fCustLedger, customer: fCustomer, debit: "300.00", credit: "0" },
      { ledger: fSales, debit: "0", credit: "300.00" },
    ],
    "2026-09-10",
    `INV-GL-${factory}-${postedOrder}`
  );
  // The invoices' INVOICE/SALE cache rows (their orders are the source, not memo lines).
  for (const [orderId, amount, day] of [
    [unpostedOrder, "500", "2026-09-01"],
    [postedOrder, "300", "2026-09-10"],
  ] as const) {
    await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
                                      reference_id, debit_amount, credit_amount, balance, currency, description)
       VALUES ($1, $2, $3, 'SALE', 'INVOICE', $4, $5, 0, $5, 'USD', 'Invoice')`,
      [factory, fCustomer, day, orderId, amount]
    );
  }
  // A factory POS credit sale of 200 with a 50 deposit: cache rows only.
  await pool.query(
    `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
                                    reference_id, debit_amount, credit_amount, balance, currency, description)
     VALUES ($1, $2, '2026-09-04', 'SALE', 'FACTORY_POS_SALE', 77, 200, 0, 200, 'USD', 'POS Sale FP-77'),
            ($1, $2, '2026-09-04', 'PAYMENT', 'FACTORY_POS_DEPOSIT', 77, 0, 50, 150, 'USD', 'Deposit on POS Sale FP-77')`,
    [factory, fCustomer]
  );
  // A receipt of 100 on the customer ledger.
  await voucher(
    factory,
    [
      { ledger: fCash, debit: "100.00", credit: "0" },
      { ledger: fCustLedger, customer: fCustomer, debit: "0", credit: "100.00" },
    ],
    "2026-09-12"
  );

  registerAccountTransactionRoutes(fakeApp);
  registerAccountStatementRoutes(fakeApp);
  registerAccountLedgerBalanceRoutes(fakeApp);
  registerFactoryCustomerCrudRoutes(fakeApp);
  registerFactoryCustomerStatementRoutes(fakeApp);
}, 120_000);

afterAll(async () => {
  await cleanup();
});

async function engineCustomers(companyId: number) {
  return new Map(
    (await getPartyBalances(db, { companyId, kind: "customer" })).parties.map((party) => [party.id, party])
  );
}

describe("one line, one party", () => {
  it("sums every party to the trial balance and attributes each posted line once", async () => {
    const trialBalance = await buildTrialBalance(erp, null);
    let closing = 0;
    let periodDebit = 0;
    let periodCredit = 0;
    for (const kind of KINDS) {
      for (const party of (await getPartyBalances(db, { companyId: erp, kind })).parties) {
        closing += Number(party.closing);
        periodDebit += Number(party.periodDebit);
        periodCredit += Number(party.periodCredit);
      }
    }
    const tbClosing = Number(trialBalance.totals.closingDebit) - Number(trialBalance.totals.closingCredit);
    expect(closing).toBeCloseTo(tbClosing, 2);
    // Openings: cash 1000 + bank 50 + C1 100 + C4 10. Every voucher balances.
    expect(closing).toBeCloseTo(1160, 2);

    const lines = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(GREATEST(ve.debit_amount - ve.credit_amount, 0)), 0)::text AS debit,
              COALESCE(SUM(GREATEST(ve.credit_amount - ve.debit_amount, 0)), 0)::text AS credit
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.optional = false`,
      [erp]
    );
    expect(periodDebit).toBeCloseTo(Number(lines.rows[0].debit), 2);
    expect(periodCredit).toBeCloseTo(Number(lines.rows[0].credit), 2);
  });

  it("applies the double-entry rule to customers, shared ledgers and bank-linked ledgers", async () => {
    const customers = await engineCustomers(erp);
    // C1: 100 + 300 − 50; the 20 on STRAY is STRAY's.
    expect(customers.get(c1)).toMatchObject({ closing: "350.00", linkedLedgerAccountId: custLedger });
    // C2: only its customer-only line; the C2-tagged bank line is the bank's.
    expect(customers.get(c2)).toMatchObject({ closing: "-30.00" });
    // The shared ledger's line goes to C3 (lower id), C4 keeps its own opening.
    expect(customers.get(c3)).toMatchObject({ closing: "80.00", linkedLedgerAccountId: sharedLedger });
    expect(customers.get(c4)).toMatchObject({ closing: "10.00", linkedLedgerAccountId: null });

    expect(await getPartyBalance(db, { companyId: erp, kind: "ledger", id: stray })).toMatchObject({
      closing: "-20.00",
    });
    // Bank: opening 50 + the C2-tagged 30; the line naming the bank and its linked ledger is the ledger's.
    expect(await getPartyBalance(db, { companyId: erp, kind: "bank", id: bank })).toMatchObject({ closing: "80.00" });
    expect(await getPartyBalance(db, { companyId: erp, kind: "ledger", id: bankLedger })).toMatchObject({
      closing: "25.00",
    });
  });

  it("lists on each customer statement exactly the lines the engine attributes to it", async () => {
    const customers = await engineCustomers(erp);
    const seen = new Set<number>();
    for (const id of [c1, c2, c3, c4]) {
      const lines = await loadCustomerLedgerLines(db, { companyId: erp, customerId: id });
      const net = lines.reduce((sum, line) => sum + Number(line.debitAmount) - Number(line.creditAmount), 0);
      const party = customers.get(id)!;
      expect(Number(party.masterOpening) + net, `customer ${id}`).toBeCloseTo(Number(party.closing), 2);
      for (const line of lines) {
        expect(seen.has(line.id), `line ${line.id} listed twice`).toBe(false);
        seen.add(line.id);
      }
    }
  });
});

describe("customer readers equal the engine", () => {
  it("stats, getCustomerBalance and the overdue reminder", async () => {
    const customers = await engineCustomers(erp);
    const stats = new Map((await getCustomersWithBalances(erp)).map((row) => [row.id, row]));
    for (const id of [c1, c2, c3, c4]) {
      const closing = Number(customers.get(id)!.closing);
      expect(stats.get(id)).toMatchObject({ balance: Math.abs(closing), balanceSide: closing < 0 ? "Cr" : "Dr" });
      expect(await getCustomerBalance(id, erp)).toBeCloseTo(closing, 2);
    }
    const overdue = (await loadOverdueCustomerBalances()).find((row) => row.id === c1);
    expect(overdue).toMatchObject({ net_balance: "350.00", company_id: erp });
    expect(String(overdue?.earliest_invoice_date)).toContain("2026");
  });

  it("the pre-period figures of the customer statements and the account pre-period balance", async () => {
    const party = await getPartyBalance(db, { companyId: erp, kind: "customer", id: c1, from: "2026-09-03" });
    // Before 09-03: the 300 invoice.
    expect(party).toMatchObject({ carriedForward: "300.00", opening: "400.00" });

    const page = await runCustomerBalanceStatement({
      customerId: c1,
      companyId: erp,
      pagination: { page: 1, limit: 50, offset: 0 },
      dates: { rawStart: "2026-09-03", effectiveEndDate: "2026-09-30", asOfDate: "2026-09-30" },
    });
    expect(page).toMatchObject({ preNetBalance: 300, closingNetBalance: 250 });

    const transactions = await call("GET /api/accounts/customer/:id/transactions", {
      params: { id: String(c1) },
      query: { startDate: "2026-09-03", endDate: "2026-09-30" },
    });
    expect(transactions.body.preNetBalance).toBe(300);
    expect(transactions.body.transactions).toHaveLength(1);

    const prePeriod = await call("GET /api/accounts/:type/:id/pre-period-balance", {
      session: { currentCompanyId: erp },
      params: { type: "customer", id: String(c1) },
      query: { endDate: "2026-09-03" },
    });
    expect(prePeriod.body).toEqual({ balance: 400, notInLedgerBefore: "0.00" });
    // The ledger C1 owns opens at the same figure (the customer's opening, counted once).
    const ledgerPrePeriod = await call("GET /api/accounts/:type/:id/pre-period-balance", {
      session: { currentCompanyId: erp },
      params: { type: "ledger", id: String(custLedger) },
      query: { endDate: "2026-09-03" },
    });
    expect(ledgerPrePeriod.body).toEqual({ balance: 400, notInLedgerBefore: "0.00" });
  });

  it("a ledger linked to two customers shows its owner's statement", async () => {
    const res = await call("GET /api/accounts/ledger/:id/transactions", {
      params: { id: String(sharedLedger) },
      query: { endDate: "2026-09-30" },
    });
    expect(res.body.customerId).toBe(c3);
    expect(res.body.transactions.map((t: { debitAmount: string }) => t.debitAmount)).toEqual(["80.00"]);
  });
});

describe("amounts not yet in the ledger", () => {
  it("lists the factory POS credit sale and the unposted invoice as memo rows, outside the balance", async () => {
    const res = await call("GET /api/accounts/customer/:id/transactions", {
      params: { id: String(fCustomer) },
      query: { endDate: "2026-09-30" },
    });
    // Ledger: the 40 charge, the 300 INV-GL journal, the 100 receipt.
    const net = res.body.transactions.reduce(
      (sum: number, t: { debitAmount: string; creditAmount: string }) =>
        sum + Number(t.debitAmount) - Number(t.creditAmount),
      0
    );
    expect(net).toBeCloseTo(240, 2);
    expect(res.body.transactions.some((t: { notInLedger?: boolean }) => t.notInLedger)).toBe(false);

    const memo = res.body.notInLedger;
    expect(
      memo.rows.map((row: { memoSource: string; debitAmount: string; creditAmount: string }) => [
        row.memoSource,
        row.debitAmount,
        row.creditAmount,
      ])
    ).toEqual([
      // 500 less the 40 charge that is already on the ledger.
      ["factoryInvoice", "460.00", "0.00"],
      ["factoryPosCreditSale", "200.00", "0.00"],
      ["factoryPosDeposit", "0.00", "50.00"],
    ]);
    expect(memo.rows.every((row: { notInLedger: boolean }) => row.notInLedger)).toBe(true);
    expect(memo.total).toBe("610.00");

    // With a start date, memo lines before it are reported apart; preNetBalance stays the ledger's.
    const period = await call("GET /api/accounts/customer/:id/transactions", {
      params: { id: String(fCustomer) },
      query: { startDate: "2026-09-05", endDate: "2026-09-30" },
    });
    expect(period.body.preNetBalance).toBe(40);
    expect(period.body.notInLedger).toMatchObject({ rows: [], prePeriodTotal: "610.00", total: "0.00" });
  });

  it("puts the engine closing and the memo total side by side on the factory customer pages", async () => {
    const party = await getPartyBalance(db, { companyId: factory, kind: "customer", id: fCustomer, memo: true });
    expect(party).toMatchObject({ closing: "240.00", memoTotal: "610.00" });

    const session = { session: { factoryCompanyId: factory, currentCompanyId: factory } };
    const list = await call("GET /api/factory/customers", session);
    expect(list.body.find((c: { id: number }) => c.id === fCustomer)).toMatchObject({
      balance: 850,
      balanceSide: "Dr",
      balanceBasis: "ledger+notInLedger",
      ledgerBalance: 240,
      ledgerBalanceSide: "Dr",
      notInLedgerTotal: 610,
    });

    const statement = await call("GET /api/factory/customers/:id/statement", {
      ...session,
      params: { id: String(fCustomer) },
    });
    expect(statement.body).toMatchObject({
      currentBalance: 850,
      currentBalanceSide: "Dr",
      ledgerBalance: 240,
      notInLedgerTotal: 610,
    });
    const rows = statement.body.balanceHistory as Array<Record<string, any>>;
    expect(rows.filter((row) => row.notInLedger)).toHaveLength(3);
    // The INV-GL journal is the posted invoice's row (with its cache row's id for notes).
    const posted = rows.find((row) => row.referenceType === "INVOICE" && row.referenceId === postedOrder);
    expect(posted).toMatchObject({ _fromVoucher: true, notInLedger: false, debitAmount: "300.00" });
    expect(typeof posted?.id).toBe("number");
    expect(rows.at(-1)).toMatchObject({ runningBalance: 850, ledgerRunningBalance: 240 });

    const ledgerBalance = await call("GET /api/accounts/ledger/:id/balance", {
      session: { currentCompanyId: factory },
      params: { id: String(fCustLedger) },
    });
    // Wave 17 A: the response carries the as-of date (null: everything posted).
    expect(ledgerBalance.body).toEqual({ balance: 240, customerId: fCustomer, notInLedgerTotal: 610, asOf: null });

    let accounts: { accounts: Array<Record<string, unknown>> } = { accounts: [] };
    const res = {
      status: () => res,
      json: (value: typeof accounts) => {
        accounts = value;
        return res;
      },
    };
    await serveAccountListForCompany(
      { query: {}, headers: { "x-client-date": "2026-10-08" } } as never,
      res as never,
      factory
    );
    expect(accounts.accounts.find((a) => a.accountId === fCustLedger && a.type === "ledger")).toMatchObject({
      balance: "240.00",
      balanceSide: "Dr",
      balanceBasis: "ledger",
      notInLedgerTotal: "610.00",
    });
  });

  it("drops a memo line once its amount reaches the ledger", async () => {
    const before = await loadCustomerNotInLedger(db, { companyId: factory, customerId: fCustomer });
    expect(before.rows.some((row) => row.memoSource === "factoryInvoice" && row.voucherNumber === "W10-INV-2")).toBe(
      false
    );
    expect(before.rows.some((row) => row.voucherNumber === "INVOICE-" + String(unpostedOrder))).toBe(false);
  });
});
