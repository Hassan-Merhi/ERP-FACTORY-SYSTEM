/**
 * Accounting audit wave 10, part C: the existing party-balance readers follow
 * the ledger rules.
 *
 *   - soft-deleted vouchers keep their lines but never reach a balance
 *     (factory customers list + statement, factory supplier balances);
 *   - optional vouchers are excluded from /api/customers/stats
 *     (getCustomersWithBalances);
 *   - a customer owns the lines on its linked ledger plus its customer-tagged
 *     lines with no ledger — a customer-tagged line on another account is not
 *     the customer's (factory statement);
 *   - a supplier line carrying both a debit and a credit is netted;
 *   - supplier and employee openings follow opening_balance_side (null → Cr),
 *     a customer opening its side (null → Dr);
 *   - readers that used the customer_balances cache as the whole balance now
 *     read the ledger, so a voucher receipt reduces the balance;
 *   - /api/accounts/all with a start date carries opening + earlier movements
 *     and applies the date range to suppliers too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  return { ...actual, requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() };
});
vi.mock("../server/routes/performance/supplierVoucherEntryBatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/routes/performance/supplierVoucherEntryBatcher")>();
  return { ...actual, getVoucherEntriesBySupplierBatched: vi.fn(actual.getVoucherEntriesBySupplierBatched) };
});

import { pool } from "../server/db";
import { getCustomersWithBalances } from "../server/routes/customers/customerBalanceQuery";
import { getSupplierBalanceForContext } from "../server/routes/helpers/supplierBalanceHelpers";
import { getVoucherEntriesBySupplierBatched } from "../server/routes/performance/supplierVoucherEntryBatcher";
import { serveAccountListForCompany } from "../server/routes/accounts/all";
import { registerAccountStatementRoutes } from "../server/routes/accountStatementRoutes";
import { registerFactoryCustomerCrudRoutes } from "../server/routes/factory/customers-core/crud";
import { registerFactoryCustomerStatementRoutes } from "../server/routes/factory/customers-core/statement";
import { registerSupplierBalanceSingleRoutes } from "../server/routes/factory/suppliers/balance/single";
import { registerSupplierWithBalancesRoutes } from "../server/routes/factory/suppliers/balance/with-balances";
import { runCustomerBalanceStatement } from "../server/routes/account-transaction-pagination/customerBalanceStatement";
import { loadOverdueCustomerBalances } from "../server/services/scheduler/overdueCustomerQuery";
import { getCustomerBalance } from "../server/storage/accounting/customer-balances";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w10prr";

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
  let body: unknown;
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
  await handler({ params: {}, query: {}, headers: {}, body: {}, ...req }, res);
  return { statusCode, body: body as any };
}

let erpCompanyId: number;
let factoryCompanyId: number;
let cash: number;
let sales: number;
let stray: number;
let custLinked: number;
let custLinkedLedger: number;
let custUnlinked: number;
let custCrOpening: number;
let supplierDrOpening: number;
let employeeDrOpening: number;
let fCash: number;
let fStray: number;
let fCustomer: number;
let fCustomerLedger: number;
let fSupplier: number;
let sequence = 0;

type Line = {
  ledger?: number;
  customer?: number;
  supplier?: number;
  factorySupplier?: number;
  debit: string;
  credit: string;
};

async function voucher(
  companyId: number,
  lines: Line[],
  voucherDate: string,
  options: { optional?: boolean; deleted?: boolean } = {}
) {
  sequence += 1;
  await withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency,
                             optional, deleted_at)
       VALUES ($1, $2, 'Journal', $3, 0, 'USD', $4, $5) RETURNING id`,
      [companyId, `${PREFIX}-${sequence}`, voucherDate, options.optional ?? false, options.deleted ? new Date() : null]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, supplier_id, factory_supplier_id,
                                      debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          created.rows[0].id,
          line.ledger ?? null,
          line.customer ?? null,
          line.supplier ?? null,
          line.factorySupplier ?? null,
          line.debit,
          line.credit,
        ]
      );
    }
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

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX}%`]);
  for (const { id } of companies.rows) {
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await pool.query("DELETE FROM customer_balances WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM employees WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM companies WHERE id = $1", [id]);
  }
}

beforeAll(async () => {
  await cleanup();
  erpCompanyId = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}E`, `${PREFIX} erp company`]
  );
  factoryCompanyId = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}F`, `${PREFIX} factory company`]
  );

  // ── ERP company ─────────────────────────────────────────────────────────
  cash = await ledger(erpCompanyId, "CASH", "Asset", "1000", "Dr");
  sales = await ledger(erpCompanyId, "SALES", "Income", "0", "Cr");
  stray = await ledger(erpCompanyId, "STRAY", "Asset");
  custLinkedLedger = await ledger(erpCompanyId, "CUST1", "Asset");
  custLinked = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id)
     VALUES ($1, $2, $3, 100, 'Dr', $4) RETURNING id`,
    [erpCompanyId, `${PREFIX}C1`, `${PREFIX} linked customer`, custLinkedLedger]
  );
  custUnlinked = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, payment_terms_days) VALUES ($1, $2, $3, 1) RETURNING id`,
    [erpCompanyId, `${PREFIX}C2`, `${PREFIX} unlinked customer`]
  );
  custCrOpening = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 40, 'Cr') RETURNING id`,
    [erpCompanyId, `${PREFIX}C3`, `${PREFIX} credit-opening customer`]
  );
  supplierDrOpening = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 500, 'Dr') RETURNING id`,
    [erpCompanyId, `${PREFIX}S1`, `${PREFIX} supplier`, `${PREFIX}@example.test`]
  );
  employeeDrOpening = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Wave', 'Ten', '2026-01-01', 25, 'Dr') RETURNING id`,
    [erpCompanyId, `${PREFIX}E1`]
  );

  // Linked customer: invoice 300 on its ledger, receipt 50 on a customer-only line.
  await voucher(
    erpCompanyId,
    [
      { ledger: custLinkedLedger, customer: custLinked, debit: "300.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "300.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    erpCompanyId,
    [
      { ledger: cash, debit: "50.00", credit: "0" },
      { customer: custLinked, debit: "0", credit: "50.00" },
    ],
    "2026-09-03"
  );
  // Optional and soft-deleted vouchers on the linked ledger never count.
  await voucher(
    erpCompanyId,
    [
      { ledger: custLinkedLedger, debit: "1000.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "1000.00" },
    ],
    "2026-09-02",
    { optional: true }
  );
  await voucher(
    erpCompanyId,
    [
      { ledger: cash, debit: "70.00", credit: "0" },
      { ledger: custLinkedLedger, debit: "0", credit: "70.00" },
    ],
    "2026-09-02",
    { deleted: true }
  );
  // A customer-tagged line on another account belongs to that account.
  await voucher(
    erpCompanyId,
    [
      { ledger: cash, debit: "20.00", credit: "0" },
      { ledger: stray, customer: custLinked, debit: "0", credit: "20.00" },
    ],
    "2026-09-05"
  );
  // Unlinked customer: charged 80 (voucher + operational cache row), paid 30 by voucher only.
  await voucher(
    erpCompanyId,
    [
      { ledger: stray, customer: custUnlinked, debit: "80.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "80.00" },
    ],
    "2026-09-01"
  );
  await voucher(
    erpCompanyId,
    [
      { ledger: cash, debit: "30.00", credit: "0" },
      { customer: custUnlinked, debit: "0", credit: "30.00" },
    ],
    "2026-09-06"
  );
  await pool.query(
    `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
                                    debit_amount, credit_amount, balance, currency, description)
     VALUES ($1, $2, '2026-09-01', 'SALE', 'CONTAINER_SALE', 80, 0, 80, 'USD', $3)`,
    [erpCompanyId, custUnlinked, `${PREFIX} cached sale`]
  );
  // Supplier: invoiced 200 before the period, 60 after the end date.
  await voucher(
    erpCompanyId,
    [
      { ledger: sales, debit: "200.00", credit: "0" },
      { supplier: supplierDrOpening, debit: "0", credit: "200.00" },
    ],
    "2026-09-03"
  );
  await voucher(
    erpCompanyId,
    [
      { ledger: sales, debit: "60.00", credit: "0" },
      { supplier: supplierDrOpening, debit: "0", credit: "60.00" },
    ],
    "2026-10-02"
  );

  // ── Factory company ─────────────────────────────────────────────────────
  fCash = await ledger(factoryCompanyId, "FCASH", "Asset");
  fStray = await ledger(factoryCompanyId, "FSTRAY", "Asset");
  fCustomerLedger = await ledger(factoryCompanyId, "FCUST", "Asset");
  fCustomer = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [factoryCompanyId, `${PREFIX}FC1`, `${PREFIX} factory customer`, fCustomerLedger]
  );
  fSupplier = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, $2, 0) RETURNING id`,
    [factoryCompanyId, `${PREFIX} factory supplier`]
  );
  await voucher(
    factoryCompanyId,
    [
      { ledger: fCash, debit: "40.00", credit: "0" },
      { ledger: fCustomerLedger, debit: "0", credit: "40.00" },
    ],
    "2026-09-03"
  );
  await voucher(
    factoryCompanyId,
    [
      { ledger: fCash, debit: "25.00", credit: "0" },
      { ledger: fCustomerLedger, debit: "0", credit: "25.00" },
    ],
    "2026-09-03",
    { deleted: true }
  );
  await voucher(
    factoryCompanyId,
    [
      { ledger: fCash, debit: "15.00", credit: "0" },
      { ledger: fStray, customer: fCustomer, debit: "0", credit: "15.00" },
    ],
    "2026-09-04"
  );
  await voucher(
    factoryCompanyId,
    [
      { factorySupplier: fSupplier, debit: "100.00", credit: "0" },
      { ledger: fCash, debit: "0", credit: "100.00" },
    ],
    "2026-09-05"
  );
  await voucher(
    factoryCompanyId,
    [
      { factorySupplier: fSupplier, debit: "55.00", credit: "0" },
      { ledger: fCash, debit: "0", credit: "55.00" },
    ],
    "2026-09-05",
    { deleted: true }
  );

  registerFactoryCustomerCrudRoutes(fakeApp);
  registerFactoryCustomerStatementRoutes(fakeApp);
  registerSupplierBalanceSingleRoutes(fakeApp);
  registerSupplierWithBalancesRoutes(fakeApp);
  registerAccountStatementRoutes(fakeApp);
}, 60_000);

afterAll(async () => {
  await cleanup();
});

describe("soft-deleted vouchers", () => {
  const session = () => ({ session: { factoryCompanyId, currentCompanyId: factoryCompanyId } });

  it("are excluded from the factory customers list", async () => {
    const { body } = await call("GET /api/factory/customers", session());
    // 40 receipt; the deleted 25 and the 15 posted to another ledger do not count.
    expect(body.find((c: { id: number }) => c.id === fCustomer)).toMatchObject({ balance: 40, balanceSide: "Cr" });
  });

  it("are excluded from the factory customer statement, as are customer-tagged lines on other accounts", async () => {
    const { body } = await call("GET /api/factory/customers/:id/statement", {
      ...session(),
      params: { id: String(fCustomer) },
    });
    expect(body).toMatchObject({ currentBalance: 40, currentBalanceSide: "Cr" });
    expect(body.balanceHistory).toHaveLength(1);
  });

  it("are excluded from factory supplier balances", async () => {
    const single = await call("GET /api/factory/suppliers/:id/balance", {
      ...session(),
      params: { id: String(fSupplier) },
    });
    expect(single.body.outstandingUsd).toBe(-100);

    const list = await call("GET /api/factory/suppliers/with-balances", session());
    expect(list.body.find((s: { id: number }) => s.id === fSupplier)).toMatchObject({ totalValue: "-100.00" });
  });
});

describe("customer ledger readers", () => {
  it("excludes optional vouchers and stray lines from /api/customers/stats", async () => {
    const rows = await getCustomersWithBalances(erpCompanyId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // 100 opening + 300 invoice − 50 receipt; not the optional 1000, deleted 70 or stray 20.
    expect(byId.get(custLinked)).toMatchObject({ balance: 350, balanceSide: "Dr" });
    // Unlinked: the balance engine's rule (wave 10 part 2) — a customer owns its
    // customer-tagged lines that name no other target. The 80 charged on the
    // STRAY ledger is that ledger's line (counted once, under STRAY), so the
    // customer is −30: the 30 receipt. (Part 1 counted the 80 for the
    // customer as well, i.e. twice across the trial balance.)
    expect(byId.get(custUnlinked)).toMatchObject({ balance: 30, balanceSide: "Cr" });
    expect(byId.get(custCrOpening)).toMatchObject({ balance: 40, balanceSide: "Cr" });
  });

  it("includes voucher receipts in the readers that used the customer_balances cache", async () => {
    // The cache alone says 80; the ledger (engine) says −30 (see above).
    expect(await getCustomerBalance(custUnlinked, erpCompanyId)).toBe(-30);

    // In credit, so no overdue reminder; the linked customer (350 Dr) has none
    // either (no payment terms).
    const overdue = (await loadOverdueCustomerBalances()).find((row) => row.id === custUnlinked);
    expect(overdue).toBeUndefined();

    const page = await runCustomerBalanceStatement({
      customerId: custUnlinked,
      companyId: erpCompanyId,
      pagination: { page: 1, limit: 50, offset: 0 },
      dates: { rawStart: "2026-09-05", effectiveEndDate: "2026-09-30", asOfDate: "2026-09-30" },
    });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]).toMatchObject({ creditAmount: "30.00" });
    expect(page).toMatchObject({ preNetBalance: 0, closingNetBalance: -30 });
    // The CONTAINER_SALE cache row was posted as a voucher: not a memo line.
    expect(page.notInLedger?.rows).toEqual([]);
  });
});

describe("supplier rules", () => {
  it("honours a Dr opening side", async () => {
    const result = await getSupplierBalanceForContext(
      { id: supplierDrOpening, companyId: erpCompanyId, openingBalance: "500" },
      erpCompanyId
    );
    // Cr positive: −500 opening + 200 + 60 credits.
    expect(result).toMatchObject({ balance: -240, openingBalance: 500, openingBalanceSide: "Dr" });
  });

  // Wave 13: the balance is the balance engine's, which nets every line in SQL
  // (voucher_entries_single_side refuses new mixed lines, so the engine's
  // netting is covered by wave10-party-balance-engine); the per-currency view
  // still nets the supplier's own lines. This test used to drive the balance
  // from mocked entries.
  it("nets a legacy line that carries both a debit and a credit", async () => {
    vi.mocked(getVoucherEntriesBySupplierBatched).mockResolvedValueOnce([
      { debitAmount: "60.00", creditAmount: "20.00" },
      { debitAmount: "0", creditAmount: "100.00" },
    ] as never);
    const result = await getSupplierBalanceForContext(
      { id: supplierDrOpening, companyId: erpCompanyId, openingBalance: "0", openingBalanceSide: null },
      erpCompanyId
    );
    // 100 − (60 − 20); the pure-side rule dropped the mixed line and said 100.
    expect(result.balancesByCurrency.USD.net).toBe(60);
    // The balance itself is the engine's: −500 Dr opening + 200 + 60 credits.
    expect(result.balance).toBe(-240);
  });
});

describe("/api/accounts/all period", () => {
  it("carries opening + earlier movements and applies the date range to suppliers", async () => {
    let body: { accounts: Array<Record<string, unknown>> } = { accounts: [] };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await serveAccountListForCompany(
      {
        query: { startDate: "2026-09-04", endDate: "2026-09-30" },
        headers: { "x-client-date": "2026-10-08" },
      } as never,
      res as never,
      erpCompanyId
    );
    const cashRow = body.accounts.find((a) => a.accountId === cash && a.type === "ledger");
    // 1000 + 50 before the start; + 20 + 30 in the period.
    expect(cashRow).toMatchObject({ openingBalance: 1050, openingBalanceSide: "Dr", balance: "1100.00" });

    const supplierRow = body.accounts.find((a) => a.accountId === supplierDrOpening && a.type === "supplier");
    // −500 + 200 carried; the 60 after the end date is outside the range.
    expect(supplierRow).toMatchObject({ openingBalance: 300, openingBalanceSide: "Dr", balance: "-300.00" });

    const employeeRow = body.accounts.find((a) => a.accountId === employeeDrOpening && a.type === "employee");
    expect(employeeRow).toMatchObject({ balance: "25.00", balanceSide: "Dr", openingBalanceSide: "Dr" });
  });
});

describe("pre-period balance", () => {
  const preBalance = (type: string, id: number, companyId = erpCompanyId) =>
    call("GET /api/accounts/:type/:id/pre-period-balance", {
      session: { currentCompanyId: companyId },
      params: { type, id: String(id) },
      query: { endDate: "2026-09-30" },
    });

  it("honours employee and customer opening sides", async () => {
    // Dr positive: an employee who owes us 25 is +25 (it was −25 before).
    expect((await preBalance("employee", employeeDrOpening)).body).toEqual({ balance: 25 });
    // Customers also report what is not yet in the ledger before endDate (wave 10).
    // A Cr customer opening is −40 (it was +40).
    expect((await preBalance("customer", custCrOpening)).body).toEqual({ balance: -40, notInLedgerBefore: "0.00" });
    // The linked customer's own lines: 100 + 300 − 50 (stray line excluded).
    expect((await preBalance("customer", custLinked)).body).toEqual({ balance: 350, notInLedgerBefore: "0.00" });
  });

  it("refuses accounts of another company", async () => {
    expect((await preBalance("employee", employeeDrOpening, factoryCompanyId)).statusCode).toBe(404);
    expect((await preBalance("customer", custLinked, factoryCompanyId)).statusCode).toBe(404);
    expect((await preBalance("ledger", cash, factoryCompanyId)).statusCode).toBe(404);
  });
});
