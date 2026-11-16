/**
 * Accounting audit wave 8.4 continuation: factory revenue, receivables and
 * payables in the general ledger.
 *
 *   - factory FX is date-aware: the latest confirmed rate dated on or before
 *     the transaction date, never a later one; none means no rate (never 1);
 *   - a factory POS sale posts FPOS-RCPT-{sale} normalized (USD base at the
 *     sale-date rate, native in transaction_*); a non-USD sale with no rate is
 *     refused (409) with nothing written;
 *   - a credit sale credits income for the full sale, debits cash for the
 *     deposit and the customer's own ledger for the unpaid part; the
 *     not-in-ledger memo no longer lists it (a legacy deposit-only sale stays
 *     listed); deductions above the cash received balance (cash credited);
 *   - an edit replaces the voucher whole (a legacy FPOS-{sale}-… one too), a
 *     void removes it;
 *   - container commission posts FACTORY-COMM-{container} (Dr import cost /
 *     Cr the commission payee), replaced on change, removed when the
 *     commission is removed or the container deleted; a legacy container's
 *     commission is listed by the integrity diagnostic and the memo;
 *   - the daily factory stock journal's receipt credit to import cost is now
 *     matched by the commission it charged, so commission drives no net
 *     credit on the expense account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { findFactoryFxRateOnOrBefore } from "../server/services/factory/factoryFxRateOnDate";
import { getOrFetchFxRateToUsd } from "../server/routes/factory/_helpers";
import { loadPartyMemoLines } from "../server/services/accounting/balances/unpostedMemo";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { syncFactoryStockJournalTx } from "../server/services/accounting/perpetualInventory/factoryStockJournal";
import { registerPosSaleWriteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-write";
import { registerPosSaleDeleteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-delete";
import { registerFactoryContainerCreateRoutes } from "../server/routes/factory/containers/create";
import { registerFactoryContainerUpdateRoutes } from "../server/routes/factory/containers/update";
import { registerFactoryContainerDeleteRoutes } from "../server/routes/factory/containers/delete";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w84pc";
const today = new Date().toISOString().slice(0, 10);

type Handler = (req: unknown, res: unknown, next?: () => unknown) => Promise<unknown> | unknown;
const routes = new Map<string, Handler[]>();
const fakeApp = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: unknown, ...handlers: Handler[]) => {
        if (typeof path === "string") routes.set(`${method.toUpperCase()} ${path}`, handlers);
      },
  }
) as never;

let companyId: number;
let customerId: number;
let cashAccountId: number;
let expenseAccountId: number;
let supplierId: number;
let requestSeq = 0;

async function call(route: string, req: Record<string, any>) {
  const handlers = routes.get(route);
  if (!handlers) throw new Error(`route not registered: ${route}`);
  const [method, path] = route.split(" ");
  let statusCode = 200;
  let body: any;
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
    setHeader: () => res,
  };
  const headers: Record<string, string> = { "x-client-date": today };
  requestSeq += 1;
  const request = {
    method,
    path,
    params: {},
    query: {},
    get: (name: string) => headers[name.toLowerCase()],
    header: (name: string) => headers[name.toLowerCase()],
    ...req,
    body: { clientRequestId: `${PREFIX}-${requestSeq}`, ...(req.body ?? {}) },
    headers,
    session: { factoryCompanyId: companyId, currentCompanyId: companyId, userId: "1", username: "owner" },
  };
  for (const [index, handler] of handlers.entries()) {
    let next = false;
    await handler(request, res, () => {
      next = true;
    });
    if (index < handlers.length - 1 && !next) break;
  }
  return { statusCode, body };
}

const one = async <T = any>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0] as T;
const all = async <T = any>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[];

interface Line {
  code: string | null;
  customer: number | null;
  supplier: number | null;
  d: string;
  c: string;
  ccy: string | null;
  td: string | null;
  tc: string | null;
  rate: string | null;
}

/** A voucher's header and lines (null when it does not exist). */
async function voucher(number: string) {
  const header = await one<{ id: number; voucher_type: string; currency: string; exchange_rate: string }>(
    `SELECT id, voucher_type, currency, exchange_rate::text FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
    [companyId, number]
  );
  if (!header) return null;
  const lines = await all<Line>(
    `SELECT la.code, ve.customer_id AS customer, ve.factory_supplier_id AS supplier,
            ve.debit_amount::numeric(20,2)::text AS d, ve.credit_amount::numeric(20,2)::text AS c,
            ve.transaction_currency AS ccy,
            ve.transaction_debit_amount::numeric(20,2)::text AS td,
            ve.transaction_credit_amount::numeric(20,2)::text AS tc,
            ve.historical_exchange_rate::text AS rate
       FROM voucher_entries ve LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY ve.id`,
    [header.id]
  );
  const debit = lines.reduce((sum, line) => sum + Number(line.d), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.c), 0);
  return { ...header, lines, balanced: Math.abs(debit - credit) < 0.005 };
}

const vouchersLike = async (pattern: string) =>
  all<{ voucher_number: string }>(
    `SELECT voucher_number FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL ORDER BY id`,
    [companyId, pattern]
  );

async function customerMemo() {
  return (await loadPartyMemoLines(db, { companyId, kind: "customer", ids: [customerId] })).get(customerId) ?? [];
}

async function cleanup(id: number) {
  // audit_log is append-only (wave 12): its rows go through the test-only helper.
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
    const q = (text: string) => client.query(text, [id]);
    await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`);
    await q(`DELETE FROM accounting_posting_requests WHERE company_id = $1`);
    await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`);
    await q(`DELETE FROM vouchers WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_bales WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_items WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sales WHERE company_id = $1`);
    for (const table of [
      "customer_balances",
      "factory_container_receipts",
      "factory_container_commissions",
      "factory_stock_value_events",
      "factory_daybook_entries",
      "factory_fx_rates",
      "financial_operation_requests",
    ]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`);
    }
    await q(`DELETE FROM factory_containers WHERE company_id = $1`);
    await q(`DELETE FROM factory_suppliers WHERE company_id = $1`);
    await q(`UPDATE customers SET ledger_account_id = NULL WHERE company_id = $1`);
    await q(`DELETE FROM customers WHERE company_id = $1`);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`);
    await q(`DELETE FROM companies WHERE id = $1`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await ensureFactoryCostBasisSchema(pool);
  for (const leftover of await all<{ id: number }>(`SELECT id FROM companies WHERE code = $1`, [
    PREFIX.toUpperCase(),
  ])) {
    await cleanup(leftover.id);
  }
  for (const register of [
    registerPosSaleWriteRoutes,
    registerPosSaleDeleteRoutes,
    registerFactoryContainerCreateRoutes,
    registerFactoryContainerUpdateRoutes,
    registerFactoryContainerDeleteRoutes,
  ]) {
    register(fakeApp);
  }
  companyId = (
    await one(
      `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
      [PREFIX.toUpperCase()]
    )
  ).id;
  customerId = (
    await one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
      companyId,
      `${PREFIX}-CUST`,
    ])
  ).id;
  const account = async (code: string, type: string) =>
    (
      await one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
        [companyId, code, type]
      )
    ).id;
  cashAccountId = await account(`${PREFIX}-CASH`, "Cash");
  expenseAccountId = await account(`${PREFIX}-LOADING`, "Expense");
  supplierId = (
    await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      companyId,
      `${PREFIX} supplier`,
    ])
  ).id;
  // Confirmed CFA rates: 0.0016 from January, 0.0020 from June. EUR from January.
  await pool.query(
    `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
     VALUES ($1, 'XOF', 0.0016, '2026-01-01', 'manual'), ($1, 'XOF', 0.0020, '2026-06-01', 'manual'),
            ($1, 'EUR', 1.1, '2026-01-01', 'manual')`,
    [companyId]
  );
}, 60000);

