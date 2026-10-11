/**
 * Accounting audit wave 17 (C): exchange-rate leftovers, against the database.
 *
 *   - Decision 1: rate reads never write. GET /api/factory/fx-rates/:ccy/:date,
 *     /latest/:ccy and getOrFetchFxRateToUsd return a fetched external rate
 *     flagged as a suggestion and store nothing; POST /api/factory/fx-rates/fetched
 *     (Admin/Owner) records it, audited.
 *   - Decision 2: deleting a factory currency removes only manual rates no
 *     document used, keeps recorded auto rates, audits and reports what it kept.
 *   - Decision 3: "latest" lookups never use a rate dated after the as-of date.
 *   - Decision 4: the wave 6 repair apply needs the reviewed planHash, checks
 *     closed periods by the effective date, and prefers a rate dated exactly on
 *     the voucher date over an older manual rate.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pool } from "../server/db";
import { getOrFetchFxRateToUsd } from "../server/routes/factory/_helpers";
import { getLatestCfaPerUsd } from "../server/services/accounting/latestCfaPerUsd";
import { ensureCurrencyNormalizationGuard } from "../server/services/accounting/currencyNormalizationGuard";
import {
  FactoryFxRepairPlanHashRequiredError,
  applyFactoryFxLegacyRepair,
  planFactoryFxLegacyRepair,
} from "../server/services/factory/factoryFxLegacyRepair";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { getLatestExchangeRate } from "../server/storage/accounting/exchange-rates";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave17crates";
let ctx: TestContext;
let agent: request.SuperAgentTest;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("wave17c-rates-test", work);

function mockExternalRate(rate: number) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify({ rates: { USD: rate } }), { status: 200 }) as Response
    );
}

function failExternalRate() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("network down");
  });
}

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function factoryRates(currency: string) {
  return (
    await asMaintenance(() =>
      pool.query(
        `SELECT currency_code, rate_to_usd::text AS rate, effective_date::text AS date, source
           FROM factory_fx_rates WHERE company_id = $1 AND currency_code = $2 ORDER BY effective_date, id`,
        [ctx.companyId, currency]
      )
    )
  ).rows;
}

async function auditRows(tableName: string) {
  return (
    await pool.query(
      `SELECT action, record_identifier, changes FROM audit_log WHERE company_id = $1 AND table_name = $2 ORDER BY id`,
      [ctx.companyId, tableName]
    )
  ).rows;
}

async function insertRate(currency: string, rate: string, date: string, source: "manual" | "auto") {
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.companyId, currency, rate, date, source]
    );
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120000);

describe("rate reads never write (decision 1)", () => {
  it("returns a fetched rate as an unsaved suggestion and stores nothing", async () => {
    mockExternalRate(1.0875);
    const byDate = await agent.get("/api/factory/fx-rates/CHF/2026-09-10");
    expect(byDate.status).toBe(200);
    expect(byDate.body).toMatchObject({
      rate: "1.0875",
      effectiveDate: "2026-09-10",
      source: "fetched",
      saved: false,
      suggestion: true,
    });
    const latest = await agent.get("/api/factory/fx-rates/latest/CHF");
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ rate: "1.0875", source: "fetched", saved: false });
    expect(await getOrFetchFxRateToUsd(ctx.companyId, "CHF", "2026-09-11")).toBe("1.0875");
    expect(await factoryRates("CHF")).toEqual([]);
  });

  it("records a fetched rate only through the audited Admin/Owner action", async () => {
    mockExternalRate(1.1);
    await setRole("Manager");
    expect((await agent.post("/api/factory/fx-rates/fetched").send({ currencyCode: "CHF" })).status).toBe(403);
    expect(await factoryRates("CHF")).toEqual([]);

    await setRole("Admin");
    const saved = await agent.post("/api/factory/fx-rates/fetched").send({ currencyCode: "chf", date: "2026-09-10" });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ currencyCode: "CHF", source: "auto", created: true });
    const again = await agent.post("/api/factory/fx-rates/fetched").send({ currencyCode: "CHF", date: "2026-09-10" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(await factoryRates("CHF")).toEqual([
      { currency_code: "CHF", rate: "1.10000000", date: "2026-09-10", source: "auto" },
    ]);
    const audit = (await auditRows("factory_fx_rates")).filter((row) => row.record_identifier.startsWith("CHF"));
    expect(audit.map((row) => [row.action, row.record_identifier])).toEqual([["create", "CHF 2026-09-10 (fetched)"]]);
    expect(audit[0].changes.rateToUsd).toEqual({
      old: null,
      new: { rate: "1.10000000", effectiveDate: "2026-09-10", source: "auto" },
    });
    // The recorded rate is now what the lookups return, as saved.
    const read = await agent.get("/api/factory/fx-rates/CHF/2026-09-10");
    expect(read.body).toMatchObject({ rate: "1.10000000", source: "auto", saved: true, suggestion: false });
  });
});

describe("latest lookups never use a future rate (decision 3)", () => {
  it("the factory latest route does not fall back to a rate dated after today", async () => {
    failExternalRate();
    await insertRate("SEK", "0.095", "2099-01-01", "manual");
    expect((await agent.get("/api/factory/fx-rates/latest/SEK")).status).toBe(404);
    await insertRate("SEK", "0.091", "2026-01-15", "manual");
    const latest = await agent.get("/api/factory/fx-rates/latest/SEK");
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ rate: "0.09100000", effectiveDate: "2026-01-15", source: "manual" });
  });

  it("company rates: the latest dated on or before the as-of date", async () => {
    await withFixtureTransaction(async (client) => {
      for (const [rate, date] of [
        ["600", "2026-09-01"],
        ["615", "2026-10-01"],
        ["999", "2099-01-01"],
      ]) {
        await client.query(
          `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES ($1, 'USD', 'CFA', $2, $3)`,
          [ctx.companyId, rate, date]
        );
      }
    });
    expect((await getLatestExchangeRate(ctx.companyId, "USD", "CFA"))?.rate).toBe("615.000000");
    expect((await getLatestExchangeRate(ctx.companyId, "USD", "CFA", "2026-09-15"))?.rate).toBe("600.000000");
    expect((await getLatestCfaPerUsd(ctx.companyId))?.toFixed()).toBe("615");
    expect((await getLatestCfaPerUsd(ctx.companyId, "2026-09-15"))?.toFixed()).toBe("600");
    expect(await getLatestCfaPerUsd(ctx.companyId, "2026-08-01")).toBeNull();
  });
});

describe("deleting a factory currency keeps the rates documents used (decision 2)", () => {
  it("removes only unused manual rates, keeps auto and used ones, audits and reports both", async () => {
    await insertRate("NOK", "0.090", "2026-08-01", "manual"); // a NOK voucher on 2026-08-20 used it
    await insertRate("NOK", "0.092", "2026-09-01", "manual"); // no document from 09-01 to 09-30
    await insertRate("NOK", "0.093", "2026-09-05", "auto"); // recorded: always kept
    await insertRate("NOK", "0.094", "2026-10-01", "manual"); // a POS-style daybook event on 10-02
    await insertRate("NOK", "0.099", "2099-01-01", "manual"); // future, no document
    await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, source_module)
         VALUES ($1, $2, 'Journal', '2026-08-20', 10, 'NOK', 0.09, 'FACTORY')`,
        [ctx.companyId, `${PREFIX}-nok`]
      );
      await client.query(
        `INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, description, currency_code, amount_currency, fx_rate_to_usd, amount_usd)
         VALUES ($1, '2026-10-02', 'POS_SALE', $2, 'NOK', 100, 0.094, 9.40)`,
        [ctx.companyId, `${PREFIX} daybook`]
      );
    });

    await setRole("Admin");
    const removed = await agent.delete("/api/factory/fx-rates/NOK");
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(2);
    expect(removed.body.removedRows.map((row: { effectiveDate: string }) => row.effectiveDate)).toEqual([
      "2026-09-01",
      "2099-01-01",
    ]);
    expect(
      removed.body.kept.map((row: { effectiveDate: string; reason: string }) => [row.effectiveDate, row.reason])
    ).toEqual([
      ["2026-08-01", "used_by_document"],
      ["2026-09-05", "recorded_auto_rate"],
      ["2026-10-01", "used_by_document"],
    ]);
    expect((await factoryRates("NOK")).map((row) => row.date)).toEqual(["2026-08-01", "2026-09-05", "2026-10-01"]);

    const audit = (await auditRows("factory_fx_rates")).filter((row) => row.record_identifier === "NOK");
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.lines.old.map((row: { effectiveDate: string }) => row.effectiveDate)).toEqual([
      "2026-09-01",
      "2099-01-01",
    ]);
    expect(audit[0].changes.keptRows.new).toHaveLength(3);
    await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      await client.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]);
    });
  });
});

describe("wave 6 repair apply (decision 4)", () => {
  const voucherIds: Record<string, number> = {};

  beforeAll(async () => {
    await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      const supplierId = (
        await client.query(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
          ctx.companyId,
          `${PREFIX} supplier`,
        ])
      ).rows[0].id;
      const rate = (currency: string, rateToUsd: string, effectiveDate: string, source: string) =>
        client.query(
          `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.companyId, currency, rateToUsd, effectiveDate, source]
        );
      // DKK: an older manual rate and an auto rate dated exactly on the voucher date.
      await rate("DKK", "0.140", "2026-09-01", "manual");
      await rate("DKK", "0.150", "2026-09-10", "auto");
      // PLN: only an older manual and an older auto rate: manual first, as before.
      await rate("PLN", "0.250", "2026-09-01", "manual");
      await rate("PLN", "0.260", "2026-09-05", "auto");
      const voucher = async (key: string, currency: string, voucherDate: string, effectiveDate: string | null) => {
        const id = (
          await client.query(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount, currency, exchange_rate, source_module)
             VALUES ($1, $2, 'Journal', $3, $4, 100, $5, 1, 'FACTORY') RETURNING id`,
            [ctx.companyId, `${PREFIX}-${key}`, voucherDate, effectiveDate, currency]
          )
        ).rows[0].id;
        voucherIds[key] = id;
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $3, $2, 100, 0)`,
          [id, ctx.cashAccountId, ctx.companyId]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, company_id, factory_supplier_id, debit_amount, credit_amount) VALUES ($1, $3, $2, 0, 100)`,
          [id, supplierId, ctx.companyId]
        );
      };
      // Legacy-shaped lines as history left them: the currency trigger v2 (wave 17 D)
      // refuses a new one, so they are written with the triggers off.
      await client.query("SET LOCAL session_replication_role = replica");
      await voucher("dkk", "DKK", "2026-09-10", null);
      await voucher("pln", "PLN", "2026-09-10", null);
      // Dated in an open month but effective in the closed one.
      await voucher("closed", "PLN", "2026-09-10", "2026-06-15");
      await client.query("SET LOCAL session_replication_role = origin");
      const closingVoucherId = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
           VALUES ($1, $2, 'Journal', '2026-06-30', 0, 'USD', 'FACTORY') RETURNING id`,
          [ctx.companyId, `${PREFIX}-closing`]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
         VALUES ($1, '2026-06-01', '2026-06-30', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
        [ctx.companyId, ctx.userId, closingVoucherId, ctx.cashAccountId]
      );
    });
  }, 60000);

  it("rates a line at the rate dated on the voucher date first, else manual-first, and closes by effective date", async () => {
    const plan = await asMaintenance(() => planFactoryFxLegacyRepair(ctx.companyId));
    const of = (key: string) =>
      plan.lines
        .filter((line) => line.voucherId === voucherIds[key])
        .map((line) => [line.rate, line.rateSource, line.rateEffectiveDate, line.skipReason]);
    expect(of("dkk")).toEqual([
      ["0.1500000000", "dated-auto", "2026-09-10", null],
      ["0.1500000000", "dated-auto", "2026-09-10", null],
    ]);
    expect(of("pln")).toEqual([
      ["0.2500000000", "dated-manual", "2026-09-01", null],
      ["0.2500000000", "dated-manual", "2026-09-01", null],
    ]);
    expect(of("closed").map((line) => line[3])).toEqual(["PERIOD_CLOSED", "PERIOD_CLOSED"]);
  });

  it("refuses an apply without the reviewed planHash (400), and applies with it", async () => {
    await setRole("Admin");
    const without = await agent.post("/api/accounting/factory-fx-repair/apply").send({ confirm: true });
    expect(without.status).toBe(400);
    expect(without.body.code).toBe("FACTORY_FX_REPAIR_PLAN_HASH_REQUIRED");
    await expect(applyFactoryFxLegacyRepair(ctx.companyId, { expectedPlanHash: "" } as never)).rejects.toBeInstanceOf(
      FactoryFxRepairPlanHashRequiredError
    );

    const plan = (await agent.get("/api/accounting/factory-fx-repair")).body;
    const applied = await agent
      .post("/api/accounting/factory-fx-repair/apply")
      .send({ confirm: true, planHash: plan.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body.repairableLines).toBe(4);
    const audit = (await auditRows("voucher_entries")).filter(
      (row) => row.record_identifier === "factory-fx-legacy-repair"
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.planHash).toEqual({ new: plan.planHash });
  });
});
