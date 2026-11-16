/**
 * Accounting audit wave 14 (B): factory and supplier leftovers.
 *
 *   - commission held on a raw-stock row (an opening-balance entry) posts
 *     FACTORY-COMM-{container} in the same transaction, is replaced on an
 *     edit and removed with the row; a legacy row, and an offload commission
 *     record its container does not carry, are listed by the integrity
 *     diagnostic and the factory-supplier memo; a container's own commission
 *     is never posted twice (the raw-stock amount beside it is listed only);
 *   - a voided factory POS sale removes its customer_balances SALE/DEPOSIT
 *     rows in the void transaction;
 *   - the unified supplier ledger and the historical supplier reference
 *     statement are the engine's (owned lines, the opening with its side in
 *     the supplier's own company) and never read the global parent setting;
 *   - the import-cycle supplier balance and /api/accounts/all follow the
 *     posting-company rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { db, pool } from "../server/db";
import { storage } from "../server/storage";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { loadPartyMemoLines } from "../server/services/accounting/balances/unpostedMemo";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { syncContainerCommissionJournalTx } from "../server/services/factory/containerCommissionJournal";
import { getSupplierBalanceForContext } from "../server/routes/helpers/supplierBalanceHelpers";
import { buildUnifiedSupplierLedger } from "../server/routes/vouchers/unifiedSupplierLedger";
import { registerRawStockOpeningBalanceRoutes } from "../server/routes/factory/raw-stock/opening-balance/crud";
import { registerPosSaleWriteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-write";
import { registerPosSaleDeleteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-delete";
import { registerHistoricalSupplierReferenceRoutes } from "../server/routes/accounts/historicalSupplierReferenceRoutes";
import { registerImportCycleBalanceRoutes } from "../server/routes/import-cycle/balance";
import { serveAccountListForCompany } from "../server/routes/accounts/all";

const PREFIX = "w14b";
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

let factoryId: number;
let parentId: number;
let childId: number;
let requestSeq = 0;

async function call(route: string, req: Record<string, any>, companyId = factoryId) {
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
    session: { factoryCompanyId: companyId, currentCompanyId: companyId, ...(req.session ?? {}) },
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

async function commissionJournal(containerId: number) {
  const header = await one<{ id: number; currency: string }>(
    `SELECT id, currency FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
    [factoryId, `FACTORY-COMM-${containerId}`]
  );
  if (!header) return null;
  const lines = await all<{ code: string | null; supplier: number | null; d: string; c: string }>(
    `SELECT la.code, ve.factory_supplier_id AS supplier,
            ve.debit_amount::numeric(20,2)::text AS d, ve.credit_amount::numeric(20,2)::text AS c
       FROM voucher_entries ve LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY ve.id`,
    [header.id]
  );
  return { ...header, lines };
}

const commissionVouchers = async (containerId: number) =>
  all(`SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`, [
    factoryId,
    `FACTORY-COMM-${containerId}%`,
  ]);

async function factoryMemo(supplierId: number) {
  return (
    (await loadPartyMemoLines(db, { companyId: factoryId, kind: "factorySupplier", ids: [supplierId] })).get(
      supplierId
    ) ?? []
  );
}

async function outsideJournalCheck() {
  const report = await runAccountingIntegrityDiagnostic(factoryId);
  return report.checks.find((c) => c.key === "factory_commission_outside_container_journal")!;
}

async function cleanup(id: number) {
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
    const q = (text: string) => client.query(text, [id]);
    await q(`DELETE FROM accounting_posting_requests WHERE company_id = $1`);
    await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`);
    await q(`DELETE FROM vouchers WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_bales WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_items WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sales WHERE company_id = $1`);
    for (const table of [
      "customer_balances",
      "factory_raw_stock",
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
    await q(`UPDATE factory_suppliers SET parent_id = NULL WHERE company_id = $1`);
    await q(`DELETE FROM factory_suppliers WHERE company_id = $1`);
    // Lines another test company posted to these suppliers.
    await q(`DELETE FROM voucher_entries WHERE supplier_id IN (SELECT id FROM suppliers WHERE company_id = $1)`);
    await q(`DELETE FROM suppliers WHERE company_id = $1`);
    await q(`UPDATE customers SET ledger_account_id = NULL WHERE company_id = $1`);
    await q(`DELETE FROM customers WHERE company_id = $1`);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`);
    await q(`UPDATE companies SET parent_company_id = NULL WHERE parent_company_id = $1`);
    await q(`DELETE FROM companies WHERE id = $1`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const companyCodes = ["FAC", "PAR", "CHD"].map((suffix) => `${PREFIX.toUpperCase()}-${suffix}`);

beforeAll(async () => {
  await ensureFactoryCostBasisSchema(pool);
  for (const leftover of await all<{ id: number }>(`SELECT id FROM companies WHERE code = ANY($1) ORDER BY id DESC`, [
    companyCodes,
  ])) {
    await cleanup(leftover.id);
  }
  for (const register of [
    registerRawStockOpeningBalanceRoutes,
    registerPosSaleWriteRoutes,
    registerPosSaleDeleteRoutes,
    registerHistoricalSupplierReferenceRoutes,
    registerImportCycleBalanceRoutes,
  ]) {
    register(fakeApp);
  }
  const company = async (code: string, type: string, parent: number | null = null) =>
    (
      await one(
        `INSERT INTO companies (code, name, company_type, parent_company_id)
         VALUES ($1::varchar, $1::text, $2, $3) RETURNING id`,
        [code, type, parent]
      )
    ).id as number;
  factoryId = await company(companyCodes[0], "factory");
  parentId = await company(companyCodes[1], "erp");
  childId = await company(companyCodes[2], "erp", parentId);
}, 60000);

afterAll(async () => {
  for (const id of [childId, parentId, factoryId]) if (id) await cleanup(id);
}, 60000);

describe("commission held on raw-stock rows", () => {
  it("posts the opening-balance commission, replaces it on an edit and removes it with the row", async () => {
    const created = await call("POST /api/factory/raw-stock/opening-balance", {
      body: {
        supplierName: `${PREFIX} OB supplier`,
        receivedKg: "1000",
        costPerKg: "2",
        currencyCode: "USD",
        commissionAmount: "300",
        commissionCurrencyCode: "USD",
      },
    });
    expect({ statusCode: created.statusCode, message: created.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    const containerId = created.body.container.id as number;
    const rawStockId = created.body.rawStock.id as number;
    const commissionSupplierId = created.body.rawStock.commissionSupplierId as number;
    expect(commissionSupplierId).toBeGreaterThan(0);

    const posted = await commissionJournal(containerId);
    expect(posted!.lines.map((l) => [l.code, l.supplier, l.d, l.c])).toEqual([
      ["FACTORY_IMPORT_COST", null, "300.00", "0.00"],
      [null, commissionSupplierId, "0.00", "300.00"],
    ]);
    // The ledger carries it, so neither the memo nor the diagnostic lists it.
    expect((await factoryMemo(commissionSupplierId)).filter((l) => l.sourceId === rawStockId)).toEqual([]);
    expect((await outsideJournalCheck()).samples.filter((s) => s.container_id === containerId)).toEqual([]);

    const edited = await call("PATCH /api/factory/raw-stock/opening-balance/:id", {
      params: { id: String(rawStockId) },
      body: { commissionAmount: "450" },
    });
    expect(edited.statusCode).toBe(200);
    expect(await commissionVouchers(containerId)).toHaveLength(1);
    expect((await commissionJournal(containerId))!.lines.map((l) => l.c)).toEqual(["0.00", "450.00"]);

    const deleted = await call("DELETE /api/factory/raw-stock/opening-balance/:id", {
      params: { id: String(rawStockId) },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await commissionVouchers(containerId)).toHaveLength(0);
  });

  it("posts a foreign-currency opening-balance commission at its own stored rate", async () => {
    const created = await call("POST /api/factory/raw-stock/opening-balance", {
      body: {
        supplierName: `${PREFIX} OB supplier EUR`,
        receivedKg: "100",
        costPerKg: "1",
        currencyCode: "USD",
        commissionAmount: "100",
        commissionCurrencyCode: "EUR",
        commissionFxRateToUsd: "1.1",
      },
    });
    expect(created.statusCode).toBe(200);
    const posted = await commissionJournal(created.body.container.id);
    expect(posted?.currency).toBe("EUR");
    expect(posted!.lines.map((l) => [l.d, l.c])).toEqual([
      ["110.00", "0.00"],
      ["0.00", "110.00"],
    ]);
  });

  it("lists a legacy raw-stock commission (no journal) in the diagnostic and the memo, not back-filled", async () => {
    const supplier = await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      factoryId,
      `${PREFIX} legacy broker`,
    ]);
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id,
                                       status, arrival_date)
       VALUES ($1, $2, 'USD', 1, $3, 'OPENING_BALANCE', '2026-02-01') RETURNING id`,
      [factoryId, `${PREFIX}-LEGACY-OB`, supplier.id]
    );
    const raw = await one(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, cost_per_kg, cost_per_kg_usd,
                                      commission_amount, commission_currency_code, commission_supplier_id)
       VALUES ($1, $2, 10, 1, 1, 75, 'USD', $3) RETURNING id`,
      [factoryId, container.id, supplier.id]
    );
    expect(await commissionVouchers(container.id)).toHaveLength(0);
    const listed = (await outsideJournalCheck()).samples.filter((s) => s.container_id === container.id);
    expect(listed.map((s) => [s.source, s.id, s.amount, s.reason])).toEqual([
      ["rawStock", raw.id, "75.0000", "no-journal"],
    ]);
    const memo = (await factoryMemo(supplier.id)).filter((l) => l.source === "factoryRawStockCommission");
    expect(memo.map((l) => [l.sourceId, l.amount])).toEqual([[raw.id, "-75.00"]]);

    // Writing the commission (here: the journal sync every writer calls) brings it into the ledger.
    await db.transaction((tx) => syncContainerCommissionJournalTx(tx, factoryId, container.id));
    expect((await commissionJournal(container.id))!.lines.map((l) => l.c)).toEqual(["0.00", "75.00"]);
    expect((await factoryMemo(supplier.id)).filter((l) => l.source === "factoryRawStockCommission")).toEqual([]);
  });

  it("never posts a container's commission twice: its own commission wins, the raw-stock amount is listed", async () => {
    const supplier = await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      factoryId,
      `${PREFIX} double`,
    ]);
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id,
                                       commission_amount, commission_currency_code, arrival_date)
       VALUES ($1, $2, 'USD', 1, $3, 500, 'USD', '2026-03-01') RETURNING id`,
      [factoryId, `${PREFIX}-DOUBLE`, supplier.id]
    );
    await pool.query(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, cost_per_kg, cost_per_kg_usd,
                                      commission_amount, commission_currency_code)
       VALUES ($1, $2, 10, 1, 1, 200, 'USD')`,
      [factoryId, container.id]
    );
    // The offload's record of the same commission: carried by the container.
    await pool.query(
      `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate,
                                                  commission_total, currency_code, fx_rate_to_usd, fx_rate_confirmed)
       VALUES ($1, $2, 'Broker', 500, 500, 'USD', 1, true)`,
      [factoryId, container.id]
    );
    const result = await db.transaction((tx) => syncContainerCommissionJournalTx(tx, factoryId, container.id));
    expect(result.source).toBe("container");
    expect(await commissionVouchers(container.id)).toHaveLength(1);
    const credited = await one<{ c: string }>(
      `SELECT COALESCE(SUM(ve.credit_amount), 0)::numeric(20,2)::text AS c
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id = $1 AND ve.factory_supplier_id = $2 AND v.deleted_at IS NULL`,
      [factoryId, supplier.id]
    );
    expect(credited.c).toBe("500.00");

    const listed = (await outsideJournalCheck()).samples.filter((s) => s.container_id === container.id);
    expect(listed.map((s) => [s.source, s.reason])).toEqual([["rawStock", "container-has-own-commission"]]);
    // The memo lists nothing for it: the container's commission is in the ledger.
    expect((await factoryMemo(supplier.id)).filter((l) => l.sourceId === container.id)).toEqual([]);
    expect(
      (await factoryMemo(supplier.id)).filter((l) =>
        ["factoryRawStockCommission", "factoryCommissionRecord"].includes(l.source)
      )
    ).toEqual([]);
  });

  it("lists an offload commission record its container does not carry", async () => {
    const supplier = await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      factoryId,
      `${PREFIX} record`,
    ]);
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id,
                                       arrival_date)
       VALUES ($1, $2, 'USD', 1, $3, '2026-04-01') RETURNING id`,
      [factoryId, `${PREFIX}-RECORD`, supplier.id]
    );
    const record = await one(
      `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate,
                                                  commission_total, currency_code, fx_rate_to_usd, fx_rate_confirmed)
       VALUES ($1, $2, 'Broker', 0.1, 120, 'USD', 1, true) RETURNING id`,
      [factoryId, container.id]
    );
    const result = await db.transaction((tx) => syncContainerCommissionJournalTx(tx, factoryId, container.id));
    expect(result).toMatchObject({ voucherId: null, skipped: "no-commission" });
    const listed = (await outsideJournalCheck()).samples.filter((s) => s.container_id === container.id);
    expect(listed.map((s) => [s.source, s.reason])).toEqual([["commissionRecord", "container-has-no-commission"]]);
    const memo = (await factoryMemo(supplier.id)).filter((l) => l.source === "factoryCommissionRecord");
    expect(memo.map((l) => [l.sourceId, l.amount])).toEqual([[record.id, "-120.00"]]);
  });
});

describe("factory POS void", () => {
  it("removes the sale's customer_balances SALE/DEPOSIT rows with the void", async () => {
    const customer = await one(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
      [factoryId, `${PREFIX}-CUST`]
    );
    const cash = await one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Cash')
       RETURNING id`,
      [factoryId, `${PREFIX}-CASH`]
    );
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        txDate: "2026-05-02",
        currencyCode: "USD",
        cashAccountId: cash.id,
        customerId: customer.id,
        paymentType: "CREDIT",
        depositAmount: "40",
        items: [{ productName: "Loose bale", quantity: 1, unitPrice: "100" }],
      },
    });
    expect({ statusCode: sale.statusCode, message: sale.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    const rows = () =>
      all(`SELECT reference_type FROM customer_balances WHERE company_id = $1 AND reference_id = $2 ORDER BY id`, [
        factoryId,
        sale.body.id,
      ]);
    expect((await rows()).map((r) => r.reference_type)).toEqual(["FACTORY_POS_SALE", "FACTORY_POS_DEPOSIT"]);

    const voided = await call("DELETE /api/factory/pos/sales/:id", { params: { id: String(sale.body.id) } });
    expect(voided.statusCode).toBe(200);
    expect(await rows()).toEqual([]);
    const memo = (await loadPartyMemoLines(db, { companyId: factoryId, kind: "customer", ids: [customer.id] })).get(
      customer.id
    );
    expect(memo ?? []).toEqual([]);
  });
});

describe("ERP suppliers on the posting-company rule", () => {
  let ownSupplier: number;
  let idleSupplier: number;
  let parentSupplier: number;

  beforeAll(async () => {
    const supplier = async (companyId: number, code: string, opening: string) =>
      (
        await one(
          `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side, active)
           VALUES ($1, $2::varchar, $2::text, $3, $4, 'Cr', true) RETURNING id`,
          [companyId, `${PREFIX}-${code}`, `${PREFIX}-${code.toLowerCase()}@wave14.test`, opening]
        )
      ).id as number;
    ownSupplier = await supplier(childId, "OWN", "100");
    idleSupplier = await supplier(childId, "IDLE", "0");
    parentSupplier = await supplier(parentId, "PAR", "0");
    const account = async (companyId: number, code: string, type: string) =>
      (
        await one(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type)
           VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
          [companyId, `${PREFIX}-${code}`, type]
        )
      ).id as number;
    const childExpense = await account(childId, "C-EXP", "Expense");
    const childPayable = await account(childId, "C-PAY", "Liability");
    const parentExpense = await account(parentId, "P-EXP", "Expense");

    const post = async (
      companyId: number,
      number: string,
      date: string,
      amount: string,
      debitAccount: number,
      credit: { ledger?: number; supplier: number }
    ) =>
      withFixtureTransaction(async (client) => {
        const header = await client.query(
          `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency,
                                 exchange_rate)
           VALUES ($1, 'Journal', $2, $3, $4, 'USD', 1) RETURNING id`,
          [companyId, `${PREFIX}-${number}`, date, amount]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
           VALUES ($1, $2, $3, 0)`,
          [header.rows[0].id, debitAccount, amount]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount)
           VALUES ($1, $2, $3, 0, $4)`,
          [header.rows[0].id, credit.ledger ?? null, credit.supplier, amount]
        );
      });
    // The supplier's own line in its company.
    await post(childId, "V1", "2026-09-10", "40", childExpense, { supplier: ownSupplier });
    // A supplier-tagged line on a payable ledger: the ledger account's line.
    await post(childId, "V2", "2026-09-11", "30", childExpense, { ledger: childPayable, supplier: ownSupplier });
    // The parent posting to the child's supplier: the parent's payable.
    await post(parentId, "V3", "2026-09-12", "20", parentExpense, { supplier: ownSupplier });
    // The child posting to the parent's supplier: the child's payable.
    await post(childId, "V4", "2026-09-13", "50", childExpense, { supplier: parentSupplier });
  }, 60000);

  const withGlobalParent = async <T>(value: number, work: () => Promise<T>) => {
    const spy = vi.spyOn(storage, "getParentCompanyId").mockResolvedValue(value);
    try {
      const result = await work();
      expect(spy).not.toHaveBeenCalled();
      return result;
    } finally {
      spy.mockRestore();
    }
  };

  it("unified ledger: the engine's lines and opening per company, whatever the global parent setting", async () => {
    const engine = await getSupplierBalanceForContext((await storage.getSupplierById(ownSupplier))!, childId);
    expect(engine.balance).toBe(140);
    for (const globalParent of [parentId, childId]) {
      const rows = await withGlobalParent(globalParent, () =>
        buildUnifiedSupplierLedger({ supplierId: ownSupplier, companyIds: [childId] })
      );
      expect(rows.map((r) => [r.type, r.docNumber, r.credit, r.balance])).toEqual([
        ["opening", "-", 0, 100],
        ["voucher", `${PREFIX}-V1`, 40, 140],
      ]);
      expect(rows.at(-1)!.balance).toBe(engine.balance);
    }
    // With a start date the opening carries the earlier lines (the engine's period opening).
    const later = await buildUnifiedSupplierLedger({
      supplierId: ownSupplier,
      companyIds: [childId],
      startDate: "2026-09-11",
    });
    expect(later.map((r) => [r.type, r.balance])).toEqual([["opening", 140]]);
    // The parent's view: its own posting only, no opening (the supplier is the child's).
    const parentRows = await buildUnifiedSupplierLedger({ supplierId: ownSupplier, companyIds: [parentId] });
    expect(parentRows.map((r) => [r.type, r.docNumber, r.balance])).toEqual([["voucher", `${PREFIX}-V3`, 20]]);
  });

  it("historical supplier reference statement: owned lines, the opening with its side, no global setting", async () => {
    for (const globalParent of [parentId, childId]) {
      const statement = await withGlobalParent(globalParent, () =>
        call(
          "GET /api/accounts/supplier/:id/transactions",
          { params: { id: String(ownSupplier) }, query: { startDate: "2026-09-11" } },
          childId
        )
      );
      expect(statement.statusCode).toBe(200);
      // V1 is before the start; V2 is the payable ledger's line, not the supplier's.
      expect(statement.body.transactions).toEqual([]);
      expect(statement.body).toMatchObject({
        openingBalance: 100,
        openingBalanceSide: "Cr",
        periodOpeningBalance: 140,
        preNetBalance: -40,
      });
    }
    const whole = await call(
      "GET /api/accounts/supplier/:id/transactions",
      { params: { id: String(ownSupplier) } },
      childId
    );
    expect(whole.body.transactions.map((t: { voucherNumber: string }) => t.voucherNumber)).toEqual([`${PREFIX}-V1`]);
  });

  it("import-cycle supplier balance is the engine's suppliers of the posting company", async () => {
    const result = await withGlobalParent(parentId, () =>
      call("GET /api/stats/import-cycle-balance", { session: { currentCompanyId: childId } }, childId)
    );
    expect(result.statusCode).toBe(200);
    const parties = (await getPartyBalances(db, { companyId: childId, kind: "supplier" })).parties;
    const owed = parties.reduce((sum, party) => sum - Number(party.closing), 0);
    // Own supplier 100 opening + 40; the parent's supplier 50 posted here. The
    // global setting naming another company used to give 0.
    expect(owed).toBe(190);
    const find = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return undefined;
      if ("supplierBalance" in (value as Record<string, unknown>))
        return (value as Record<string, unknown>).supplierBalance;
      for (const child of Object.values(value as Record<string, unknown>)) {
        const found = find(child);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    expect(find(result.body)).toBe(190);
  });

  it("accounts/all lists a child company's idle suppliers and the suppliers it posted to", async () => {
    let body: { accounts: Array<Record<string, any>> } = { accounts: [] };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await withGlobalParent(parentId, () =>
      serveAccountListForCompany({ query: {}, headers: { "x-client-date": today } } as never, res as never, childId)
    );
    const suppliers = body.accounts.filter((a) => a.type === "supplier");
    const byId = new Map(suppliers.map((a) => [a.accountId, a]));
    expect(byId.get(ownSupplier)).toMatchObject({ balance: "140.00", openingBalance: 100, openingBalanceSide: "Cr" });
    // A child's supplier with no lines and no opening used to be hidden.
    expect(byId.get(idleSupplier)).toMatchObject({ balance: "0.00" });
    expect(byId.get(parentSupplier)).toMatchObject({ balance: "50.00", postedFromOtherCompany: true });
  });
});