afterAll(async () => {
  await cleanup(companyId);
}, 60000);

describe("date-aware factory FX", () => {
  it("takes the latest confirmed rate dated on or before the date, never a later one", async () => {
    expect((await findFactoryFxRateOnOrBefore(db, companyId, "XOF", "2026-03-15"))?.rate).toBe("0.00160000");
    expect((await findFactoryFxRateOnOrBefore(db, companyId, "XOF", "2026-07-01"))?.rate).toBe("0.00200000");
    expect(await findFactoryFxRateOnOrBefore(db, companyId, "XOF", "2025-12-31")).toBeNull();
    expect((await findFactoryFxRateOnOrBefore(db, companyId, "USD", "2025-12-31"))?.rate).toBe("1");
    // The mutation lookup no longer takes the most recent manual rate whatever its date.
    expect(await getOrFetchFxRateToUsd(companyId, "XOF", "2026-03-15")).toBe("0.00160000");
  });
});

describe("factory POS sale in the ledger", () => {
  it("posts a CFA sale at the sale-date rate: USD base, native amounts, the rate", async () => {
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        txDate: "2026-03-15",
        currencyCode: "XOF",
        cashAccountId,
        paymentType: "CASH",
        items: [{ productName: "Loose bale", quantity: 2, unitPrice: "50000" }],
      },
    });
    expect({ statusCode: sale.statusCode, message: sale.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    const posted = await voucher(`FPOS-RCPT-${sale.body.id}`);
    expect(posted).toMatchObject({ voucher_type: "Receipt", currency: "XOF", balanced: true });
    expect(Number(posted!.exchange_rate)).toBe(0.0016);
    // 100,000 XOF at 0.0016 (January) = 160.00 USD; the June rate (0.0020) is not used.
    // The currency normalization trigger (installed at boot, wave 14) stores XOF lines as CFA.
    expect(posted!.lines.map((l) => [l.code, l.d, l.c, l.ccy, l.td, l.tc, Number(l.rate)])).toEqual([
      [`${PREFIX}-CASH`, "160.00", "0.00", "CFA", "100000.00", "0.00", 0.0016],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "160.00", "CFA", "0.00", "100000.00", 0.0016],
    ]);
    const daybook = await one(
      `SELECT fx_rate_to_usd::text AS rate, amount_usd::text AS usd FROM factory_daybook_entries
        WHERE company_id = $1 AND reference_table = 'factory_pos_sales' AND reference_id = $2 AND tx_type = 'BALE_SALE'`,
      [companyId, sale.body.id]
    );
    expect([Number(daybook.rate), daybook.usd]).toEqual([0.0016, "160.00"]);
  });

  it("refuses a non-USD sale with no confirmed rate on or before its date, writing nothing", async () => {
    const before = await one(`SELECT COUNT(*)::int AS n FROM factory_pos_sales WHERE company_id = $1`, [companyId]);
    for (const [currencyCode, txDate] of [
      ["GBP", "2026-03-15"],
      ["XOF", "2025-12-31"],
    ]) {
      const refused = await call("POST /api/factory/pos/sale", {
        body: {
          txDate,
          currencyCode,
          cashAccountId,
          paymentType: "CASH",
          items: [{ productName: "Loose bale", quantity: 1, unitPrice: "10" }],
        },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.body.code).toBe("FACTORY_POS_RATE_UNCONFIRMED");
    }
    const after = await one(`SELECT COUNT(*)::int AS n FROM factory_pos_sales WHERE company_id = $1`, [companyId]);
    expect(after.n).toBe(before.n);
  });

  let creditSaleId: number;
  it("posts a credit sale whole: income in full, cash deposit, the customer's ledger for the unpaid part", async () => {
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        txDate: "2026-03-20",
        currencyCode: "USD",
        cashAccountId,
        customerId,
        customerName: "Credit customer",
        paymentType: "CREDIT",
        depositAmount: "50",
        items: [{ productName: "Loose bale", quantity: 2, unitPrice: "100" }],
      },
    });
    expect(sale.statusCode).toBe(200);
    creditSaleId = sale.body.id;
    const posted = await voucher(`FPOS-RCPT-${creditSaleId}`);
    expect(posted?.balanced).toBe(true);
    expect(posted!.lines.map((l) => [l.code, l.customer, l.d, l.c])).toEqual([
      [`${PREFIX}-CASH`, null, "50.00", "0.00"],
      [`CUST-${customerId}`, customerId, "150.00", "0.00"],
      ["FACTORY_BALE_SALES_INCOME", null, "0.00", "200.00"],
    ]);
    // The operational cache keeps its rows, but the memo no longer lists the sale.
    const cache = await all(
      `SELECT reference_type FROM customer_balances WHERE company_id = $1 AND reference_id = $2 ORDER BY id`,
      [companyId, creditSaleId]
    );
    expect(cache.map((row) => row.reference_type)).toEqual(["FACTORY_POS_SALE", "FACTORY_POS_DEPOSIT"]);
    expect((await customerMemo()).filter((line) => line.source.startsWith("factoryPos"))).toEqual([]);
  });

  it("balances deductions above the cash received on their own accounts", async () => {
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        txDate: "2026-03-21",
        cashAccountId,
        customerId,
        paymentType: "CREDIT",
        depositAmount: "10",
        items: [{ productName: "Loose bale", quantity: 1, unitPrice: "100" }],
        expenses: [{ accountId: expenseAccountId, description: "Loading", amount: "30" }],
      },
    });
    // It used to debit cash max(0, 10 − 30) = 0 and the expense 30 against a credit of 10: refused.
    expect(sale.statusCode).toBe(200);
    const posted = await voucher(`FPOS-RCPT-${sale.body.id}`);
    expect(posted?.balanced).toBe(true);
    expect(posted!.lines.map((l) => [l.code, l.d, l.c])).toEqual([
      [`${PREFIX}-CASH`, "0.00", "20.00"],
      [`${PREFIX}-LOADING`, "30.00", "0.00"],
      [`CUST-${customerId}`, "90.00", "0.00"],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "100.00"],
    ]);
  });

  it("refuses a sale that would leave cash or the receivable with no account", async () => {
    const noCash = await call("POST /api/factory/pos/sale", {
      body: { paymentType: "CASH", items: [{ productName: "Loose bale", quantity: 1, unitPrice: "10" }] },
    });
    expect(noCash.statusCode).toBe(400);
    const noCustomer = await call("POST /api/factory/pos/sale", {
      body: {
        paymentType: "CREDIT",
        depositAmount: "0",
        items: [{ productName: "Loose bale", quantity: 1, unitPrice: "10" }],
      },
    });
    expect(noCustomer.statusCode).toBe(400);
  });

  it("replaces the voucher whole on an edit and removes it on a void", async () => {
    const edited = await call("PUT /api/factory/pos/sales/:id", {
      params: { id: String(creditSaleId) },
      body: {
        txDate: "2026-03-22",
        customerId,
        paymentType: "CREDIT",
        depositAmount: "0",
        items: [{ productName: "Loose bale", quantity: 3, unitPrice: "100" }],
      },
    });
    expect({ statusCode: edited.statusCode, message: edited.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    expect(await vouchersLike(`FPOS-RCPT-${creditSaleId}`)).toHaveLength(1);
    const posted = await voucher(`FPOS-RCPT-${creditSaleId}`);
    // No deposit and no deductions: no cash leg, a receivable-only journal.
    expect(posted?.voucher_type).toBe("Journal");
    expect(posted!.lines.map((l) => [l.code, l.d, l.c])).toEqual([
      [`CUST-${customerId}`, "300.00", "0.00"],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "300.00"],
    ]);

    const voided = await call("DELETE /api/factory/pos/sales/:id", { params: { id: String(creditSaleId) } });
    expect(voided.statusCode).toBe(200);
    expect(await voucher(`FPOS-RCPT-${creditSaleId}`)).toBeNull();
    expect((await customerMemo()).filter((line) => line.reference?.endsWith(`-${creditSaleId}`))).toEqual([]);
  });

  it("keeps a legacy deposit-only sale in the memo until an edit replaces its voucher", async () => {
    const legacy = await one(
      `INSERT INTO factory_pos_sales (company_id, sale_number, tx_date, customer_id, total_amount, currency_code,
                                      cash_account_id, payment_type, deposit_amount, status)
       VALUES ($1, 'FPOS-LEGACY', '2026-02-01', $2, 80, 'USD', $3, 'CREDIT', 20, 'COMPLETED') RETURNING id`,
      [companyId, customerId, cashAccountId]
    );
    await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_id,
                                      reference_type, debit_amount, credit_amount, balance, currency, description)
       VALUES ($1, $2, '2026-02-01', 'SALE', $3, 'FACTORY_POS_SALE', 80, 0, 80, 'USD', 'POS Sale FPOS-LEGACY'),
              ($1, $2, '2026-02-01', 'PAYMENT', $3, 'FACTORY_POS_DEPOSIT', 0, 20, 60, 'USD', 'Deposit')`,
      [companyId, customerId, legacy.id]
    );
    await withFixtureTransaction(async (client) => {
      const header = await client.query(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency,
                               exchange_rate, source_module)
         VALUES ($1, 'Receipt', $2, '2026-02-01', 20, 'USD', 1, 'FACTORY_POS') RETURNING id`,
        [companyId, `FPOS-${legacy.id}-1700000000000`]
      );
      const income = await client.query(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'FACTORY_BALE_SALES_INCOME'`,
        [companyId]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, 20, 0, 'deposit'), ($1, $3, 0, 20, 'income')`,
        [header.rows[0].id, cashAccountId, income.rows[0].id]
      );
    });
    const listed = (await customerMemo()).filter((line) => line.reference?.endsWith(`-${legacy.id}`));
    expect(listed.map((line) => [line.source, line.amount])).toEqual([
      ["factoryPosCreditSale", "80.00"],
      ["factoryPosDeposit", "-20.00"],
    ]);

    const edited = await call("PUT /api/factory/pos/sales/:id", {
      params: { id: String(legacy.id) },
      body: {
        txDate: "2026-02-01",
        cashAccountId,
        customerId,
        paymentType: "CREDIT",
        depositAmount: "20",
        items: [{ productName: "Loose bale", quantity: 1, unitPrice: "80" }],
      },
    });
    expect(edited.statusCode).toBe(200);
    expect((await vouchersLike(`FPOS-${legacy.id}-%`)).map((row) => row.voucher_number)).toEqual([]);
    const posted = await voucher(`FPOS-RCPT-${legacy.id}`);
    expect(posted!.lines.map((l) => [l.code, l.d, l.c])).toEqual([
      [`${PREFIX}-CASH`, "20.00", "0.00"],
      [`CUST-${customerId}`, "60.00", "0.00"],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "80.00"],
    ]);
    expect((await customerMemo()).filter((line) => line.reference?.endsWith(`-${legacy.id}`))).toEqual([]);
  });
});

