/**
 * Accounting audit wave 10, part 3: bank accounts in net position.
 *
 *   - a bank_accounts master row (its opening with its side, and the lines
 *     that name it and no ledger account) is a cash/bank line of every net
 *     position — live with a date, the Excel export, the dated snapshot
 *     (monthly Excel, schedulers, WhatsApp) and the factory — at the balance
 *     engine's historical-base figure, labelled by the bank's name; an
 *     overdrawn bank is a liability;
 *   - a bank linked to a ledger account (bank_accounts.linked_ledger_id) is
 *     counted once: its own opening and bank-only lines on the bank line, the
 *     ledger's opening and every line naming the ledger (including a line
 *     naming both) on the ledger line;
 *   - the live net position without a date (current-rate cash/bank
 *     translation middleware) replaces each bank's row by its translation
 *     instead of adding a second one;
 *   - group net position includes each bank once per company.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import ExcelJS from "exceljs";

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { calculateGroupNetPosition } from "../server/helpers/groupNetPosition";
import { registerStatsNetProfitRoutes } from "../server/routes/stats/statsNetProfitRoutes";
import { registerStatsMultiCurrencyRoutes } from "../server/routes/stats/statsMultiCurrencyRoutes";
import { registerStatsNetPositionRoutes } from "../server/routes/stats/statsNetPositionRoutes";
import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = "w10npb";
const AS_OF = "2026-09-30";

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

/** Calls a route through the registered app-level middleware (the live cash/bank translation). */
async function call(route: string, req: Record<string, unknown>) {
  const handler = routes.get(route);
  if (!handler) throw new Error(`route not registered: ${route}`);
  const [method, path] = route.split(" ");
  let statusCode = 200;
  let body: any;
  let ended: Buffer | undefined;
  const res: Record<string, any> = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    end(value: Buffer) {
      ended = value;
      return res;
    },
    set: () => res,
    setHeader: () => res,
  };
  const request = { method, path, params: {}, query: {}, headers: { "x-client-date": "2026-10-08" }, body: {}, ...req };
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
  return { statusCode, body, ended };
}

let erp: number;
let factory: number;
let cashLedger: number;
let bankMain: number;
let bankOverdrawn: number;
let bankLinked: number;
let linkedLedger: number;
let factoryBank: number;
let sequence = 0;

type Line = { ledger?: number; bank?: number; debit: string; credit: string };

async function voucher(companyId: number, lines: Line[], voucherDate: string) {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, 'Journal', $3, 0, 'USD') RETURNING id`,
      [companyId, `${PREFIX}-${sequence}`, voucherDate]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.rows[0].id, line.ledger ?? null, line.bank ?? null, line.debit, line.credit]
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
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side,
                                  opening_balance_native_amount, opening_balance_currency,
                                  opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $5, 'USD', 1, $5) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} ${code}`, type, opening, side]
  );
}

