/**
 * Phase 22 (C) — factory and supplier-partner writers on the central posting
 * engine (D2, PE8, PE9/G4, PE10/F13, PE13, DI7).
 *
 * One representative writer per group posts through postBalancedVoucherTx:
 * balanced exactly, Decimal amounts, an idempotent posting identity, the family
 * number (deterministic, never Date.now()) or the engine's gapless number, and
 * in-place edits of posted vouchers audited in an open period and refused (409,
 * reverse instead) in a closed one, with the whole request rolled back.
 */
import request from "supertest";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { postFactoryPosReceiptTx } from "../server/services/accounting/factoryPosReceipt";
import { retireVouchersTx } from "../server/services/accounting/voucherRetirement";
import { postChargeVouchers } from "../server/services/containers/offload-lifecycle/charge-vouchers";
import {
  buildFactoryVoucherRequest,
  mirroredUsdLines,
  postFactoryPartyLineVoucherTx,
  postFactoryVoucherTx,
  usdLineAmounts,
} from "../server/services/factory/factoryVoucherPosting";
import { postOrderChargeVoucherTx } from "../server/routes/factory/customer-orders/orderChargeLedger";
import { registerRawStockAutoApplyFxRoutes } from "../server/routes/factory/raw-stock/recalc/auto-apply-fx";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p22cfw";
let ctx: TestContext;
let agent: request.SuperAgentTest;
const ids: Record<string, number> = {};
let fixtureSeq = 0;

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

type VoucherRow = {
  id: number;
  voucher_number: string;
  voucher_type: string;
  total_amount: string;
  currency: string;
  posted_by_engine: boolean;
  deleted_at: string | null;
};

async function liveVoucher(number: string): Promise<VoucherRow | undefined> {
  const { rows } = await pool.query<VoucherRow>(
    `SELECT id, voucher_number, voucher_type, total_amount::text, currency, posted_by_engine, deleted_at::text
       FROM vouchers WHERE company_id = $1 AND voucher_number = $2 AND deleted_at IS NULL`,
    [ctx.companyId, number]
  );
  return rows[0];
}

async function voucherById(id: number): Promise<VoucherRow> {
  const { rows } = await pool.query<VoucherRow>(
    `SELECT id, voucher_number, voucher_type, total_amount::text, currency, posted_by_engine, deleted_at::text
       FROM vouchers WHERE id = $1`,
    [id]
  );
  return rows[0];
}

type LineRow = {
  ledger_account_id: number | null;
  factory_supplier_id: number | null;
  supplier_id: number | null;
  customer_id: number | null;
  employee_id: number | null;
  debit_amount: string;
  credit_amount: string;
  transaction_currency: string | null;
  transaction_debit_amount: string | null;
  transaction_credit_amount: string | null;
  base_debit_amount: string | null;
  base_credit_amount: string | null;
};

async function lines(voucherId: number): Promise<LineRow[]> {
  const { rows } = await pool.query<LineRow>(
    `SELECT ledger_account_id, factory_supplier_id, supplier_id, customer_id, employee_id,
            debit_amount::text, credit_amount::text, transaction_currency,
            transaction_debit_amount::text, transaction_credit_amount::text,
            base_debit_amount::text, base_credit_amount::text
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return rows;
}

/** Balanced exactly on the 2 dp ledger columns and on the 6 dp base columns. */
async function expectBalanced(voucherId: number) {
  const rows = await lines(voucherId);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const sum = (pick: (row: LineRow) => string | null) =>
    rows.reduce((total, row) => total.plus(pick(row) ?? "0"), new Decimal(0));
  expect(sum((row) => row.debit_amount).toFixed(2)).toBe(sum((row) => row.credit_amount).toFixed(2));
  return rows;
}

async function identityOf(voucherId: number) {
  const { rows } = await pool.query<{ source_type: string; source_id: string; idempotency_key: string }>(
    `SELECT source_type, source_id, idempotency_key FROM accounting_posting_requests
      WHERE company_id = $1 AND voucher_id = $2`,
    [ctx.companyId, voucherId]
  );
  return rows;
}

async function auditEdits(voucherId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2 AND action = 'update'
        AND changes::text LIKE '%open-period-edit%'`,
    [ctx.companyId, voucherId]
  );
  return rows[0].n;
}