async function createContainer(number: string, extra: Record<string, unknown>) {
  const created = await call("POST /api/factory/containers", {
    body: {
      containerNumber: `${PREFIX}-${number}`,
      supplierId,
      totalKg: "1000",
      ratePerKg: "2",
      currencyCode: "USD",
      arrivalDate: "2026-03-01",
      ...extra,
    },
  });
  expect({ statusCode: created.statusCode, message: created.body?.message }).toEqual({
    statusCode: 200,
    message: undefined,
  });
  return created.body.id as number;
}

describe("container commission in the ledger", () => {
  it("posts FACTORY-COMM when commission is set, replaces it on change and removes it", async () => {
    const containerId = await createContainer("C1", { commissionAmount: "500", commissionCurrencyCode: "USD" });
    const posted = await voucher(`FACTORY-COMM-${containerId}`);
    expect(posted?.balanced).toBe(true);
    expect(posted!.lines.map((l) => [l.code, l.supplier, l.d, l.c])).toEqual([
      ["FACTORY_IMPORT_COST", null, "500.00", "0.00"],
      [null, supplierId, "0.00", "500.00"],
    ]);

    const changed = await call("PATCH /api/factory/containers/:id", {
      params: { id: String(containerId) },
      body: { commissionAmount: "700" },
    });
    expect(changed.statusCode).toBe(200);
    expect(await vouchersLike(`FACTORY-COMM-${containerId}%`)).toHaveLength(1);
    expect((await voucher(`FACTORY-COMM-${containerId}`))!.lines.map((l) => l.c)).toEqual(["0.00", "700.00"]);

    const removed = await call("PATCH /api/factory/containers/:id", {
      params: { id: String(containerId) },
      body: { commissionAmount: "0" },
    });
    expect(removed.statusCode).toBe(200);
    expect(await voucher(`FACTORY-COMM-${containerId}`)).toBeNull();

    await call("PATCH /api/factory/containers/:id", {
      params: { id: String(containerId) },
      body: { commissionAmount: "300" },
    });
    expect(await voucher(`FACTORY-COMM-${containerId}`)).not.toBeNull();
    const deleted = await call("DELETE /api/factory/containers/:id", { params: { id: String(containerId) } });
    expect(deleted.statusCode).toBe(200);
    expect(await voucher(`FACTORY-COMM-${containerId}`)).toBeNull();
  });

  it("posts a commission in another currency at its confirmed rate, normalized", async () => {
    const containerId = await createContainer("C2", { commissionAmount: "100", commissionCurrencyCode: "EUR" });
    const posted = await voucher(`FACTORY-COMM-${containerId}`);
    expect(posted).toMatchObject({ currency: "EUR", balanced: true });
    expect(posted!.lines.map((l) => [l.d, l.c, l.ccy, l.td, l.tc, Number(l.rate)])).toEqual([
      ["110.00", "0.00", "EUR", "100.00", "0.00", 1.1],
      ["0.00", "110.00", "EUR", "0.00", "100.00", 1.1],
    ]);
  });

  it("lists a legacy container's unjournalled commission in the diagnostic and the memo", async () => {
    const legacy = await one(
      `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id,
                                       commission_amount, commission_currency_code, arrival_date)
       VALUES ($1, $2, 'USD', 1, $3, 250, 'USD', '2026-02-01') RETURNING id`,
      [companyId, `${PREFIX}-LEGACY`, supplierId]
    );
    const report = await runAccountingIntegrityDiagnostic(companyId);
    const listed = report.checks.find((c) => c.key === "factory_container_commission_not_journalled");
    expect(listed?.status).toBe("warn");
    expect(listed?.samples.map((row) => row.id)).toEqual([legacy.id]);

    const memo =
      (await loadPartyMemoLines(db, { companyId, kind: "factorySupplier", ids: [supplierId] })).get(supplierId) ?? [];
    const commission = memo.filter((line) => line.source === "factoryContainerCommission");
    expect(commission.map((line) => [line.sourceId, line.amount])).toEqual([[legacy.id, "-250.00"]]);
  });
});

