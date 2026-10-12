/**
 * Accounting audit phase 24 — multi-currency complete, against the database.
 *
 *   - M1: one resolver (recorded rate on or before the date, manual over auto on
 *     the same date; a newer auto rate beats an older manual one).
 *   - M4: ERP voucher and POS rates resolved on the server at the voucher date;
 *     a client rate is accepted only within 0.5% (409 with the recorded rate).
 *   - M5: a non-USD PO import posts normalized lines, stores USD and native
 *     amounts, and the voucher and PO commit together.
 *   - M6: realized FX on an allocation (phase 25 table) to FX_GAIN_LOSS,
 *     reversed when the allocation is released.
 *   - M7: month-end revaluation preview / apply (Owner), reversing on day 1.
 *   - M11: Retail journals in a non-USD company at the dated rate.
 *   - M13: asOf on the cash/bank multi-currency summary.
 *   - MC-5: the group is presented in USD.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { MoneyDecimal } from "../server/lib/money";
import { onAllocationPostedTx } from "../server/services/accounting/allocations/allocationEvents";
import { ensureOpenItemSchema } from "../server/services/accounting/allocations/ensureOpenItemSchema";
import { ensureCurrencyNormalizationGuard } from "../server/services/accounting/currencyNormalizationGuard";
import { CLIENT_RATE_TOLERANCE, withinRateTolerance } from "../server/services/accounting/fx/clientRateCheck";
import { companiesNeedingTranslation } from "../server/services/accounting/fx/groupPresentationCurrency";
import { nextMonthFirstDay } from "../server/services/accounting/fx/monthEndRevaluation";
import { ensurePurchaseOrderCurrencySchema } from "../server/services/accounting/fx/purchaseOrderCurrencySchema";
import {
  postRealizedFxForAllocationTx,
  reverseRealizedFxForAllocationTx,
} from "../server/services/accounting/fx/realizedFx";
import { resolveCompanyRecordedRate, resolveFactoryRecordedRate } from "../server/services/accounting/fx/rateResolver";
import { retailEntriesInCurrency } from "../server/services/accounting/fx/retailCurrency";
import { getLatestCfaPerUsd } from "../server/services/accounting/latestCfaPerUsd";
import { postErpVoucherTx } from "../server/services/accounting/erpVoucherPosting";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { findFactoryFxRateOnOrBefore } from "../server/services/factory/factoryFxRateOnDate";
import { postRetailJournalTx } from "../server/services/retail/retailLedgerPosting";
import { getExchangeRateForDate } from "../server/storage/accounting/exchange-rates";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "phase24fx";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId = 0;
let revalCustomerId = 0;
let supplierId = 0;

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function companyRate(from: string, to: string, rate: string, date: string) {
  await pool.query(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, effective_date, from_currency, to_currency) DO UPDATE SET rate = EXCLUDED.rate`,
    [ctx.companyId, from, to, rate, date]
  );
}

async function factoryRate(currency: string, rate: string, date: string, source: "manual" | "auto") {
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.companyId, currency, rate, date, source]
    );
  });
}

const inScope = <T>(work: () => Promise<T>) => runInCompanyPostingScope(ctx.companyId, work);

async function voucherLines(voucherId: number) {
  return (
    await pool.query(
      `SELECT ledger_account_id, customer_id, debit_amount::text AS debit, credit_amount::text AS credit,
              transaction_currency, transaction_debit_amount::text AS tx_debit,
              transaction_credit_amount::text AS tx_credit, historical_exchange_rate::text AS rate
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    )
  ).rows;
}

async function accountIdByCode(code: string): Promise<number | null> {
  const { rows } = await pool.query(`SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = $2`, [
    ctx.companyId,
    code,
  ]);
  return rows[0]?.id ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
  await ensureOpenItemSchema(pool);
  await ensurePurchaseOrderCurrencySchema(pool);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  await pool.query(`UPDATE companies SET display_currency = 'CFA' WHERE id = $1`, [ctx.companyId]);
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-C1`, `${PREFIX} customer`]
  );
  customerId = customer.rows[0].id;
  const revalCustomer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-C2`, `${PREFIX} revaluation customer`]
  );
  revalCustomerId = revalCustomer.rows[0].id;
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
     VALUES ($1, $2, $3, $4, '0', true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-SUP`, `${PREFIX} Supplier`, `${PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;
}, 120000);

afterAll(async () => {
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM party_open_item_allocations WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM container_charges WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(
      `DELETE FROM import_logs WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM containers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`UPDATE vouchers SET reversal_of_voucher_id = NULL WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("M1 — one rate resolver", () => {
  it("factory store: latest recorded rate on or before the date, manual first on the same date", async () => {
    await factoryRate("EUR", "1.10", "2026-01-01", "manual");
    await factoryRate("EUR", "1.12", "2026-01-05", "auto");
    // A newer recorded auto rate beats an older manual one (before: the manual one won).
    expect((await findFactoryFxRateOnOrBefore(db, ctx.companyId, "EUR", "2026-01-07"))?.rate).toBe("1.12000000");
    await factoryRate("EUR", "1.11", "2026-01-05", "manual");
    const sameDay = await resolveFactoryRecordedRate(db, ctx.companyId, "EUR", "2026-01-07");
    expect(sameDay).toMatchObject({ rate: "1.11000000", source: "manual", effectiveDate: "2026-01-05" });
    expect((await findFactoryFxRateOnOrBefore(db, ctx.companyId, "EUR", "2026-01-03"))?.rate).toBe("1.10000000");
    expect(await findFactoryFxRateOnOrBefore(db, ctx.companyId, "EUR", "2025-12-31")).toBeNull();
    expect(await findFactoryFxRateOnOrBefore(db, ctx.companyId, "USD", "2025-12-31")).toMatchObject({ rate: "1" });
  });

  it("company store: the later of the direct and inverse pair, never a later date; CFA and XOF are one", async () => {
    await companyRate("USD", "GBP", "0.800000", "2026-01-01");
    await companyRate("GBP", "USD", "1.250000", "2026-01-04");
    expect(await resolveCompanyRecordedRate(db, ctx.companyId, "GBP", "2026-01-03")).toMatchObject({
      unitsPerUsd: "0.8",
      pair: "direct",
    });
    expect(await resolveCompanyRecordedRate(db, ctx.companyId, "GBP", "2026-01-05")).toMatchObject({
      unitsPerUsd: "0.8",
      pair: "inverse",
      effectiveDate: "2026-01-04",
    });
    expect(await resolveCompanyRecordedRate(db, ctx.companyId, "GBP", "2025-12-31")).toBeNull();
    await companyRate("USD", "XOF", "590.000000", "2026-01-02");
    expect((await getLatestCfaPerUsd(ctx.companyId, "2026-01-03"))?.toFixed()).toBe("590");
    expect((await getExchangeRateForDate(ctx.companyId, "USD", "CFA", "2026-01-03"))?.rate).toBe("590.000000");
  });

  it("the 0.5% tolerance", () => {
    expect(CLIENT_RATE_TOLERANCE).toBe("0.005");
    expect(withinRateTolerance("603", "600")).toBe(true);
    expect(withinRateTolerance("603.01", "600")).toBe(false);
    expect(withinRateTolerance("597", "600")).toBe(true);
  });
});

describe("M4 — server-side dated rates with client rates checked", () => {
  const body = (overrides: Record<string, unknown>, id: string) => ({
    clientRequestId: `${PREFIX}-${id}-${Date.now()}`,
    voucher: { voucherType: "Journal", voucherDate: "2026-02-10", description: "fx", ...overrides },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "10.00", creditAmount: "0" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "10.00" },
    ],
  });

  it("a USD voucher takes the display rate dated on or before it; a client rate outside 0.5% is refused", async () => {
    await companyRate("USD", "CFA", "600.000000", "2026-02-01");
    await companyRate("USD", "CFA", "655.000000", "2026-02-20");
    const recorded = await agent.post("/api/vouchers/with-entries").send(body({}, "dated"));
    expect(recorded.status).toBe(200);
    expect(recorded.body.voucher.exchangeRate).toBe("600.000000");

    const refused = await agent.post("/api/vouchers/with-entries").send(body({ exchangeRate: 655 }, "far"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "EXCHANGE_RATE_OUT_OF_TOLERANCE",
      recordedRate: "600",
      recordedRateDate: "2026-02-01",
    });

    const close = await agent.post("/api/vouchers/with-entries").send(body({ exchangeRate: 602 }, "close"));
    expect(close.status).toBe(200);
    expect(close.body.voucher.exchangeRate).toBe("602.000000");
  });

  it("a CFA voucher on the legacy path posts at the recorded rate; a far rate or a missing one is refused", async () => {
    const legacy = (voucher: Record<string, unknown>) => ({
      voucher: {
        voucherType: "Journal",
        voucherDate: "2026-02-10",
        voucherNumber: `${PREFIX}-L-${Date.now()}`,
        ...voucher,
      },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "6000", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "6000" },
      ],
    });
    const posted = await agent.post("/api/vouchers/with-entries").send(legacy({ currency: "CFA" }));
    expect(posted.status).toBe(200);
    const lines = await voucherLines(posted.body.voucher.id);
    expect(lines[0]).toMatchObject({ debit: "10.00", transaction_currency: "CFA", rate: "600.0000000000" });

    const far = await agent.post("/api/vouchers/with-entries").send(legacy({ currency: "CFA", exchangeRate: 700 }));
    expect(far.status).toBe(409);
    expect(far.body.code).toBe("EXCHANGE_RATE_OUT_OF_TOLERANCE");

    const none = await agent.post("/api/vouchers/with-entries").send(legacy({ currency: "GHS" }));
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: "EXCHANGE_RATE_REQUIRED", currency: "GHS", documentDate: "2026-02-10" });
  });

  it("a POS sale with a client rate outside 0.5% is refused before anything is written", async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    const sale = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 1, rate: 5 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: "2026-02-10",
      currency: "CFA",
      exchangeRate: 700,
    });
    expect(sale.status).toBe(409);
    expect(sale.body).toMatchObject({ code: "EXCHANGE_RATE_OUT_OF_TOLERANCE", recordedRate: "600" });
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("M5 — non-USD purchase orders", () => {
  it("refuses an NGN PO with no recorded rate, then posts normalized lines and stores USD with the native amounts", async () => {
    const { rows } = await pool.query(`SELECT code, name FROM stock_items WHERE id = $1`, [ctx.stockItemIds[0]]);
    const nonce = Date.now();
    const containerNumber = `${PREFIX.toUpperCase()}-C-${nonce}`;
    const poNumber = `${PREFIX.toUpperCase()}-PO-${nonce}`;
    const send = (hash: string) =>
      agent.post("/api/po-import/import").send({
        fileHash: hash,
        fileName: `${PREFIX}.xlsx`,
        containerNumber,
        supplierId,
        importDate: "2026-03-10",
        freightPaidBy: "supplier",
        preview: [
          {
            containerNumber,
            itemsTotal: 800,
            chargesTotal: 80,
            grandTotal: 880,
            itemsCount: 1,
            charges: { freight: 80, surcharge: 0, fumigation: 0, documentCharges: 0, discount: 0, otherCharges: 0 },
            items: [
              {
                poNumber,
                stockItemId: ctx.stockItemIds[0],
                barcode: rows[0].code,
                itemName: rows[0].name,
                quantity: 10,
                rate: 80,
                lineTotal: 800,
                currency: "NGN",
              },
            ],
          },
        ],
      });

    const refused = await send(`${PREFIX}-hash-a-${nonce}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EXCHANGE_RATE_REQUIRED");
    const none = await pool.query(`SELECT COUNT(*)::int AS n FROM containers WHERE container_number = $1`, [
      containerNumber,
    ]);
    expect(none.rows[0].n).toBe(0);

    await companyRate("USD", "NGN", "0.800000", "2026-03-01");
    const imported = await send(`${PREFIX}-hash-b-${nonce}`);
    expect(imported.status).toBe(200);
    const po = (
      await pool.query(
        `SELECT currency, native_currency, exchange_rate::text AS rate, items_total::text AS items, freight::text AS freight,
                native_items_total::text AS native_items, native_grand_total::text AS native_grand, voucher_id
           FROM purchase_orders WHERE company_id = $1 AND po_number = $2`,
        [ctx.companyId, poNumber]
      )
    ).rows[0];
    expect(po).toMatchObject({
      currency: "USD",
      native_currency: "NGN",
      rate: "0.8000000000",
      items: "1000.00",
      freight: "100.00",
      native_items: "800.00",
      native_grand: "880.00",
    });
    const line = (
      await pool.query(
        `SELECT rate::text AS rate, line_total::text AS total, native_rate::text AS nr, native_line_total::text AS nt
           FROM po_line_items WHERE po_id = (SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number = $2)`,
        [ctx.companyId, poNumber]
      )
    ).rows[0];
    expect(line).toEqual({ rate: "100.00", total: "1000.00", nr: "80.000000", nt: "800.00" });
    const voucher = (
      await pool.query(`SELECT currency, exchange_rate::text AS rate FROM vouchers WHERE id = $1`, [po.voucher_id])
    ).rows[0];
    expect(voucher).toEqual({ currency: "NGN", rate: "0.800000" });
    const entries = await voucherLines(po.voucher_id);
    expect(entries.map((entry) => [entry.transaction_currency, entry.debit, entry.credit])).toEqual([
      ["NGN", "1100.00", "0.00"],
      ["NGN", "0.00", "1100.00"],
    ]);
  });
});

describe("M6 — realized FX on an allocation", () => {
  async function postEur(id: string, date: string, rate: string, side: "invoice" | "receipt") {
    return inScope(() =>
      db.transaction((tx) =>
        postErpVoucherTx(tx, {
          companyId: ctx.companyId,
          voucherType: side === "invoice" ? "Sales" : "Receipt",
          voucherDate: date,
          currency: "EUR",
          exchangeRate: rate,
          lines: [
            {
              ...(side === "invoice" ? { customerId, ledgerAccountId: null } : { ledgerAccountId: ctx.cashAccountId }),
              debit: "1",
              transaction: { currency: "EUR", amount: "100", rate },
            },
            {
              ...(side === "invoice" ? { ledgerAccountId: ctx.salesAccountId } : { customerId }),
              credit: "1",
              transaction: { currency: "EUR", amount: "100", rate },
            },
          ],
          source: { type: `${PREFIX}-${side}`, id },
        })
      )
    );
  }

  it("posts the USD residue of the native amount settled to FX_GAIN_LOSS, and reverses it on release", async () => {
    const invoice = await postEur(`i-${Date.now()}`, "2026-04-02", "0.8", "invoice"); // EUR 100 = USD 125
    const receipt = await postEur(`r-${Date.now()}`, "2026-04-20", "1", "receipt"); // EUR 100 = USD 100
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO party_open_item_allocations
         (company_id, party_kind, party_id, invoice_voucher_id, payment_voucher_id, amount, currency, method)
       VALUES ($1, 'customer', $2, $3, $4, 100.00, 'USD', 'auto_fifo') RETURNING id`,
      [ctx.companyId, customerId, invoice.voucher.id, receipt.voucher.id]
    );
    const allocation = {
      companyId: ctx.companyId,
      allocationId: rows[0].id,
      partyKind: "customer" as const,
      partyId: customerId,
      invoiceVoucherId: invoice.voucher.id,
      paymentVoucherId: receipt.voucher.id,
      amount: "100.00",
    };
    const result = await inScope(() => db.transaction((tx) => postRealizedFxForAllocationTx(tx, allocation)));
    expect(result).toMatchObject({ posted: true, difference: "-25.00", currency: "EUR", nativeSettled: "100.000000" });
    const fxAccount = await accountIdByCode("FX_GAIN_LOSS");
    const lines = await voucherLines(result.voucherId!);
    // A loss: Cr the customer 25 (the residue of the invoice), Dr FX_GAIN_LOSS 25.
    expect(lines.map((line) => [line.customer_id, line.ledger_account_id, line.debit, line.credit])).toEqual([
      [customerId, null, "0.00", "25.00"],
      [null, fxAccount, "25.00", "0.00"],
    ]);
    const residue = await pool.query(
      `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::text AS net
         FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
        WHERE v.company_id = $1 AND v.deleted_at IS NULL AND e.customer_id = $2`,
      [ctx.companyId, customerId]
    );
    expect(residue.rows[0].net).toBe("0.00");

    const replay = await inScope(() => db.transaction((tx) => postRealizedFxForAllocationTx(tx, allocation)));
    expect(replay).toMatchObject({ posted: false, reason: "REPLAYED", voucherId: result.voucherId });

    const reversed = await inScope(() =>
      db.transaction((tx) => reverseRealizedFxForAllocationTx(tx, { ...allocation, releaseReason: "test" }))
    );
    expect(reversed.reversed).toBe(true);
    const reversal = await pool.query(`SELECT reversal_of_voucher_id FROM vouchers WHERE id = $1`, [
      reversed.reversalVoucherId,
    ]);
    expect(reversal.rows[0].reversal_of_voucher_id).toBe(result.voucherId);
  });

  it("is plugged into the phase 25 allocation events (registered with the routes)", async () => {
    const invoice = await postEur(`i2-${Date.now()}`, "2026-04-03", "1", "invoice"); // USD 100
    const receipt = await postEur(`r2-${Date.now()}`, "2026-04-21", "0.8", "receipt"); // USD 125
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO party_open_item_allocations
         (company_id, party_kind, party_id, invoice_voucher_id, payment_voucher_id, amount, currency, method)
       VALUES ($1, 'customer', $2, $3, $4, 100.00, 'USD', 'auto_fifo') RETURNING id`,
      [ctx.companyId, customerId, invoice.voucher.id, receipt.voucher.id]
    );
    // Integration review: the listener posts only for a company whose Owner enabled the
    // automatic allocation, for settlements dated on or after the enablement.
    await pool.query(
      `INSERT INTO open_item_allocation_enablements (company_id, enabled_at, enabled_on, enabled_by, plan_hash)
       VALUES ($1, now() - interval '1 day', '2026-04-01', 'test', 'test') ON CONFLICT (company_id) DO NOTHING`,
      [ctx.companyId]
    );
    await inScope(() =>
      db.transaction((tx) =>
        onAllocationPostedTx(tx, {
          companyId: ctx.companyId,
          allocationId: rows[0].id,
          partyKind: "customer",
          partyId: customerId,
          invoiceVoucherId: invoice.voucher.id,
          paymentVoucherId: receipt.voucher.id,
          amount: "100.00",
          currency: "USD",
          method: "auto_fifo",
        })
      )
    );
    const posted = await pool.query(
      `SELECT r.voucher_id FROM accounting_posting_requests r
        WHERE r.company_id = $1 AND r.source_type = 'fx-realized-allocation' AND r.source_id = $2`,
      [ctx.companyId, String(rows[0].id)]
    );
    expect(posted.rows).toHaveLength(1);
    const lines = await voucherLines(posted.rows[0].voucher_id);
    // The invoice is consumed (EUR 100 at USD 1.00); the receipt booked USD 125 for it: a gain of 25.
    expect(lines.map((line) => [line.customer_id, line.debit, line.credit])).toEqual([
      [customerId, "25.00", "0.00"],
      [null, "0.00", "25.00"],
    ]);
  });

  it("review finding: a customer's lines on its linked ledger account are its items (engine ownership rule)", async () => {
    // The open-item engine (allocations/openItems.ts) and the balance engine attribute a line on a
    // customer's linked ledger to the customer even without customer_id; realized FX must too.
    const stamp = Date.now().toString().slice(-6);
    const ledger = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts
         (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active)
       VALUES ($1, $2, $3, 'Asset', 'receivable', '0', 'Dr', true) RETURNING id`,
      [ctx.companyId, `P24LNK${stamp}`, `${PREFIX} linked receivable`]
    );
    const linked = await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name, active, ledger_account_id)
       VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [ctx.companyId, `${PREFIX}-LNK${stamp}`, `${PREFIX} linked customer`, ledger.rows[0].id]
    );
    const linkedLedgerId = ledger.rows[0].id;
    const post = (id: string, date: string, rate: string, side: "invoice" | "receipt") =>
      inScope(() =>
        db.transaction((tx) =>
          postErpVoucherTx(tx, {
            companyId: ctx.companyId,
            voucherType: side === "invoice" ? "Sales" : "Receipt",
            voucherDate: date,
            currency: "EUR",
            exchangeRate: rate,
            lines: [
              {
                ledgerAccountId: side === "invoice" ? linkedLedgerId : ctx.cashAccountId,
                debit: "1",
                transaction: { currency: "EUR", amount: "100", rate },
              },
              {
                ledgerAccountId: side === "invoice" ? ctx.salesAccountId : linkedLedgerId,
                credit: "1",
                transaction: { currency: "EUR", amount: "100", rate },
              },
            ],
            source: { type: `${PREFIX}-linked-${side}`, id },
          })
        )
      );
    const invoice = await post(`li-${stamp}`, "2026-04-04", "0.8", "invoice"); // EUR 100 = USD 125
    const receipt = await post(`lr-${stamp}`, "2026-04-22", "1", "receipt"); // EUR 100 = USD 100
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO party_open_item_allocations
         (company_id, party_kind, party_id, invoice_voucher_id, payment_voucher_id, amount, currency, method)
       VALUES ($1, 'customer', $2, $3, $4, 100.00, 'USD', 'auto_fifo') RETURNING id`,
      [ctx.companyId, linked.rows[0].id, invoice.voucher.id, receipt.voucher.id]
    );
    const result = await inScope(() =>
      db.transaction((tx) =>
        postRealizedFxForAllocationTx(tx, {
          companyId: ctx.companyId,
          allocationId: rows[0].id,
          partyKind: "customer",
          partyId: linked.rows[0].id,
          invoiceVoucherId: invoice.voucher.id,
          paymentVoucherId: receipt.voucher.id,
          amount: "100.00",
        })
      )
    );
    expect(result).toMatchObject({ posted: true, difference: "-25.00", currency: "EUR" });
    const fxAccount = await accountIdByCode("FX_GAIN_LOSS");
    const lines = await voucherLines(result.voucherId!);
    // The correction sits on the linked ledger, which is the customer's balance.
    expect(lines.map((line) => [line.ledger_account_id, line.debit, line.credit])).toEqual([
      [linkedLedgerId, "0.00", "25.00"],
      [fxAccount, "25.00", "0.00"],
    ]);
  });

  it("skips an opening item and a settlement in another currency", async () => {
    const skip = await inScope(() =>
      db.transaction((tx) =>
        postRealizedFxForAllocationTx(tx, {
          companyId: ctx.companyId,
          allocationId: 999999,
          partyKind: "customer",
          partyId: customerId,
          invoiceVoucherId: null,
          paymentVoucherId: 1,
          amount: "1.00",
        })
      )
    );
    expect(skip).toEqual({ posted: false, reason: "OPENING_ITEM" });
  });
});

describe("M7 — month-end revaluation", () => {
  it("previews, refuses a stale hash, applies with a day-1 reversal, and refuses a second apply", async () => {
    await companyRate("USD", "EUR", "0.800000", "2026-05-01");
    await companyRate("USD", "EUR", "0.850000", "2026-05-31");
    await inScope(() =>
      db.transaction((tx) =>
        postErpVoucherTx(tx, {
          companyId: ctx.companyId,
          voucherType: "Sales",
          voucherDate: "2026-05-15",
          currency: "EUR",
          exchangeRate: "0.8",
          lines: [
            { customerId: revalCustomerId, debit: "1", transaction: { currency: "EUR", amount: "100", rate: "0.8" } },
            {
              ledgerAccountId: ctx.salesAccountId,
              credit: "1",
              transaction: { currency: "EUR", amount: "100", rate: "0.8" },
            },
          ],
          source: { type: `${PREFIX}-reval`, id: Date.now() },
        })
      )
    );
    expect(nextMonthFirstDay("2026-05-31")).toBe("2026-06-01");
    expect(nextMonthFirstDay("2026-05-30")).toBeNull();

    await setRole("Admin");
    expect((await agent.get("/api/accounting/fx-revaluation/preview?monthEnd=2026-05-31")).status).toBe(403);
    await setRole("Owner");
    expect((await agent.get("/api/accounting/fx-revaluation/preview?monthEnd=2026-05-30")).body.code).toBe(
      "FX_REVALUATION_MONTH_END_INVALID"
    );
    expect((await agent.get("/api/accounting/fx-revaluation/preview?monthEnd=2099-01-31")).body.code).toBe(
      "FX_REVALUATION_FUTURE_MONTH"
    );

    const preview = await agent.get("/api/accounting/fx-revaluation/preview?monthEnd=2026-05-31");
    expect(preview.status).toBe(200);
    const line = preview.body.lines.find((row: { customerId: number }) => row.customerId === revalCustomerId);
    // EUR 100 booked at USD 125; at 0.85 EUR per USD it is USD 117.65: a loss of 7.35.
    expect(line).toMatchObject({
      currency: "EUR",
      nativeBalance: "100",
      bookBalance: "125.00",
      revaluedBalance: "117.65",
      adjustment: "-7.35",
    });
    expect(preview.body.alreadyApplied).toBeNull();

    const stale = await agent
      .post("/api/accounting/fx-revaluation/apply")
      .send({ monthEnd: "2026-05-31", planHash: "0".repeat(64), confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("FX_REVALUATION_PLAN_CHANGED");

    const applied = await agent
      .post("/api/accounting/fx-revaluation/apply")
      .send({ monthEnd: "2026-05-31", planHash: preview.body.planHash, confirm: true });
    expect(applied.status).toBe(200);
    const vouchers = await pool.query(
      `SELECT id, voucher_date::text AS date, reversal_of_voucher_id FROM vouchers WHERE id IN ($1, $2) ORDER BY id`,
      [applied.body.voucherId, applied.body.reversalVoucherId]
    );
    expect(vouchers.rows.map((row) => row.date)).toEqual(["2026-05-31", "2026-06-01"]);
    expect(vouchers.rows[1].reversal_of_voucher_id).toBe(applied.body.voucherId);
    const unrealized = await accountIdByCode("UNREALIZED_FX");
    const lines = await voucherLines(applied.body.voucherId);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customer_id: revalCustomerId, credit: "7.35" }),
        expect.objectContaining({ ledger_account_id: unrealized, debit: expect.any(String) }),
      ])
    );
    const audit = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND record_identifier = 'fx-revaluation:2026-05'`,
      [ctx.companyId]
    );
    expect(audit.rows[0].n).toBe(1);

    const again = await agent
      .post("/api/accounting/fx-revaluation/apply")
      .send({ monthEnd: "2026-05-31", planHash: preview.body.planHash, confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("FX_REVALUATION_ALREADY_APPLIED");
    await setRole("Admin");
  });
});

describe("M11 — Retail in a non-USD company", () => {
  it("normalizes the lines at the dated rate; without a rate the journal is refused", async () => {
    const converted = retailEntriesInCurrency(
      [
        { ledgerAccountId: 1, debitAmount: "6000.00", creditAmount: "0" },
        { ledgerAccountId: 2, debitAmount: "0", creditAmount: "6000.00" },
      ],
      { currency: "CFA", rate: "600" },
      "6000.00"
    );
    expect(converted.totalAmount).toBe("10.00");
    expect(converted.entries[0]).toMatchObject({ debitAmount: "10.000000", transactionCurrency: "CFA" });

    await pool.query(`UPDATE companies SET base_currency = 'CFA' WHERE id = $1`, [ctx.companyId]);
    try {
      const post = (date: string, id: string) =>
        inScope(() =>
          db.transaction((tx) =>
            postRetailJournalTx(tx, {
              companyId: ctx.companyId,
              voucherNumber: `${PREFIX}-RT-${id}`,
              sourceType: `${PREFIX}-retail`,
              sourceId: id,
              description: "retail fx",
              lines: [
                { ledgerAccountId: ctx.cashAccountId, amount: toDecimal("6000"), narration: "cash" },
                { ledgerAccountId: ctx.salesAccountId, amount: toDecimal("-6000"), narration: "sales" },
              ],
              actor: { userId: ctx.userId },
              reason: "test",
              voucherDate: date,
            })
          )
        );
      const voucherId = await post("2026-02-10", `a-${Date.now()}`);
      const lines = await voucherLines(voucherId!);
      expect(lines.map((line) => [line.transaction_currency, line.debit, line.credit])).toEqual([
        ["CFA", "10.00", "0.00"],
        ["CFA", "0.00", "10.00"],
      ]);
      await expect(post("2025-01-10", `b-${Date.now()}`)).rejects.toMatchObject({ code: "EXCHANGE_RATE_REQUIRED" });
    } finally {
      await pool.query(`UPDATE companies SET base_currency = 'USD' WHERE id = $1`, [ctx.companyId]);
    }
  });
});

describe("M13 / MC-5", () => {
  it("the cash/bank multi-currency summary takes asOf (lines and rate)", async () => {
    const all = await agent.get("/api/accounts/multi-currency/cash-bank-revaluation");
    expect(all.status).toBe(200);
    const early = await agent.get("/api/accounts/multi-currency/cash-bank-revaluation?asOf=2026-01-31");
    expect(early.status).toBe(200);
    // The rate is the one recorded on or before the as-of date (590 on 2026-01-02), not the later 600 / 655.
    expect(Number(early.body.currentCfaPerUsd)).toBe(590);
    expect((await agent.get("/api/accounts/multi-currency/cash-bank-revaluation?asOf=31-01-2026")).status).toBe(400);
    const cash = (rows: Array<{ id: number; accountKind: string; historicalBaseBalance: string }>) =>
      rows.find((row) => row.accountKind === "ledger" && row.id === ctx.cashAccountId);
    const allCash = cash(all.body.accounts);
    const earlyCash = cash(early.body.accounts);
    if (allCash && earlyCash) expect(earlyCash.historicalBaseBalance).not.toBe(allCash.historicalBaseBalance);
  });

  it("lists companies whose ledger is not in the USD presentation currency", () => {
    expect(
      companiesNeedingTranslation([
        { id: 1, name: "A", baseCurrency: "USD" },
        { id: 2, name: "B", baseCurrency: "eur" },
        { id: 3, name: "C", baseCurrency: null },
      ])
    ).toEqual([{ companyId: 2, companyName: "B", baseCurrency: "EUR" }]);
  });
});

function toDecimal(value: string) {
  return new MoneyDecimal(value);
}