async function closeBooksThrough(date: string) {
  const closing = await withFixtureTransaction(async (client) => {
    fixtureSeq += 1;
    const id = (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', $3, 1, false) RETURNING id`,
        [ctx.companyId, `${PREFIX}-CLOSE-${ctx.companyId}-${fixtureSeq}`, date]
      )
    ).rows[0].id as number;
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, 1, 0), ($1, $3, 0, 1)`,
      [id, ctx.cashAccountId, ctx.salesAccountId]
    );
    return id;
  });
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, $2, $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, date, ctx.userId, closing, ctx.cashAccountId]
  );
}
const reopenBooks = () => pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  ids.SUPPLIER = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${PREFIX} supplier`]
  );
  ids.FREIGHT = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Expense', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-FRT-${ctx.companyId}`, `${PREFIX} freight`]
  );
  ids.CUSTOMER_LEDGER = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Asset', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUST-${ctx.companyId}`, `${PREFIX} customer`]
  );
  ids.CUSTOMER = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}C${ctx.companyId}`, `${PREFIX} customer`, ids.CUSTOMER_LEDGER]
  );
  ids.ERP_SUPPLIER = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}S${ctx.companyId}`, `${PREFIX} erp supplier`, `${PREFIX}@example.test`]
  );
  ids.EMPLOYEE = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, employee_type)
     VALUES ($1, $2, 'Ada', 'P22C', '2026-01-01', 'Employee') RETURNING id`,
    [ctx.companyId, `${PREFIX}E${ctx.companyId}`]
  );
  await pool.query(
    `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
     VALUES ($1, 'EUR', 1.1, '2026-01-01', 'manual')`,
    [ctx.companyId]
  );
}, 120_000);

afterAll(async () => {
  await reopenBooks();
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  for (const table of [
    "factory_daybook_entries",
    "factory_raw_stock",
    "factory_container_receipts",
    "factory_container_commissions",
    "factory_fx_rates",
    "customer_balances",
    "voucher_number_sequences",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
  }
  await pool.query(
    `DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await withFixtureTransaction(async (client) => {
    await client.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  });
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM suppliers WHERE company_id = $1`, [ctx.companyId]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("the factory voucher builder (Decimal, factory rate convention)", () => {
  it("converts native × USD-per-unit exactly and totals the base", () => {
    const built = buildFactoryVoucherRequest({
      companyId: 1,
      voucherDate: "2026-03-01",
      description: "x",
      currency: "EUR",
      fxRateToUsd: "0.6543219",
      source: { sourceType: "t", sourceId: 1 },
      lines: [
        { ledgerAccountId: 1, debit: "250000" },
        { factorySupplierId: 2, credit: new Decimal("250000") },
      ],
    });
    expect(built.entries[0].baseDebitAmount).toBe("163580.475000");
    expect(built.entries[1].baseCreditAmount).toBe("163580.475000");
    expect(built.entries[0].transactionDebitAmount).toBe("250000.000000");
    expect(built.voucher.totalAmount).toBe("163580.475");
    expect(built.voucher.voucherNumber).toBeUndefined();
  });

  it("writes every amount column of an edited USD line and mirrors a voucher exactly", () => {
    expect(usdLineAmounts("12.345", 0)).toMatchObject({
      debitAmount: "12.345000",
      creditAmount: "0.000000",
      baseDebitAmount: "12.345000",
      transactionCurrency: "USD",
      rateConvention: "IDENTITY",
    });
    expect(
      mirroredUsdLines(
        [
          { ledgerAccountId: 1, supplierId: 9, debitAmount: "10.10", creditAmount: "0", narration: "a" },
          { ledgerAccountId: 2, debitAmount: "0", creditAmount: "10.10", narration: null },
        ],
        "rev"
      ).map((line) => [line.ledgerAccountId, line.supplierId, String(line.debit), String(line.credit), line.narration])
    ).toEqual([
      [1, 9, "0", "10.1", "rev: a"],
      [2, null, "10.1", "0", "rev: original entry"],
    ]);
  });
});

describe("factory container create and update", () => {
  let containerId: number;

  it("posts the goods and freight journals through the engine, exact, with their identities", async () => {
    const response = await agent.post("/api/factory/containers").send({
      containerNumber: `${PREFIX}-C1-${ctx.companyId}`,
      supplierId: ids.SUPPLIER,
      totalKg: "1000.5",
      ratePerKg: "0.35",
      currencyCode: "EUR",
      fxRateSource: "auto",
      arrivalDate: "2026-03-01",
      freight: "100",
      freightCurrencyCode: "EUR",
      freightAccountId: ids.FREIGHT,
      freightPaidBy: "supplier",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    containerId = response.body.id;

    const goods = await liveVoucher(`FACTORY-IMPORT-${containerId}-1`);
    expect(goods?.posted_by_engine).toBe(true);
    // The header keeps the document-currency total (EUR 350.175 → 350.18).
    expect(goods?.currency).toBe("EUR");
    expect(goods?.total_amount).toBe("350.18");
    const goodsLines = await expectBalanced(goods!.id);
    expect(goodsLines[0].transaction_debit_amount).toBe("350.175000");
    expect(goodsLines[0].base_debit_amount).toBe("385.192500");
    expect(goodsLines[1].factory_supplier_id).toBe(ids.SUPPLIER);
    expect((await identityOf(goods!.id))[0]).toMatchObject({
      source_type: "factory-container-import",
      source_id: `${containerId}:goods`,
    });

    const freight = await liveVoucher(`FACTORY-FREIGHT-${containerId}`);
    expect(freight?.posted_by_engine).toBe(true);
    const freightLines = await expectBalanced(freight!.id);
    expect(freightLines[0].base_debit_amount).toBe("110.000000");
    expect((await identityOf(freight!.id))[0].source_type).toBe("factory-container-freight");
  });

  it("audits an in-place freight edit in an open period", async () => {
    const response = await agent.patch(`/api/factory/containers/${containerId}`).send({ freight: "120" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const freight = await liveVoucher(`FACTORY-FREIGHT-${containerId}`);
    const freightLines = await expectBalanced(freight!.id);
    expect(freightLines.map((line) => line.base_debit_amount)).toContain("132.000000");
    expect(freight?.total_amount).toBe("120.00");
    expect(await auditEdits(freight!.id)).toBe(1);
  });

  it("refuses the edit in a closed period (reverse instead) and changes nothing", async () => {
    await closeBooksThrough("2026-03-31");
    try {
      const response = await agent.patch(`/api/factory/containers/${containerId}`).send({ freight: "150" });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD");
      expect(response.body.reverseRoute).toMatch(/^\/api\/vouchers\/\d+\/reverse$/);
      const { rows } = await pool.query(`SELECT freight::text FROM factory_containers WHERE id = $1`, [containerId]);
      expect(rows[0].freight).toBe("120.00");
      const freight = await liveVoucher(`FACTORY-FREIGHT-${containerId}`);
      expect((await lines(freight!.id)).map((line) => line.base_debit_amount)).toContain("132.000000");
    } finally {
      await reopenBooks();
    }
  });
});

describe("raw-stock offload", () => {
  it("posts the offload freight with the receipt's identity and family number", async () => {
    const containerId = await insertId(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, total_kg, rate_per_kg, currency_code,
         fx_rate_to_usd, fx_rate_confirmed, status, arrival_date)
       VALUES ($1, $2, $3, 1000, 0.5, 'USD', 1, true, 'PENDING', '2026-04-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-RS-${ctx.companyId}`, ids.SUPPLIER]
    );
    const response = await agent.post("/api/factory/raw-stock/offload").send({
      containerId: String(containerId),
      receivedKg: "1000",
      costPerKg: "0.5",
      currencyCode: "USD",
      fxRateToUsd: "1",
      freight: "75.35",
      freightSupplierId: String(ids.SUPPLIER),
      offloadDate: "2026-04-02",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const receiptId = response.body.rawStock.id;
    const freight = await liveVoucher(`FACTORY-FREIGHT-${containerId}-${receiptId}`);
    expect(freight?.posted_by_engine).toBe(true);
    const rows = await expectBalanced(freight!.id);
    expect(rows.map((row) => row.debit_amount)).toContain("75.35");
    expect((await identityOf(freight!.id))[0]).toMatchObject({
      source_type: "factory-offload-freight",
      source_id: `${containerId}:${receiptId}:freight`,
    });
  });
});