describe("daily factory stock journal and commission", () => {
  it("credits import cost for a receipt no more than the import and commission charged to it", async () => {
    const containerId = await createContainer("C3", { commissionAmount: "500", commissionCurrencyCode: "USD" });
    await pool.query(
      `INSERT INTO factory_container_receipts (company_id, container_id, receipt_date, received_kg,
                                               cumulative_received_kg, receipt_value_usd)
       VALUES ($1, $2, $3, 1000, 1000, 2500)`,
      [companyId, containerId, today]
    );
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [companyId, today]
    );
    const result = await db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId, today));
    expect(result.voucherId).not.toBeNull();
    const net = await one<{ net: string }>(
      `SELECT SUM(ve.debit_amount - ve.credit_amount)::numeric(20,2)::text AS net
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
         JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'FACTORY_IMPORT_COST'
        WHERE v.company_id = $1 AND v.deleted_at IS NULL
          AND (v.voucher_number LIKE $2 OR v.voucher_number = $3 OR v.voucher_number LIKE 'GL-FACTORY-STOCK-%')`,
      [companyId, `FACTORY-IMPORT-${containerId}-%`, `FACTORY-COMM-${containerId}`]
    );
    // Goods 2,000 + commission 500 charged; the 2,500 receipt credits them back: no net credit.
    expect(net.net).toBe("0.00");
  });
});
