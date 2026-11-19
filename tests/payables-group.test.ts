/**
 * Accounting audit wave 13 (B): payables, party statements and the group, on
 * the one balance engine.
 *
 *   - ERP suppliers (A1): the Suppliers page, the supplier balance, payables
 *     and the supplier statement read the engine (kind "supplier"): a
 *     supplier-tagged line on a bank belongs to the bank and is not counted a
 *     second time on the supplier; the company filter is always applied.
 *   - Factory suppliers (A2, owner decision 3): the primary balance is the
 *     ledger (USD base), with the native balance per currency of the same
 *     lines beside it and the container amounts not yet in the ledger as a
 *     separate memo; the operational container figure is only a memo, and a
 *     third-currency freight with no rate is flagged instead of dropped.
 *   - Customer statements (A3) list the engine's lines, so opening + lines
 *     foots to the engine balance.
 *   - Chat receivables and the alerts digest (A4/M3) are the engine's, and the
 *     chat supplier list is company-filtered.
 *   - Shared suppliers (M1, owner decision 2): a subsidiary's payable to a
 *     parent's supplier is in the subsidiary's net position and counted once
 *     in the group.
 *   - Paired elimination (M2, owner decision 1): matched intercompany pairs net
 *     out; a mismatch is shown as an "Intercompany difference" line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { pool, db } from "../server/db";
import { getPartyBalance, getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { getSupplierBalanceForContext } from "../server/routes/helpers/supplierBalanceHelpers";
import { supplierService } from "../server/routes/suppliers/supplierService";
import { registerAccountPayableRoutes } from "../server/routes/accounts/payables";
import { getVoucherEntriesBySupplier } from "../server/storage/accounting/vouchers";
import { registerSupplierBalanceSingleRoutes } from "../server/routes/factory/suppliers/balance/single";
import { registerSupplierWithBalancesRoutes } from "../server/routes/factory/suppliers/balance/with-balances";
import { customerService } from "../server/routes/customers/customerService";
import { registerPosCustomerRoutes } from "../server/routes/pos/posCustomerRoutes";
import { getERPContext, clearERPContextCache } from "../server/chat/erpContext";
import { registerChatbotAlertRoutes } from "../server/routes/chatbot/alerts";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { loadCompanyIntercompanyAccounts } from "../server/helpers/groupIntercompany";
import { calculateGroupNetPosition, pairIntercompanyBalances } from "../server/helpers/groupNetPosition";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { normalizedLineFields } from "./helpers/normalizedVoucherLine";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w13pg";
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

let parent: number;
let child: number;
let factory: number;
let supplier: number;
let childOwnSupplier: number;
let bank: number;
let customer: number;
let customerLedger: number;
let factorySupplier: number;
let icParent: number;
let icChild: number;
let sequence = 0;

type Line = {
  ledger?: number;
  bank?: number;
  customer?: number;
  supplier?: number;
  factorySupplier?: number;
  debit: string;
  credit: string;
  currency?: string;
  nativeDebit?: string;
  nativeCredit?: string;
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
      const normalized = line.currency !== undefined;
      const isDebit = Number(line.debit) > 0;
      // Fully normalized (rate and convention too): the currency trigger keeps it as given.
      const dual = normalized
        ? normalizedLineFields(
            isDebit ? line.debit : line.credit,
            (isDebit ? line.nativeDebit : line.nativeCredit) ?? "0",
            isDebit ? "debit" : "credit"
          )
        : null;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
                                      factory_supplier_id, debit_amount, credit_amount, transaction_currency,
                                      transaction_debit_amount, transaction_credit_amount, base_debit_amount,
                                      base_credit_amount, historical_exchange_rate, rate_convention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          created.rows[0].id,
          line.ledger ?? null,
          line.bank ?? null,
          line.customer ?? null,
          line.supplier ?? null,
          line.factorySupplier ?? null,
          line.debit,
          line.credit,
          normalized ? line.currency : null,
          dual?.transactionDebit ?? null,
          dual?.transactionCredit ?? null,
          dual?.baseDebit ?? null,
          dual?.baseCredit ?? null,
          dual?.rate ?? null,
          dual?.convention ?? null,
        ]
      );
    }
    return created.rows[0].id;
  });
}

async function insertId(query: string, params: unknown[]): Promise<number> {
  return (await pool.query<{ id: number }>(query, params)).rows[0].id;
}

async function ledger(companyId: number, code: string, type: string) {
  return insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 0, 'Dr') RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} ${code}`, type]
  );
}

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX}%`]);
  const ids = companies.rows.map((row) => row.id);
  if (ids.length === 0) return;
  await pool.query(
    "DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1::int[]) OR to_company_id = ANY($1::int[])",
    [ids]
  );
  for (const id of ids) {
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]).catch(() => undefined);
  }
  // Children first: companies.parent_company_id references the parent.
  for (const id of [...ids].reverse()) {
    await pool.query("DELETE FROM customer_balances WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM bank_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM factory_containers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM company_settings WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id = $1", [id]);
  }
  await pool.query("UPDATE companies SET parent_company_id = NULL WHERE id = ANY($1::int[])", [ids]);
  await pool.query("DELETE FROM companies WHERE id = ANY($1::int[])", [ids]);
}

beforeAll(async () => {
  await cleanup();
  const company = (type: string, suffix: string, parentId: number | null = null) =>
    insertId(
      `INSERT INTO companies (code, name, company_type, base_currency, parent_company_id)
       VALUES ($1, $2, $3, 'USD', $4) RETURNING id`,
      [`${PREFIX.toUpperCase()}${suffix}`, `${PREFIX} ${suffix} company`, type, parentId]
    );
  parent = await company("erp", "P");
  child = await company("erp", "C", parent);
  factory = await company("factory", "F");

  // ── Parent: a supplier with a 100 Cr opening; a purchase of 300; a 120 payment
  // whose bank line is also tagged with the supplier (the bank owns that line).
  const purchases = await ledger(parent, "PURCH", "Expense");
  bank = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Test Bank', '001', 1000, 'Dr') RETURNING id`,
    [parent, `${PREFIX}-BANK`, `${PREFIX} bank`]
  );
  supplier = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 100, 'Cr') RETURNING id`,
    [parent, `${PREFIX}-SUP`, `${PREFIX} shared supplier`, `${PREFIX}@example.test`]
  );
  await voucher(
    parent,
    [
      { ledger: purchases, debit: "300.00", credit: "0" },
      { supplier, debit: "0", credit: "300.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    parent,
    [
      { supplier, debit: "120.00", credit: "0" },
      { bank, supplier, debit: "0", credit: "120.00" },
    ],
    "2026-09-03"
  );

  // ── Subsidiary: posts a 50 payable to the parent's shared supplier, and has
  // its own supplier with an opening the parent must never see.
  const childExpense = await ledger(child, "EXP", "Expense");
  await voucher(
    child,
    [
      { ledger: childExpense, debit: "50.00", credit: "0" },
      { supplier, debit: "0", credit: "50.00" },
    ],
    "2026-09-04"
  );
  childOwnSupplier = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 999, 'Cr') RETURNING id`,
    [child, `${PREFIX}-CSUP`, `${PREFIX} child supplier`, `${PREFIX}.c@example.test`]
  );

  // ── Parent customer: 200 Dr opening on the record, an invoice of 150 on its
  // linked ledger, a receipt of 80; a customer-tagged line on the bank and one
  // on another ledger belong to those accounts, not to the customer.
  const sales = await ledger(parent, "SALES", "Income");
  customerLedger = await ledger(parent, "CUST", "Asset");
  customer = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 200, 'Dr') RETURNING id`,
    [parent, `${PREFIX}-CU`, `${PREFIX} customer`, customerLedger]
  );
  await voucher(
    parent,
    [
      { ledger: customerLedger, customer, debit: "150.00", credit: "0" },
      { ledger: sales, customer, debit: "0", credit: "150.00" },
    ],
    "2026-09-05"
  );
  await voucher(
    parent,
    [
      { bank, customer, debit: "80.00", credit: "0" },
      { ledger: customerLedger, customer, debit: "0", credit: "80.00" },
    ],
    "2026-09-06"
  );

  // ── Factory supplier: an EUR import journal (450 EUR = 500 USD), a 100 USD
  // payment; a legacy EUR container with no journal (memo, 500 EUR at 1.1),
  // and a container whose supplier-paid freight is in AUD with no rate.
  const fExpense = await ledger(factory, "FEXP", "Expense");
  const fCash = await ledger(factory, "FCASH", "Asset");
  factorySupplier = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, $2, 0) RETURNING id`,
    [factory, `${PREFIX} factory supplier`]
  );
  await voucher(
    factory,
    [
      { ledger: fExpense, debit: "500.00", credit: "0", currency: "EUR", nativeDebit: "450.00" },
      { factorySupplier, debit: "0", credit: "500.00", currency: "EUR", nativeCredit: "450.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    factory,
    [
      { factorySupplier, debit: "100.00", credit: "0" },
      { ledger: fCash, debit: "0", credit: "100.00" },
    ],
    "2026-09-03"
  );
  await pool.query(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, total_kg, rate_per_kg, currency_code,
                                     fx_rate_to_usd, fx_rate_confirmed, arrival_date, freight_paid_by, status)
     VALUES ($1, $2, $3, 1000, 0.5, 'EUR', 1.1, true, '2026-09-04', 'own', 'OFFLOADED')`,
    [factory, `${PREFIX}-LEGACY`, factorySupplier]
  );
  await pool.query(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, total_kg, rate_per_kg, currency_code,
                                     fx_rate_to_usd, fx_rate_confirmed, arrival_date, freight, freight_currency_code,
                                     freight_paid_by, freight_supplier_id, status)
     VALUES ($1, $2, $3, 0, 0, 'USD', 1, true, '2026-09-05', 300, 'AUD', 'supplier', $3, 'OFFLOADED')`,
    [factory, `${PREFIX}-AUDFRT`, factorySupplier]
  );

  // ── Intercompany: a transfer between parent and subsidiary, booked 100 at
  // the parent and 90 at the subsidiary (a 10 mismatch).
  icParent = await ledger(parent, "IC-C", "Asset");
  icChild = await ledger(child, "IC-P", "Liability");
  const pCash = await ledger(parent, "PCASH", "Cash");
  const cCash = await ledger(child, "CCASH", "Cash");
  await voucher(
    parent,
    [
      { ledger: icParent, debit: "100.00", credit: "0" },
      { ledger: pCash, debit: "0", credit: "100.00" },
    ],
    "2026-09-07"
  );
  await voucher(
    child,
    [
      { ledger: cCash, debit: "90.00", credit: "0" },
      { ledger: icChild, debit: "0", credit: "90.00" },
    ],
    "2026-09-07"
  );
  await pool.query(
    `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
                                          from_ledger_account_id, to_ledger_account_id)
     VALUES ('Cash', $1, $2, '2026-09-07', 100, $3, $4)`,
    [parent, child, icParent, icChild]
  );

  registerAccountPayableRoutes(fakeApp);
  registerSupplierBalanceSingleRoutes(fakeApp);
  registerSupplierWithBalancesRoutes(fakeApp);
  registerPosCustomerRoutes(fakeApp);
  registerChatbotAlertRoutes(fakeApp);
}, 60_000);

afterAll(async () => {
  await cleanup();
}, 60_000);

describe("ERP supplier balances on the engine (A1)", () => {
  it("counts a supplier-tagged bank line once, on the bank", async () => {
    const party = await getPartyBalance(db, { companyId: parent, kind: "supplier", id: supplier });
    // −100 opening − 300 purchase + 120 payment; the bank line tagged with the supplier is the bank's.
    expect(party?.closing).toBe("-280.00");

    const context = await getSupplierBalanceForContext({ id: supplier, companyId: parent }, parent);
    expect(context).toMatchObject({ balance: 280, openingBalance: 100, openingBalanceSide: "Cr" });
    expect(context.balancesByCurrency.USD).toEqual({ debit: 120, credit: 300, net: 180 });

    const balance = await supplierService.balance(supplier, parent);
    expect(balance).toMatchObject({ balance: 280, openingBalance: 100, balanceBasis: "ledger" });

    const stats = await supplierService.stats(parent);
    expect(stats.find((row) => row.id === supplier)).toMatchObject({ balance: 280, postedFromOtherCompany: false });

    const payables = await call("GET /api/accounts/payables", { session: { currentCompanyId: parent } });
    expect(payables.body.find((row: any) => row.id === supplier)).toMatchObject({ balance: 280 });

    // The statement lists exactly the supplier's own lines.
    const statement = await getVoucherEntriesBySupplier(supplier, parent, undefined, undefined, { ownedOnly: true });
    expect(statement.map((row) => [row.debitAmount, row.creditAmount]).sort()).toEqual([
      ["0.00", "300.00"],
      ["120.00", "0.00"],
    ]);
  });

  it("filters by company: each company sees the lines its vouchers posted, the opening stays with the owner", async () => {
    const inChild = await getSupplierBalanceForContext({ id: supplier, companyId: parent }, child);
    expect(inChild).toMatchObject({ balance: 50, openingBalance: 0, voucherCompanyId: child });

    const childStats = await supplierService.stats(child);
    expect(childStats.find((row) => row.id === supplier)).toMatchObject({ balance: 50, postedFromOtherCompany: true });
    const parentStats = await supplierService.stats(parent);
    expect(parentStats.some((row) => row.id === childOwnSupplier)).toBe(false);

    const childPayables = await call("GET /api/accounts/payables", { session: { currentCompanyId: child } });
    expect(childPayables.body.find((row: any) => row.id === supplier)).toMatchObject({
      balance: 50,
      postedFromOtherCompany: true,
    });
    expect(childPayables.body.find((row: any) => row.id === childOwnSupplier)).toMatchObject({ balance: 999 });
  });
});

describe("factory supplier pages on the ledger (A2)", () => {
  it("shows the USD ledger balance, the native balance per currency and the memo apart", async () => {
    const { body } = await call("GET /api/factory/suppliers/:id/balance", {
      params: { id: String(factorySupplier) },
      session: { factoryCompanyId: factory },
    });
    expect(body).toMatchObject({ balance: 400, outstandingUsd: 400, balanceBasis: "ledger", fxUnresolved: false });
    expect(body.nativeBalances).toEqual([
      expect.objectContaining({ currencyCode: "EUR", credit: "450.00", balance: "450.00", usdBalance: "500.00" }),
      expect.objectContaining({ currencyCode: "USD", debit: "100.00", balance: "-100.00" }),
    ]);
    // 500 EUR × 1.1 legacy goods; the AUD freight has no rate: listed, not totalled.
    expect(body.notInLedger).toMatchObject({ total: "550.00", unresolved: true });
    expect(body.notInLedger.lines.map((line: any) => line.source).sort()).toEqual([
      "factoryContainerFreight",
      "factoryContainerGoods",
    ]);
    // The operational formula is a memo; its third-currency freight is flagged, no longer dropped.
    expect(body.operationalMemo.fxUnresolved).toBe(true);

    const engine = await getPartyBalance(db, { companyId: factory, kind: "factorySupplier", id: factorySupplier });
    expect(engine?.closing).toBe("-400.00");
  });

  it("puts the same split on the supplier list", async () => {
    const { body } = await call("GET /api/factory/suppliers/with-balances", {
      session: { factoryCompanyId: factory },
    });
    const row = body.find((entry: any) => entry.id === factorySupplier);
    expect(row).toMatchObject({ totalValue: "400.00", balanceBasis: "ledger", notInLedgerTotal: "550.00" });
    expect(row.currencyBalances).toEqual([
      { currencyCode: "EUR", balance: 450, fxRateToUsd: expect.closeTo(1.111111, 5) },
      { currencyCode: "USD", balance: -100, fxRateToUsd: 1 },
    ]);
    expect(row.operationalMemo).toMatchObject({ fxUnresolved: true });
  });
});

describe("customer statements foot to the engine balance (A3)", () => {
  it("lists the customer's own lines on the Customers and POS statements", async () => {
    const party = await getPartyBalance(db, { companyId: parent, kind: "customer", id: customer });
    // 200 opening + 150 invoice − 80 receipt.
    expect(party?.closing).toBe("270.00");

    const rows = await customerService.transactions(customer, parent);
    const pos = await call("GET /api/pos/customers/:id/transactions", {
      params: { id: String(customer) },
      session: { currentCompanyId: parent },
    });
    for (const list of [rows, pos.body as typeof rows]) {
      // The bank line and the sales line tagged with the customer are not the customer's.
      expect(list).toHaveLength(2);
      const net = list.reduce((sum, row) => sum + Number(row.debitAmount) - Number(row.creditAmount), 0);
      expect(Number(party?.masterOpening) + net).toBeCloseTo(Number(party?.closing), 2);
    }
  });
});

describe("chat receivables and alerts (A4/M3)", () => {
  it("reads the engine, keeps memo apart and lists only this company's suppliers", async () => {
    clearERPContextCache(parent);
    const context = await getERPContext(parent);
    const { parties } = await getPartyBalances(db, { companyId: parent, kind: "customer" });
    const expected = parties.filter((p) => Number(p.closing) > 0).reduce((sum, p) => sum + Number(p.closing), 0);
    expect(context.financialSummary.totalReceivables).toBeCloseTo(expected, 2);
    expect(context.financialSummary.receivablesNotInLedger).toBe(0);
    expect(context.supplierBalances.find((row) => row.supplierId === supplier)).toMatchObject({ balance: 280 });
    expect(context.supplierBalances.some((row) => row.supplierId === childOwnSupplier)).toBe(false);

    const alerts = await call("GET /api/chatbot/alerts", { session: { currentCompanyId: parent } });
    expect(alerts.body.overdueCustomers.find((row: any) => row.customerId === customer)).toMatchObject({
      balance: 270,
    });
  });
});

describe("shared supplier in the posting company (M1)", () => {
  it("carries the subsidiary's payable in its own net position", async () => {
    const childPosition = await calculateNetPositionAsOf(child, AS_OF);
    const payables = childPosition.onUsLines.find((line) => line.label === "Supplier Payables");
    // The subsidiary's own supplier (999 opening) plus the 50 it posted to the shared supplier.
    expect(payables?.value).toBe(1049);

    const parentPosition = await calculateNetPositionAsOf(parent, AS_OF);
    expect(parentPosition.onUsLines.find((line) => line.label === "Supplier Payables")?.value).toBe(280);
  });

  it("counts the shared supplier once per posting company in the group, with the intercompany difference", async () => {
    const group = await calculateGroupNetPosition(AS_OF, new Set([parent, child]));
    const sharedLines = group.companies.flatMap((company) =>
      company.onUsLines
        .filter((line) => line.label === `${PREFIX} shared supplier`)
        .map((line) => [company.companyId, line.value])
    );
    expect(sharedLines.sort()).toEqual(
      [
        [child, 50],
        [parent, 280],
      ].sort()
    );
    // The transfer accounts left the company lines and came back as one difference.
    const lines = group.companies.flatMap((company) => [...company.forUsLines, ...company.onUsLines]);
    expect(lines.some((line) => line.label === `${PREFIX} IC-C` || line.label === `${PREFIX} IC-P`)).toBe(false);
    expect(group.intercompany).toMatchObject({ mode: "paired-elimination", additionalElimination: 90 });
    expect(group.intercompany.differences).toEqual([expect.objectContaining({ value: 10, side: "forUs" })]);
    const companyNet = group.companies.reduce((sum, company) => sum + company.netPosition, 0);
    expect(group.totals.netPosition).toBeCloseTo(companyNet + 10, 2);
  });
});

describe("paired intercompany elimination (M2)", () => {
  it("recognises the transfer accounts and shows the mismatch as an intercompany difference", async () => {
    const companies = [
      { id: parent, name: `${PREFIX} P company`, parentCompanyId: null },
      { id: child, name: `${PREFIX} C company`, parentCompanyId: parent },
    ];
    const parentAccounts = await loadCompanyIntercompanyAccounts(companies[0], companies, AS_OF);
    const childAccounts = await loadCompanyIntercompanyAccounts(companies[1], companies, AS_OF);
    expect(parentAccounts).toEqual([
      expect.objectContaining({ accountId: icParent, counterpartyCompanyIds: [child], balance: "100.00" }),
    ]);
    expect(childAccounts).toEqual([
      expect.objectContaining({ accountId: icChild, counterpartyCompanyIds: [parent], balance: "-90.00" }),
    ]);

    const values = [...parentAccounts, ...childAccounts].map((account) => ({
      ...account,
      value: Number(account.balance),
    }));
    const result = pairIntercompanyBalances(values, companies);
    expect(result.eliminated).toBe(90);
    expect(result.pairs).toEqual([
      expect.objectContaining({ receivables: 100, payables: 90, difference: 10, status: "mismatched" }),
    ]);
    expect(result.differences).toEqual([
      expect.objectContaining({ value: 10, side: "forUs", category: "Intercompany difference" }),
    ]);
  });

  it("nets a matched pair to nothing and keeps an account with no counterpart visible", () => {
    const companies = [
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ];
    const account = (companyId: number, accountId: number, value: number, counterparts: number[]) => ({
      companyId,
      accountId,
      accountName: `IC ${accountId}`,
      counterpartyCompanyIds: counterparts,
      sources: ["transfer" as const],
      balance: value.toFixed(2),
      value,
    });
    const matched = pairIntercompanyBalances([account(1, 10, 75, [2]), account(2, 20, -75, [1])], companies);
    expect(matched).toMatchObject({ eliminated: 75, differences: [] });
    expect(matched.pairs[0].status).toBe("matched");

    const unpaired = pairIntercompanyBalances([account(1, 11, -40, [])], companies);
    expect(unpaired.eliminated).toBe(0);
    expect(unpaired.differences).toEqual([expect.objectContaining({ value: 40, side: "onUs" })]);
  });
});