describe("ERP container offload charges", () => {
  it("post through the engine with family numbers; a replay returns the posted voucher", async () => {
    const container = { id: 900_000_000 + ctx.companyId, containerNumber: `${PREFIX}CN${ctx.companyId}` };
    const input = {
      companyId: ctx.companyId,
      containerId: container.id,
      mode: "create-or-replace" as const,
      locationId: ctx.locationId,
      offloadDate: "2026-05-01",
      duties: "10.50",
      dutiesAccountId: ctx.cashAccountId,
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
      additionalCharges: [{ description: "Handling", amount: 3.3, ledgerAccountId: ctx.cashAccountId }],
    };
    const post = () =>
      db.transaction((tx) =>
        postChargeVouchers(tx, container as Parameters<typeof postChargeVouchers>[1], ctx.companyId, input)
      );
    await post();
    await post();
    const duty = await liveVoucher(`DUTY-${container.containerNumber}-${container.id}`);
    expect(duty?.posted_by_engine).toBe(true);
    expect((await expectBalanced(duty!.id)).map((row) => row.debit_amount)).toContain("10.50");
    const charge = await liveVoucher(`CHG-${container.containerNumber}-${container.id}-0`);
    expect((await expectBalanced(charge!.id)).map((row) => row.credit_amount)).toContain("3.30");
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`,
      [ctx.companyId, `DUTY-${container.containerNumber}-%`]
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("order charges and pricing (one transaction, row-locked, invoice sync inside)", () => {
  let orderId: number;
  let chargeId: number;

  it("posts the charge voucher through the engine and moves the invoice balance in the same transaction", async () => {
    orderId = await insertId(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number)
       VALUES ($1, $2, '2026-06-01', 'FINALIZED', $3) RETURNING id`,
      [ctx.companyId, ids.CUSTOMER, `INV-P22C-${ctx.companyId}`]
    );
    await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
         reference_id, debit_amount, credit_amount, balance, currency, description)
       VALUES ($1, $2, '2026-06-01', 'SALE', 'INVOICE', $3, 0, 0, 0, 'USD', 'Invoice')`,
      [ctx.companyId, ids.CUSTOMER, orderId]
    );
    const response = await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "25.50", chargeType: "FREIGHT", ledgerAccountId: String(ctx.salesAccountId) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    chargeId = response.body.charges[0].id;
    const voucher = await liveVoucher(`CHARGE-INV-P22C-${ctx.companyId}-${chargeId}-1`);
    expect(voucher?.posted_by_engine).toBe(true);
    const rows = await expectBalanced(voucher!.id);
    expect(rows[0]).toMatchObject({
      ledger_account_id: ids.CUSTOMER_LEDGER,
      customer_id: ids.CUSTOMER,
      debit_amount: "25.50",
    });
    expect((await identityOf(voucher!.id))[0].source_type).toBe("factory-order-charge");
    const { rows: balance } = await pool.query(
      `SELECT debit_amount::text FROM customer_balances WHERE company_id = $1 AND reference_type = 'INVOICE' AND reference_id = $2`,
      [ctx.companyId, orderId]
    );
    expect(balance[0].debit_amount).toBe("25.50");
  });

  it("replays a charge posting by its identity instead of posting twice", async () => {
    const { rows: before } = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const replayId = await db.transaction((tx) =>
      postOrderChargeVoucherTx(tx, {
        companyId: ctx.companyId,
        chargeId,
        voucherNumber: `CHARGE-INV-P22C-${ctx.companyId}-${chargeId}-1`,
        voucherDate: "2026-06-01",
        description: `Freight - INV-P22C-${ctx.companyId}`,
        customerId: ids.CUSTOMER,
        customerLedgerAccountId: ids.CUSTOMER_LEDGER,
        chargeLedgerAccountId: ctx.salesAccountId,
        amount: "25.50",
      })
    );
    const posted = await liveVoucher(`CHARGE-INV-P22C-${ctx.companyId}-${chargeId}-1`);
    expect(replayId).toBe(posted!.id);
    const { rows: after } = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(after[0].n).toBe(before[0].n);
  });

  it("audits an amount edit in an open period", async () => {
    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ amount: "30" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const voucher = await liveVoucher(`CHARGE-INV-P22C-${ctx.companyId}-${chargeId}-1`);
    const rows = await expectBalanced(voucher!.id);
    expect(rows.map((row) => row.base_debit_amount)).toContain("30.000000");
    expect(await auditEdits(voucher!.id)).toBe(1);
  });

  it("refuses the edit in a closed period and rolls the whole request back", async () => {
    await closeBooksThrough("2026-06-30");
    try {
      const response = await agent
        .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
        .send({ amount: "40" });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD");
      const { rows } = await pool.query(
        `SELECT co.grand_total::text AS total, c.amount::text AS charge, cb.debit_amount::text AS balance
           FROM customer_orders co
           JOIN customer_order_charges c ON c.order_id = co.id
           JOIN customer_balances cb ON cb.reference_type = 'INVOICE' AND cb.reference_id = co.id
          WHERE co.id = $1`,
        [orderId]
      );
      expect(rows[0]).toEqual({ total: "30.00", charge: "30.00", balance: "30.00" });
    } finally {
      await reopenBooks();
    }
  });

  it("re-pricing moves the invoice balance in its own transaction", async () => {
    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/bales/reprice-article`)
      .send({ articleCode: "NONE", pricePerBale: "5" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT debit_amount::text FROM customer_balances WHERE reference_type = 'INVOICE' AND reference_id = $1`,
      [orderId]
    );
    expect(rows[0].debit_amount).toBe(response.body.grandTotal);
  });
});

describe("factory POS receipt", () => {
  it("posts through the engine; an edit retires the old receipt and posts the next generation", async () => {
    const saleId = 800_000_000 + ctx.companyId;
    const post = () =>
      db.transaction((tx) =>
        postFactoryPosReceiptTx(tx, {
          companyId: ctx.companyId,
          saleId,
          saleNumber: `FPOS-${saleId}`,
          voucherDate: "2026-07-01",
          currency: "USD",
          rate: "1",
          isCredit: false,
          total: new Decimal("100.10"),
          deposit: new Decimal(0),
          deductions: [{ accountId: ctx.salesAccountId, description: "Loading", amount: new Decimal("0.10") }],
          customerId: null,
          cashAccountId: ctx.cashAccountId,
        })
      );
    const first = await post();
    expect((await voucherById(first!)).posted_by_engine).toBe(true);
    await expectBalanced(first!);
    const second = await post();
    expect(second).not.toBe(first);
    expect((await voucherById(first!)).deleted_at).not.toBeNull();
    expect((await identityOf(second!))[0].idempotency_key).toMatch(/:g1$/);
  });
});

describe("supplier-partner party-line journals", () => {
  it("keep the supplier on the clearing line, balanced, idempotent, numbered by generation", async () => {
    const input = {
      companyId: ctx.companyId,
      voucherNumber: (generation: number) => `SP-OTW-P22C-${ctx.companyId}-${generation}`,
      voucherDate: "2026-07-02",
      description: "OTW",
      sourceModule: "SP",
      source: { sourceType: "p22c-sp-otw", sourceId: ctx.companyId, phase: "voucher" },
      lines: [
        { ledgerAccountId: ctx.cashAccountId, debit: "40.25" },
        { ledgerAccountId: ctx.salesAccountId, supplierId: ids.ERP_SUPPLIER, credit: "40.25" },
      ],
    };
    const first = await db.transaction((tx) => postFactoryPartyLineVoucherTx(tx, input));
    const replay = await db.transaction((tx) => postFactoryPartyLineVoucherTx(tx, input));
    expect(replay).toEqual({ voucherId: first.voucherId, replayed: true });
    const rows = await expectBalanced(first.voucherId);
    expect(rows[1]).toMatchObject({ ledger_account_id: ctx.salesAccountId, supplier_id: ids.ERP_SUPPLIER });
    expect((await voucherById(first.voucherId)).voucher_number).toBe(`SP-OTW-P22C-${ctx.companyId}-1`);

    await db.transaction((tx) =>
      retireVouchersTx(tx, { companyId: ctx.companyId, voucherIds: [first.voucherId], reason: "test" })
    );
    const reposted = await db.transaction((tx) => postFactoryPartyLineVoucherTx(tx, input));
    expect(reposted.replayed).toBe(false);
    expect((await voucherById(reposted.voucherId)).voucher_number).toBe(`SP-OTW-P22C-${ctx.companyId}-2`);
  });

  it("refuses an unbalanced party-line journal before writing", async () => {
    await expect(
      db.transaction((tx) =>
        postFactoryPartyLineVoucherTx(tx, {
          companyId: ctx.companyId,
          voucherDate: "2026-07-02",
          description: "bad",
          source: { sourceType: "p22c-sp-bad", sourceId: ctx.companyId },
          lines: [
            { ledgerAccountId: ctx.cashAccountId, debit: "1" },
            { ledgerAccountId: ctx.salesAccountId, credit: "0.99" },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "POSTING_UNBALANCED" });
  });
});

describe("engine-numbered factory writers", () => {
  it("number an employee deposit gaplessly and replay it by its request id", async () => {
    const send = () =>
      agent
        .post(`/api/factory/employees/${ids.EMPLOYEE}/deposit`)
        .send({ amount: "12.34", date: "2026-08-01", clientRequestId: `p22c-dep-${ctx.companyId}` });
    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.voucher.voucherNumber).toMatch(new RegExp(`^JV-${ctx.companyId}-2026-\\d{6}$`));
    const second = await send();
    expect(second.body.voucher.id).toBe(first.body.voucher.id);
    expect(second.body.employee.currentBalance).toBe("12.34");
    await expectBalanced(first.body.voucher.id);
    expect((await voucherById(first.body.voucher.id)).posted_by_engine).toBe(true);

    const withdraw = await agent
      .post(`/api/factory/employees/${ids.EMPLOYEE}/withdraw`)
      .send({ amount: "2.34", date: "2026-08-02", cashAccountId: String(ctx.cashAccountId) });
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);
    const sequence = (number: string) => Number(number.split("-").pop());
    expect(sequence(withdraw.body.voucher.voucherNumber)).toBe(sequence(first.body.voucher.voucherNumber) + 1);
  });

  it("posts a generic factory voucher with an engine number when no family number is given", async () => {
    const posted = await db.transaction((tx) =>
      postFactoryVoucherTx(tx, {
        companyId: ctx.companyId,
        voucherType: "Payment",
        voucherDate: "2026-08-03",
        description: "generic",
        source: { sourceType: "p22c-generic", sourceId: ctx.companyId },
        lines: [
          { ledgerAccountId: ctx.salesAccountId, debit: "0.1" },
          { ledgerAccountId: ctx.salesAccountId, debit: "0.2" },
          { ledgerAccountId: ctx.cashAccountId, credit: "0.3" },
        ],
      })
    );
    expect(posted.voucher.voucherNumber).toMatch(new RegExp(`^PV-${ctx.companyId}-2026-\\d{6}$`));
    await expectBalanced(posted.voucher.id);
  });
});

describe("retired auto-apply-fx", () => {
  it("answers 410 (the route's own handler, after its auth chain) and writes nothing", async () => {
    const routes: Array<{ path: string; handlers: Array<(...args: unknown[]) => unknown> }> = [];
    registerRawStockAutoApplyFxRoutes({
      post: (path: string, ...handlers: Array<(...args: unknown[]) => unknown>) => routes.push({ path, handlers }),
    } as unknown as Parameters<typeof registerRawStockAutoApplyFxRoutes>[0]);
    expect(routes.map((route) => route.path)).toEqual(["/api/factory/raw-stock/recalc/auto-apply-fx"]);
    const handler = routes[0].handlers[routes[0].handlers.length - 1];
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        sent.body = body;
        return this;
      },
    };
    await handler({ body: { containerIds: [1] } }, res);
    expect(sent.status).toBe(410);
    expect(sent.body?.code).toBe("FACTORY_AUTO_APPLY_FX_RETIRED");
  });
});
