/**
 * Accounting audit wave 17 (D), owner decision 1 of 2026-10-09: a non-USD
 * factory document needs a confirmed dated rate, and the currency trigger
 * refuses the legacy shape for new lines of every currency.
 *
 *   - factoryDocumentRate: USD is 1; a non-USD document with no confirmed
 *     factory rate on or before its date is refused (FACTORY_FX_RATE_REQUIRED,
 *     currency and date); a later rate is never used; the document's own set
 *     rate is posted when it has one, else the confirmed rate.
 *   - Factory supplier payment and raw-stock adjustment: refused (409) with
 *     nothing written when no rate exists; normalized lines otherwise.
 *   - Reverse offload: the pre-offload freight voucher the offload retired is
 *     restored exactly as posted (legacy lines included), never converted.
 *   - Trigger v2: a new EUR line without transaction amounts is refused; an
 *     existing legacy line stays editable while its amounts are unchanged; a
 *     change of its amounts is refused; normalized EUR and legacy USD lines pass.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import {
  CURRENCY_NORMALIZATION_GUARD_VERSION,
  ensureCurrencyNormalizationGuard,
  installedCurrencyNormalizationVersion,
} from "../server/services/accounting/currencyNormalizationGuard";
import { retireVouchersTx } from "../server/services/accounting/voucherRetirement";
import {
  FACTORY_FX_RATE_REQUIRED,
  FactoryFxRateRequiredError,
  factoryDocumentRate,
} from "../server/services/factory/factoryDocumentFxRate";
import { restoreRetiredPreOffloadFreightTx } from "../server/services/factory/reverseOffloadFreight";
import { db } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave17dfx";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId = 0;
let expenseAccountId = 0;

async function one<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T> {
  return (await pool.query(text, values)).rows[0] as T;
}

async function purgeFactoryRows(companyId: number) {
  await withFixtureTransaction(
    async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      const q = (text: string) => client.query(text, [companyId]);
      await q(`DELETE FROM accounting_posting_requests WHERE company_id = $1`);
      await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`);
      await q(`DELETE FROM vouchers WHERE company_id = $1`);
      for (const table of [
        "factory_supplier_payments",
        "factory_raw_material_adjustments",
        "factory_daybook_entries",
        "factory_fx_rates",
        "financial_operation_requests",
      ]) {
        await q(`DELETE FROM ${table} WHERE company_id = $1`);
      }
      await q(`DELETE FROM factory_suppliers WHERE company_id = $1`);
    },
    { legacyUnbalanced: true }
  );
}

/** Inserts a voucher and its lines with every trigger off: a legacy row as history left it. */
async function insertLegacyVoucher(number: string, currency: string, amount: string, lines: Record<string, unknown>[]) {
  return withFixtureTransaction(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const voucher = (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency, exchange_rate, source_module)
         VALUES ($1, 'Journal', $2, '2026-08-15', $3, $4, NULL, 'FACTORY') RETURNING id`,
        [ctx.companyId, number, amount, currency]
      )
    ).rows[0] as { id: number };
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, factory_supplier_id, debit_amount, credit_amount, narration)
         VALUES ($1, $6, $2, $3, $4, $5, 'legacy')`,
        [
          voucher.id,
          line.ledgerAccountId ?? null,
          line.factorySupplierId ?? null,
          line.debit,
          line.credit,
          ctx.companyId,
        ]
      );
    }
    return voucher.id;
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  // The factory routes need a factory company.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
  expect(await installedCurrencyNormalizationVersion(pool)).toBe(CURRENCY_NORMALIZATION_GUARD_VERSION);
  supplierId = (
    await one<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, '2.00000000') RETURNING id`,
      [ctx.companyId, `${PREFIX}_supplier`]
    )
  ).id;
  expenseAccountId = (
    await one<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'W17D freight', 'Expense') RETURNING id`,
      [ctx.companyId, `${PREFIX}-FRT`]
    )
  ).id;
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await purgeFactoryRows(ctx.companyId);
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120000);

