/**
 * Accounting audit wave 10, part 2: net position on the one balance engine.
 *
 *   - customers, suppliers and employees of every net position path are the
 *     engine's parties as of the date (historical-base closing, effective-date
 *     basis); a party line equals the engine figure;
 *   - a new customer's opening is owned by the customer record: the CUST
 *     ledger created with it starts at zero, and the opening appears exactly
 *     once in net position and in the trial balance;
 *   - amounts not yet in the ledger (unposted factory invoices, factory POS
 *     credit sales, unjournalled container goods, unfinalized orders) are a
 *     separate `notInLedger` section, never in What We Have / What We Owe;
 *   - supplier-partner companies still exclude customers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { customerService } from "../server/routes/customers/customerService";
import { registerStatsNetProfitRoutes } from "../server/routes/stats/statsNetProfitRoutes";
import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w10npe";
const AS_OF = "2026-09-30";

type Handler = (req: unknown, res: unknown, next?: () => void) => Promise<unknown> | unknown;
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
let sp: number;
let customerId: number;
let customerLedgerId: number;
let supplierId: number;
let fCustomer: number;
let fSupplier: number;
let sequence = 0;

type Line = {
  ledger?: number;
  customer?: number;
  supplier?: number;
  employee?: number;
  factorySupplier?: number;
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
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, supplier_id, employee_id,
                                      factory_supplier_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          created.rows[0].id,
          line.ledger ?? null,
          line.customer ?? null,
          line.supplier ?? null,
          line.employee ?? null,
          line.factorySupplier ?? null,
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

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX}%`]);
  for (const { id } of companies.rows) {
    await pool.query("DELETE FROM customer_orders WHERE company_id = $1", [id]);
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]).catch(() => undefined);
    await pool.query("DELETE FROM customer_balances WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM employees WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM factory_containers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM companies WHERE id = $1", [id]);
  }
}

beforeAll(async () => {
  await cleanup();
  const company = (type: string, suffix: string) =>
    insertId(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, $3, 'USD') RETURNING id`,
      [`${PREFIX.toUpperCase()}${suffix}`, `${PREFIX} ${type} company`, type]
    );
  erp = await company("erp", "E");
  factory = await company("factory", "F");
  sp = await company("supplier_partner", "S");

  // ── ERP: a customer created through the customer service, with a 500 opening ──
  const cash = await ledger(erp, "CASH", "Asset", "1000", "Dr");
  const sales = await ledger(erp, "SALES", "Income", "0", "Cr");
  const created = await customerService.create(
    erp,
    { legalName: `${PREFIX} new customer`, openingBalance: "500", openingBalanceSide: "Dr" },
    { userId: "0", username: "wave10" }
  );
  customerId = created.id;
  customerLedgerId = (
    await pool.query<{ ledger_account_id: number }>(`SELECT ledger_account_id FROM customers WHERE id = $1`, [
      customerId,
    ])
  ).rows[0].ledger_account_id;
  supplierId = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 200, 'Cr') RETURNING id`,
    [erp, `${PREFIX}S1`, `${PREFIX} supplier`, `${PREFIX}@example.test`]
  );
  const employeeId = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, employee_type, current_balance)
     VALUES ($1, $2, 'Pay', 'Roll', '2026-01-01', 'Employee', 999) RETURNING id`,
    [erp, `${PREFIX}E1`]
  );
  const workerId = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, employee_type)
     VALUES ($1, $2, 'Work', 'Er', '2026-01-01', 'Worker') RETURNING id`,
    [erp, `${PREFIX}W1`]
  );
  // Invoice 120 on the customer's ledger; supplier paid 50; salary accrued 300; worker advance 40.
  await voucher(
    erp,
    [
      { ledger: customerLedgerId, customer: customerId, debit: "120.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "120.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    erp,
    [
      { supplier: supplierId, debit: "50.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "50.00" },
    ],
    "2026-09-03"
  );
  await voucher(
    erp,
    [
      { ledger: sales, debit: "300.00", credit: "0" },
      { employee: employeeId, debit: "0", credit: "300.00" },
      { employee: workerId, debit: "40.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "40.00" },
    ],
    "2026-09-04"
  );

  // ── Factory: a customer with an unposted invoice, a POS credit sale and a pending order ──
  const fCash = await ledger(factory, "FCASH", "Asset");
  const fCustLedger = await ledger(factory, "FCUST", "Asset");
  fCustomer = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [factory, `${PREFIX}FC1`, `${PREFIX} factory customer`, fCustLedger]
  );
  await pool.query(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total, finalized_at)
     VALUES ($1, $2, '2026-09-01', 'FINALIZED', 'W10NP-1', 500, '2026-09-01T10:00:00Z'),
            ($1, $2, '2026-09-05', 'PENDING_VERIFICATION', NULL, 75, NULL)`,
    [factory, fCustomer]
  );
  await pool.query(
    `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
                                    reference_id, debit_amount, credit_amount, balance, currency, description)
     VALUES ($1, $2, '2026-09-04', 'SALE', 'FACTORY_POS_SALE', 9, 200, 0, 200, 'USD', 'POS Sale FP-9')`,
    [factory, fCustomer]
  );
  await voucher(
    factory,
    [
      { ledger: fCash, debit: "100.00", credit: "0" },
      { ledger: fCustLedger, customer: fCustomer, debit: "0", credit: "100.00" },
    ],
    "2026-09-06"
  );
  // A factory supplier: a legacy container with no import journal (memo), and a payment in the ledger.
  fSupplier = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, $2, 0) RETURNING id`,
    [factory, `${PREFIX} factory supplier`]
  );
  await pool.query(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, total_kg, rate_per_kg, currency_code,
                                     arrival_date, freight_paid_by)
     VALUES ($1, $2, $3, 1000, 0.5, 'USD', '2026-09-02', 'own')`,
    [factory, `${PREFIX}-CONT`, fSupplier]
  );
  await voucher(
    factory,
    [
      { factorySupplier: fSupplier, debit: "60.00", credit: "0" },
      { ledger: fCash, debit: "0", credit: "60.00" },
    ],
    "2026-09-07"
  );

  // ── Supplier partner: a customer with a balance stays out by design ──
  const spCash = await ledger(sp, "SPCASH", "Cash");
  const spCustLedger = await ledger(sp, "SPCUST", "Asset");
  const spCustomer = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id)
     VALUES ($1, $2, $3, 70, 'Dr', $4) RETURNING id`,
    [sp, `${PREFIX}SPC`, `${PREFIX} sp customer`, spCustLedger]
  );
  await voucher(
    sp,
    [
      { ledger: spCustLedger, customer: spCustomer, debit: "30.00", credit: "0" },
      { ledger: spCash, debit: "0", credit: "30.00" },
    ],
    "2026-09-02"
  );

  registerStatsNetProfitRoutes(fakeApp);
  registerEmployeeNetPositionRoutes(fakeApp);
}, 120_000);

afterAll(async () => {
  await cleanup();
});

describe("a new customer's opening", () => {
  it("is owned by the customer record: the CUST ledger starts at zero", async () => {
    const account = await pool.query<{ opening_balance: string }>(
      `SELECT opening_balance::text FROM ledger_accounts WHERE id = $1`,
      [customerLedgerId]
    );
    expect(Number(account.rows[0].opening_balance)).toBe(0);
  });

  it("appears exactly once in the trial balance and in net position", async () => {
    const trialBalance = await buildTrialBalance(erp, AS_OF);
    expect(trialBalance.rows.some((row) => row.kind === "ledger" && row.id === customerLedgerId)).toBe(false);
    expect(trialBalance.rows.find((row) => row.kind === "customer" && row.id === customerId)).toMatchObject({
      openingDebit: "500.00",
      closingDebit: "620.00",
    });

    const snapshot = await calculateNetPositionAsOf(erp, AS_OF);
    const customerLines = snapshot.forUsLines.filter((line) => line.label === `${PREFIX} new customer`);
    expect(customerLines).toEqual([expect.objectContaining({ value: 620, category: "Customer" })]);
    expect(snapshot.forUsLines.some((line) => line.label.includes("Customer Account"))).toBe(false);
  });
});

describe("net position party lines equal the engine", () => {
  it("in the dated snapshot (monthly Excel, schedulers, WhatsApp)", async () => {
    const supplier = await getPartyBalance(db, { companyId: erp, kind: "supplier", id: supplierId, asOf: AS_OF });
    expect(supplier?.historicalBaseClosing).toBe("-150.00");
    const snapshot = await calculateNetPositionAsOf(erp, AS_OF);
    expect(snapshot.onUsLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Supplier Payables", value: 150 }),
        expect.objectContaining({ label: "Payroll Payable", value: 300 }),
      ])
    );
    expect(snapshot.forUsLines).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Worker Advances (Prepaid)", value: 40 })])
    );
  });

  it("in the live net position, with employees.current_balance reported apart", async () => {
    const { statusCode, body } = await call("GET /api/stats/net-profit", {
      session: { currentCompanyId: erp },
      query: { toDate: AS_OF },
    });
    expect(statusCode).toBe(200);
    const names = (accounts: Array<{ name: string; value: number }>) =>
      Object.fromEntries(accounts.map((account) => [account.name, account.value]));
    expect(names(body.forUs.accounts)).toMatchObject({
      [`${PREFIX} new customer`]: 620,
      "Worker Advances (Prepaid)": 40,
    });
    expect(names(body.onUs.accounts)).toMatchObject({ [`${PREFIX} supplier`]: 150, "Payroll Payable": 300 });
    // The CUST ledger is rolled into the customer, never listed on its own.
    expect(
      body.forUs.accounts.some(
        (account: { id?: number }) => account.id === customerLedgerId && account.name.includes("Customer Account")
      )
    ).toBe(false);
    // The payroll page's 999 over the ledger's 300 is shown apart: we would owe 699 more.
    expect(body.notInLedger.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "NOT_IN_LEDGER_PAYROLL_CURRENT_BALANCE", value: -699 })])
    );
    expect(body.netPosition).toBeCloseTo(body.forUsTotal - body.onUsTotal, 2);
  });

  it("excludes customers of a supplier-partner company", async () => {
    const snapshot = await calculateNetPositionAsOf(sp, AS_OF);
    expect([...snapshot.forUsLines, ...snapshot.onUsLines].some((line) => line.label.includes("sp customer"))).toBe(
      false
    );
    expect(snapshot.forUsLines.some((line) => line.label.includes("SPCUST"))).toBe(false);
  });
});

describe("the factory net position", () => {
  it("takes customers and factory suppliers from the engine and lists what is not in the ledger apart", async () => {
    const { statusCode, body } = await call("GET /api/factory/net-position", {
      session: { factoryCompanyId: factory, currentCompanyId: factory },
      query: { asOf: AS_OF },
    });
    expect(statusCode).toBe(200);
    const customer = await getPartyBalance(db, { companyId: factory, kind: "customer", id: fCustomer, asOf: AS_OF });
    expect(customer?.historicalBaseClosing).toBe("-100.00");
    // The ledger holds only the 100 receipt: the customer is in credit (What We Owe).
    expect(body.onUs.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CUSTOMER_CR", name: `${PREFIX} factory customer`, value: 100 }),
      ])
    );
    // The factory supplier was paid 60 in the ledger: an overpayment until the container is journalled.
    expect(body.forUs.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SUPPLIER_OVERPAID", value: 60 })])
    );
    const memo = Object.fromEntries(
      body.notInLedger.lines.map((line: { code: string; value: number }) => [line.code, line.value])
    );
    expect(memo).toMatchObject({
      NOT_IN_LEDGER_FACTORY_INVOICE: 500,
      NOT_IN_LEDGER_FACTORY_POS_CREDIT_SALE: 200,
      NOT_IN_LEDGER_FACTORY_CONTAINER_GOODS: -500,
      PENDING_ORDERS: 75,
    });
    // None of it is in the totals.
    expect(body.forUs.accounts.some((account: { code: string }) => account.code === "PENDING_ORDERS")).toBe(false);
    expect(body.pendingTotal).toBe(75);
    expect(body.netPosition).toBeCloseTo(body.forUsTotal - body.onUsTotal, 2);
  });
});