async function bank(companyId: number, code: string, opening: string, side: string, linkedLedgerId?: number) {
  return insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, linked_ledger_id,
                                opening_balance, opening_balance_side, opening_balance_native_amount,
                                opening_balance_currency, opening_balance_historical_rate, opening_balance_base_amount)
     VALUES ($1, $2, $3, 'Test Bank', '000', $4, $5, $6, $5, 'USD', 1, $5) RETURNING id`,
    [companyId, `${PREFIX}-${code}`, `${PREFIX} bank ${code}`, linkedLedgerId ?? null, opening, side]
  );
}

async function cleanup() {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies WHERE name LIKE $1", [`${PREFIX}%`]);
  for (const { id } of companies.rows) {
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id = $1", [id]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]).catch(() => undefined);
    await pool.query("DELETE FROM bank_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id = $1", [id]);
    await pool.query("DELETE FROM company_settings WHERE company_id = $1", [id]).catch(() => undefined);
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

  const sales = await ledger(erp, "SALES", "Income", "0", "Cr");
  cashLedger = await ledger(erp, "CASH", "Cash", "0", "Dr");
  // A bank with an opening and lines, one after the as-of date.
  bankMain = await bank(erp, "MAIN", "1000", "Dr");
  await voucher(
    erp,
    [
      { bank: bankMain, debit: "250.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "250.00" },
    ],
    "2026-09-02"
  );
  await voucher(
    erp,
    [
      { bank: bankMain, debit: "100.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "100.00" },
    ],
    "2026-10-05"
  );
  // An overdrawn bank: a liability.
  bankOverdrawn = await bank(erp, "OD", "300", "Cr");
  // A bank linked to a Cash ledger: each has its own opening; a bank-only
  // line, a ledger-only line and a line naming both.
  linkedLedger = await ledger(erp, "LINKCASH", "Cash", "500", "Dr");
  bankLinked = await bank(erp, "LINKED", "200", "Dr", linkedLedger);
  await voucher(
    erp,
    [
      { bank: bankLinked, debit: "50.00", credit: "0" },
      { ledger: linkedLedger, debit: "70.00", credit: "0" },
      { ledger: linkedLedger, bank: bankLinked, debit: "30.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "150.00" },
    ],
    "2026-09-03"
  );
  // Cash 40 for a cash line in the same report.
  await voucher(
    erp,
    [
      { ledger: cashLedger, debit: "40.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "40.00" },
    ],
    "2026-09-04"
  );

  // Factory: one bank with an opening and a line.
  const fSales = await ledger(factory, "FSALES", "Income", "0", "Cr");
  factoryBank = await bank(factory, "FBANK", "400", "Dr");
  await voucher(
    factory,
    [
      { bank: factoryBank, debit: "60.00", credit: "0" },
      { ledger: fSales, debit: "0", credit: "60.00" },
    ],
    "2026-09-05"
  );

  registerStatsMultiCurrencyRoutes(fakeApp);
  registerStatsNetProfitRoutes(fakeApp);
  registerStatsNetPositionRoutes(fakeApp);
  registerEmployeeNetPositionRoutes(fakeApp);
}, 120_000);

afterAll(async () => {
  await cleanup();
});

const byName = (accounts: Array<{ name: string; value: number }>, name: string) =>
  accounts.filter((account) => account.name === name);

describe("the engine's bank rows", () => {
  it("hold the bank's opening and its bank-only lines; a line naming a ledger stays on the ledger", async () => {
    const result = await getPartyBalances(db, { companyId: erp, kind: "bank", asOf: AS_OF });
    const closing = Object.fromEntries(result.parties.map((party) => [party.id, party.historicalBaseClosing]));
    expect(closing[bankMain]).toBe("1250.00");
    expect(closing[bankOverdrawn]).toBe("-300.00");
    expect(closing[bankLinked]).toBe("250.00");
    const ledgerRows = await getPartyBalances(db, { companyId: erp, kind: "ledger", ids: [linkedLedger], asOf: AS_OF });
    expect(ledgerRows.parties[0].historicalBaseClosing).toBe("600.00");
  });
});

describe("banks in every dated net position", () => {
  it("live net position with a date", async () => {
    const { statusCode, body } = await call("GET /api/stats/net-profit", {
      session: { currentCompanyId: erp },
      query: { toDate: AS_OF },
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(byName(body.forUs.accounts, `${PREFIX} bank MAIN`)).toEqual([
      expect.objectContaining({ value: 1250, category: "Bank", bankAccountId: bankMain }),
    ]);
    expect(byName(body.onUs.accounts, `${PREFIX} bank OD`)).toEqual([
      expect.objectContaining({ value: 300, category: "Bank", bankAccountId: bankOverdrawn }),
    ]);
    // Linked bank and its ledger: 250 + 600, each once.
    expect(byName(body.forUs.accounts, `${PREFIX} bank LINKED`)).toEqual([expect.objectContaining({ value: 250 })]);
    expect(byName(body.forUs.accounts, `${PREFIX} LINKCASH`)).toEqual([expect.objectContaining({ value: 600 })]);
    // Cash 40 + banks 1250 + 250 + linked ledger 600; overdraft 300.
    expect(body.forUsTotal).toBe(2140);
    expect(body.onUsTotal).toBe(300);
    expect(body.forUs.breakdown).toEqual(expect.arrayContaining([{ name: "Bank", value: 1500 }]));
    expect(body.netPosition).toBe(1840);
  });

  it("the net position Excel export", async () => {
    const { ended, body } = await call("GET /api/stats/net-position-excel", {
      session: { currentCompanyId: erp, userId: "0", username: "wave10" },
      query: { toDate: AS_OF },
    });
    expect(body).toBeUndefined();
    expect(ended).toBeInstanceOf(Buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(ended!);
    const cells = (sheet: string) => {
      const rows: unknown[][] = [];
      workbook.getWorksheet(sheet)!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
      return rows;
    };
    const assets = cells("What We Have (Assets)");
    const liabilities = cells("What We Owe (Liabilities)");
    const find = (rows: unknown[][], name: string) => rows.filter((row) => row.includes(name));
    expect(find(assets, `${PREFIX} bank MAIN`)).toHaveLength(1);
    expect(find(assets, `${PREFIX} bank MAIN`)[0]).toContain(1250);
    expect(find(assets, `${PREFIX} bank LINKED`)[0]).toContain(250);
    expect(find(assets, `${PREFIX} LINKCASH`)[0]).toContain(600);
    expect(find(liabilities, `${PREFIX} bank OD`)[0]).toContain(300);
    expect(find(assets, "TOTAL")[0]).toContain(2140);
  });

  it("the dated snapshot (monthly Excel, schedulers, WhatsApp)", async () => {
    const snapshot = await calculateNetPositionAsOf(erp, AS_OF);
    expect(snapshot.forUsLines.filter((line) => line.label === `${PREFIX} bank MAIN`)).toEqual([
      expect.objectContaining({ value: 1250, category: "Bank" }),
    ]);
    expect(snapshot.forUsLines.filter((line) => line.label === `${PREFIX} bank LINKED`)).toEqual([
      expect.objectContaining({ value: 250 }),
    ]);
    expect(snapshot.forUsLines.filter((line) => line.label === `${PREFIX} LINKCASH`)).toEqual([
      expect.objectContaining({ value: 600 }),
    ]);
    expect(snapshot.onUsLines.filter((line) => line.label === `${PREFIX} bank OD`)).toEqual([
      expect.objectContaining({ value: 300, category: "Bank" }),
    ]);
    expect(snapshot.forUsTotal).toBe(2140);
    expect(snapshot.onUsTotal).toBe(300);
  });

  it("the factory net position", async () => {
    const { statusCode, body } = await call("GET /api/factory/net-position", {
      session: { factoryCompanyId: factory, currentCompanyId: factory },
      query: { asOf: AS_OF },
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(byName(body.forUs.accounts, `${PREFIX} bank FBANK`)).toEqual([
      expect.objectContaining({ value: 460, category: "Bank", bankAccountId: factoryBank }),
    ]);
    expect(body.bankAssets).toBe(460);
    expect(body.bankOverdrafts).toBe(0);
    expect(body.forUs.breakdown).toEqual(expect.arrayContaining([{ name: "Bank", value: 460 }]));
    const accountsTotal = body.forUs.accounts.reduce((sum: number, a: { value: number }) => sum + a.value, 0);
    expect(body.forUsTotal).toBeCloseTo(accountsTotal, 2);
  });
});

describe("the live net position without a date", () => {
  it("translates each bank once, the linked bank and its ledger separately", async () => {
    const { statusCode, body } = await call("GET /api/stats/net-profit", {
      session: { currentCompanyId: erp },
      query: {},
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(body.currency.currentCashBankTranslationApplied).toBe(true);
    // Everything posted: the main bank includes the October line.
    expect(byName(body.forUs.accounts, `${PREFIX} bank MAIN`)).toEqual([
      expect.objectContaining({ value: 1350, bankAccountId: bankMain, currencyRevalued: true }),
    ]);
    expect(byName(body.onUs.accounts, `${PREFIX} bank OD`)).toEqual([
      expect.objectContaining({ value: 300, bankAccountId: bankOverdrawn }),
    ]);
    // The linked bank keeps its own row (its opening and bank-only line), and
    // the line naming both stays on the ledger only.
    expect(byName(body.forUs.accounts, `${PREFIX} bank LINKED`)).toEqual([expect.objectContaining({ value: 250 })]);
    expect(byName(body.forUs.accounts, `${PREFIX} LINKCASH`)).toEqual([expect.objectContaining({ value: 600 })]);
    expect(body.forUsTotal).toBe(2240);
    expect(body.onUsTotal).toBe(300);
    expect(body.currencyRevaluation.currentTranslatedBankAccountIds).toEqual(
      expect.arrayContaining([bankMain, bankOverdrawn, bankLinked])
    );
  });
});

describe("group net position", () => {
  it.each([
    ["dated", false, 2140],
    ["current", true, 2240],
  ])("includes each bank once (%s)", async (_label, current, forUs) => {
    const result = await calculateGroupNetPosition(AS_OF, new Set([erp]), current as boolean);
    expect(result.companies).toHaveLength(1);
    const company = result.companies[0];
    const banks = company.forUsLines.filter((line) => line.label.startsWith(`${PREFIX} bank`));
    expect(banks.map((line) => line.label).sort()).toEqual([`${PREFIX} bank LINKED`, `${PREFIX} bank MAIN`]);
    expect(company.onUsLines.filter((line) => line.label === `${PREFIX} bank OD`)).toHaveLength(1);
    expect(company.forUsTotal).toBe(forUs);
    expect(company.onUsTotal).toBe(300);
  });
});