describe("factoryDocumentRate", () => {
  it("is 1 for USD and refuses a non-USD document with no confirmed rate on or before its date", async () => {
    expect((await factoryDocumentRate(db, ctx.companyId, "USD", "2026-09-01")).rate).toBe("1");
    await pool.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source) VALUES ($1, 'AUD', '0.65', '2026-09-10', 'manual')`,
      [ctx.companyId]
    );
    const refusal = await factoryDocumentRate(db, ctx.companyId, "AUD", "2026-09-01").catch((error) => error);
    expect(refusal).toBeInstanceOf(FactoryFxRateRequiredError);
    expect(refusal.body).toMatchObject({ code: FACTORY_FX_RATE_REQUIRED, currency: "AUD", documentDate: "2026-09-01" });
    // On or after the rate's date: the confirmed rate, unless the document has its own set rate.
    expect(await factoryDocumentRate(db, ctx.companyId, "AUD", "2026-09-12")).toMatchObject({
      rate: "0.65000000",
      source: "manual",
    });
    expect(await factoryDocumentRate(db, ctx.companyId, "AUD", "2026-09-12", { rate: "0.66" })).toMatchObject({
      rate: "0.66",
      source: "document",
    });
    // A rate of 1 on a non-USD document is not a set rate.
    expect((await factoryDocumentRate(db, ctx.companyId, "AUD", "2026-09-12", { rate: "1" })).source).toBe("manual");
  });
});

describe("factory supplier payment", () => {
  const payment = (key: string) => ({
    supplierId,
    date: "2026-09-01",
    amount: "100",
    currencyCode: "EUR",
    fxRateToUsd: "1.10",
    amountUsd: "110",
    clientRequestId: key,
  });

  it("refuses a EUR payment with no confirmed rate, writing nothing", async () => {
    const refused = await agent.post("/api/factory/supplier-payments").send(payment("w17d-pay-0001"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: FACTORY_FX_RATE_REQUIRED, currency: "EUR", documentDate: "2026-09-01" });
    expect(
      (await pool.query(`SELECT 1 FROM factory_supplier_payments WHERE company_id = $1`, [ctx.companyId])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(`SELECT 1 FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'FACTORY-PAY-%'`, [
          ctx.companyId,
        ])
      ).rowCount
    ).toBe(0);
  });

  it("posts normalized lines at the payment's own rate once a dated rate exists", async () => {
    await pool.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source) VALUES ($1, 'EUR', '1.08', '2026-08-01', 'manual')`,
      [ctx.companyId]
    );
    const posted = await agent.post("/api/factory/supplier-payments").send(payment("w17d-pay-0002"));
    expect(posted.status).toBe(200);
    const lines = (
      await pool.query(
        `SELECT ve.debit_amount::text AS d, ve.credit_amount::text AS c, ve.transaction_currency AS ccy,
                ve.transaction_debit_amount::text AS td, ve.transaction_credit_amount::text AS tc,
                ve.historical_exchange_rate::text AS rate, ve.rate_convention AS conv
           FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = $1 AND v.voucher_number LIKE 'FACTORY-PAY-%' ORDER BY ve.id`,
        [ctx.companyId]
      )
    ).rows;
    expect(lines).toEqual([
      expect.objectContaining({
        d: "110.00",
        ccy: "EUR",
        td: "100.000000",
        rate: "1.1000000000",
        conv: "BASE_PER_TRANSACTION",
      }),
      expect.objectContaining({ c: "110.00", ccy: "EUR", tc: "100.000000", rate: "1.1000000000" }),
    ]);
  });
});

describe("raw-stock adjustment", () => {
  it("refuses an AUD purchase voucher dated before any AUD rate, then posts it normalized at the confirmed rate", async () => {
    const body = {
      type: "ADD",
      kg: "10",
      currencyCode: "AUD",
      supplierId,
      date: "2026-09-05",
      createVoucher: true,
    };
    const refused = await agent.post("/api/factory/raw-stock/adjustment").send(body);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: FACTORY_FX_RATE_REQUIRED, currency: "AUD", documentDate: "2026-09-05" });
    expect(
      (await pool.query(`SELECT 1 FROM factory_raw_material_adjustments WHERE company_id = $1`, [ctx.companyId]))
        .rowCount
    ).toBe(0);

    const posted = await agent.post("/api/factory/raw-stock/adjustment").send({ ...body, date: "2026-09-15" });
    expect(posted.status).toBe(200);
    const lines = (
      await pool.query(
        `SELECT ve.debit_amount::text AS d, ve.credit_amount::text AS c, ve.transaction_currency AS ccy,
                ve.historical_exchange_rate::text AS rate
           FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = $1 AND v.voucher_number LIKE 'FACTORY-MANUAL-%' ORDER BY ve.id`,
        [ctx.companyId]
      )
    ).rows;
    // 10 kg × the locked 2.00 = 20 AUD at the confirmed 0.65.
    expect(lines).toEqual([
      expect.objectContaining({ d: "13.00", ccy: "AUD", rate: "0.6500000000" }),
      expect.objectContaining({ c: "13.00", ccy: "AUD", rate: "0.6500000000" }),
    ]);
  });
});

describe("reverse offload restores the pre-offload freight voucher as posted", () => {
  it("brings back the retired legacy-shaped voucher with its lines unchanged", async () => {
    const containerId = 917_001;
    const voucherId = await insertLegacyVoucher(`FACTORY-FREIGHT-${containerId}`, "EUR", "40.00", [
      { ledgerAccountId: expenseAccountId, debit: "40.00", credit: "0" },
      { factorySupplierId: supplierId, debit: "0", credit: "40.00" },
    ]);
    const before = (await pool.query(`SELECT * FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [voucherId]))
      .rows;
    expect(before.every((line) => line.transaction_currency === null)).toBe(true);
    // The offload retires it (wave 16 A)…
    await db.transaction((tx) =>
      retireVouchersTx(tx, {
        companyId: ctx.companyId,
        voucherIds: [voucherId],
        reason: "factory-raw-stock-offload-delete",
      })
    );
    // …a different amount is not the voucher the snapshot describes…
    expect(
      await db.transaction((tx) =>
        restoreRetiredPreOffloadFreightTx(tx, {
          companyId: ctx.companyId,
          containerId,
          currency: "EUR",
          amount: "41",
          freightAccountId: expenseAccountId,
          actor: { userId: ctx.userId, username: "w17d" },
        })
      )
    ).toBeNull();
    // …the reversal restores exactly it.
    const restored = await db.transaction((tx) =>
      restoreRetiredPreOffloadFreightTx(tx, {
        companyId: ctx.companyId,
        containerId,
        currency: "EUR",
        amount: "40",
        freightAccountId: expenseAccountId,
        actor: { userId: ctx.userId, username: "w17d" },
      })
    );
    expect(restored).toBe(voucherId);
    const voucher = await one<{ voucher_number: string; deleted_at: string | null }>(
      `SELECT voucher_number, deleted_at FROM vouchers WHERE id = $1`,
      [voucherId]
    );
    expect(voucher).toEqual({ voucher_number: `FACTORY-FREIGHT-${containerId}`, deleted_at: null });
    const after = (await pool.query(`SELECT * FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [voucherId]))
      .rows;
    expect(after).toEqual(before);
    const audit = await one<{ action: string }>(
      `SELECT action FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2 ORDER BY id DESC LIMIT 1`,
      [ctx.companyId, voucherId]
    );
    expect(audit.action).toBe("restore");
  });
});

describe("currency trigger v2", () => {
  async function eurVoucher(client: import("pg").PoolClient) {
    return (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency, exchange_rate)
         VALUES ($1, 'Journal', $2, '2026-09-20', '10', 'EUR', '1.1') RETURNING id`,
        [ctx.companyId, `W17D-EUR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`]
      )
    ).rows[0].id as number;
  }

  it("refuses a new EUR line without transaction amounts", async () => {
    const refused = await withFixtureTransaction(async (client) => {
      const id = await eurVoucher(client);
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, '10', '0')`,
        [id, expenseAccountId]
      );
    }).catch((error) => error);
    expect(String(refused?.message)).toMatch(/VOUCHER_LINE_NATIVE_AMOUNT_REQUIRED/);
    expect(refused?.code).toBe("23514");
  });

  it("accepts normalized EUR lines and normalizes a legacy USD line", async () => {
    await withFixtureTransaction(async (client) => {
      const id = await eurVoucher(client);
      for (const [debit, credit] of [
        ["11.000000", "0"],
        ["0", "11.000000"],
      ]) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
             transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
             historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $3, $4, 1.1, 'BASE_PER_TRANSACTION')`,
          [id, expenseAccountId, debit, credit, debit === "0" ? "0" : "10", credit === "0" ? "0" : "10"]
        );
      }
      const usd = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency)
           VALUES ($1, 'Journal', $2, '2026-09-20', '5', 'USD') RETURNING id`,
          [ctx.companyId, `W17D-USD-${Date.now()}`]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, '5', '0'), ($1, $2, '0', '5')`,
        [usd, expenseAccountId]
      );
      const normalized = await client.query(`SELECT transaction_currency FROM voucher_entries WHERE voucher_id = $1`, [
        usd,
      ]);
      expect(normalized.rows.every((row) => row.transaction_currency === "USD")).toBe(true);
    });
  });

  it("leaves an existing legacy line as it is and refuses a change of its amounts", async () => {
    const voucherId = await insertLegacyVoucher(`W17D-LEGACY-${Date.now()}`, "AUD", "7.00", [
      { ledgerAccountId: expenseAccountId, debit: "7.00", credit: "0" },
      { ledgerAccountId: expenseAccountId, debit: "0", credit: "7.00" },
    ]);
    const [line] = (await pool.query(`SELECT id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [voucherId]))
      .rows;
    // Untouched columns and unchanged amounts pass.
    await pool.query(`UPDATE voucher_entries SET narration = 'reviewed' WHERE id = $1`, [line.id]);
    await pool.query(`UPDATE voucher_entries SET debit_amount = debit_amount WHERE id = $1`, [line.id]);
    const refused = await withFixtureTransaction(async (client) => {
      await client.query(`UPDATE voucher_entries SET debit_amount = '8.00' WHERE id = $1`, [line.id]);
    }).catch((error) => error);
    expect(String(refused?.message)).toMatch(/VOUCHER_LINE_NATIVE_AMOUNT_REQUIRED/);
    const after = await one<{ debit: string; narration: string }>(
      `SELECT debit_amount::text AS debit, narration FROM voucher_entries WHERE id = $1`,
      [line.id]
    );
    expect(after).toEqual({ debit: "7.00", narration: "reviewed" });
  });
});
