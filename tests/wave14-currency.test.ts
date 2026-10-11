/**
 * Accounting audit wave 14 (A): currency, against the database.
 *
 *   - Decision 4: the voucher-entry currency normalization trigger
 *     (migrations/20260720_005) is installed by an idempotent, versioned,
 *     fatal boot installer with the migration's exact definition, and the
 *     integrity diagnostic lists it among the database guards.
 *   - Decision 2: saving, changing or deleting an exchange rate is Admin/Owner
 *     (Developer) only and audited with the old and new value.
 *   - Decision 1: the wave 6 legacy repair rates a line whose voucher has no
 *     rate of its own at the factory's confirmed rate on or before the voucher
 *     date (manual first, else auto), shows the rate and its source, leaves a
 *     line with no rate untouched, and its result passes the trigger.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pool } from "../server/db";
import {
  CURRENCY_NORMALIZATION_FUNCTION_DDL,
  CURRENCY_NORMALIZATION_GUARD_VERSION,
  CURRENCY_NORMALIZATION_MIGRATION,
  CURRENCY_NORMALIZATION_TRIGGER,
  CURRENCY_NORMALIZATION_TRIGGER_DDL,
  ensureCurrencyNormalizationGuard,
  installedCurrencyNormalizationVersion,
} from "../server/services/accounting/currencyNormalizationGuard";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import {
  FactoryFxRepairPlanChangedError,
  applyFactoryFxLegacyRepair,
  planFactoryFxLegacyRepair,
} from "../server/services/factory/factoryFxLegacyRepair";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave14cur";
let ctx: TestContext;
let agent: request.SuperAgentTest;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("wave14-currency-test", work);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function auditRows(tableName: string) {
  return (
    await pool.query(
      `SELECT action, record_identifier, changes FROM audit_log WHERE company_id = $1 AND table_name = $2 ORDER BY id`,
      [ctx.companyId, tableName]
    )
  ).rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  // A factory company, so the factory rate routes (/api/factory/fx-rates) resolve it too.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  // The trigger stays installed: it is what every boot (CI included) installs.
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
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

describe("currency normalization installer (decision 4)", () => {
  it("installs the migration's exact definition, idempotently and versioned", async () => {
    // Wave 17 (D): the current definition is v2 (CURRENCY_NORMALIZATION_MIGRATION);
    // v1 stays in migrations/20260720_005.
    const migration = fs.readFileSync(path.join(process.cwd(), CURRENCY_NORMALIZATION_MIGRATION), "utf8");
    expect(squash(migration)).toContain(squash(CURRENCY_NORMALIZATION_FUNCTION_DDL));
    expect(squash(migration)).toContain(`${squash(CURRENCY_NORMALIZATION_TRIGGER_DDL)};`);

    expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
    expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
    expect(await installedCurrencyNormalizationVersion(pool)).toBe(CURRENCY_NORMALIZATION_GUARD_VERSION);
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'voucher_entries'::regclass AND tgname LIKE 'voucher_entries_normalize_currency%'`
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([CURRENCY_NORMALIZATION_TRIGGER]);
  });

  it("is fatal on failure, rolling back and releasing the connection", async () => {
    const release = vi.fn();
    const query = vi.fn(async (text: string) => {
      if (text.includes("information_schema.columns")) {
        return {
          rows: [
            ...["id", "currency", "exchange_rate"].map((c) => ({ name: `vouchers.${c}` })),
            ...[
              "voucher_id",
              "debit_amount",
              "credit_amount",
              "transaction_currency",
              "transaction_debit_amount",
              "transaction_credit_amount",
              "base_debit_amount",
              "base_credit_amount",
              "historical_exchange_rate",
              "rate_convention",
            ].map((c) => ({ name: `voucher_entries.${c}` })),
          ],
        };
      }
      if (/CREATE|DROP|COMMENT/.test(text)) throw new Error("lock timeout");
      return { rows: [] };
    });
    const fakePool = { connect: async () => ({ query, release }) } as never;
    await expect(ensureCurrencyNormalizationGuard(fakePool)).rejects.toThrow(/lock timeout/);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips with a warning, without a transaction, when a required column is missing", async () => {
    const release = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const fakePool = { connect: async () => ({ query, release }) } as never;
    expect(await ensureCurrencyNormalizationGuard(fakePool)).toBe(false);
    expect(query).not.toHaveBeenCalledWith("BEGIN");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is listed by the diagnostic's database_guards_installed", async () => {
    const currencyMissing = async () => {
      const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
      const check = report.checks.find((c) => c.key === "database_guards_installed");
      return ((check?.samples ?? []) as Array<{ missing: string }>)
        .map((row) => row.missing)
        .filter((name) => name.includes("normalize"));
    };
    expect(await currencyMissing()).toEqual([]);
    // An out-of-date version is reported (a comment only: the trigger keeps working)
    // and the installer brings it back.
    await pool.query(`COMMENT ON FUNCTION normalize_voucher_entry_currency_amounts() IS 'outdated'`);
    try {
      expect(await currencyMissing()).toEqual([
        `normalize_voucher_entry_currency_amounts ${CURRENCY_NORMALIZATION_GUARD_VERSION}`,
      ]);
    } finally {
      expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
    }
    expect(await currencyMissing()).toEqual([]);
  });
});

describe("exchange-rate saves (decision 2)", () => {
  const companyRate = (rate: string) => ({
    fromCurrency: "USD",
    toCurrency: "CFA",
    rate,
    effectiveDate: "2026-10-01",
  });

  it("refuses Manager and POS users, and writes nothing", async () => {
    for (const role of ["Manager", "POS"]) {
      await setRole(role);
      expect((await agent.post("/api/exchange-rates").send(companyRate("600"))).status).toBe(403);
      expect((await agent.post("/api/factory/fx-rates").send({ currencyCode: "EUR", rateToUsd: "1.1" })).status).toBe(
        403
      );
      expect((await agent.delete("/api/factory/fx-rates/EUR")).status).toBe(403);
    }
    await setRole("Admin");
    expect((await pool.query(`SELECT 1 FROM exchange_rates WHERE company_id = $1`, [ctx.companyId])).rowCount).toBe(0);
    expect(await auditRows("exchange_rates")).toEqual([]);
  });

  it("saves a company rate for Admin, audited with the old and the new rate", async () => {
    await setRole("Admin");
    expect((await agent.post("/api/exchange-rates").send(companyRate("600"))).status).toBe(200);
    const changed = await agent.post("/api/exchange-rates").send(companyRate("610.5"));
    expect(changed.status).toBe(200);
    expect(
      (await pool.query(`SELECT rate::text FROM exchange_rates WHERE company_id = $1`, [ctx.companyId])).rows
    ).toEqual([{ rate: "610.500000" }]);
    const audit = await auditRows("exchange_rates");
    expect(audit.map((row) => [row.action, row.changes.rate])).toEqual([
      ["create", { old: null, new: "600.000000" }],
      ["update", { old: "600.000000", new: "610.500000" }],
    ]);
  });

  it("saves and deletes factory rates for Admin, audited with the superseded and removed rates", async () => {
    await setRole("Admin");
    const save = (rateToUsd: string, effectiveDate: string) =>
      agent.post("/api/factory/fx-rates").send({ currencyCode: "gbp", rateToUsd, effectiveDate });
    expect((await save("1.25", "2026-09-01")).status).toBe(200);
    expect((await save("1.27", "2026-09-15")).status).toBe(200);
    expect((await agent.delete("/api/factory/fx-rates/GBP")).status).toBe(200);

    const audit = await auditRows("factory_fx_rates");
    expect(audit.map((row) => [row.action, row.record_identifier])).toEqual([
      ["create", "GBP 2026-09-01"],
      ["create", "GBP 2026-09-15"],
      ["delete", "GBP"],
    ]);
    expect(audit[0].changes.rateToUsd).toEqual({ old: null, new: { rate: "1.25000000", effectiveDate: "2026-09-01" } });
    expect(audit[1].changes.rateToUsd).toEqual({
      old: { rate: "1.25000000", effectiveDate: "2026-09-01" },
      new: { rate: "1.27000000", effectiveDate: "2026-09-15" },
    });
    expect(audit[2].changes.lines.old.map((row: { rate: string }) => row.rate)).toEqual(["1.25000000", "1.27000000"]);
    expect(audit[2].changes.lines.new).toBeNull();
  });
});

describe("wave 6 legacy repair at a dated factory rate (decision 1)", () => {
  const voucherIds: Record<string, number> = {};
  let supplierId: number;

  beforeAll(async () => {
    await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      supplierId = (
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
      // EUR: a manual rate before the voucher wins over an auto one; the one after is never used.
      await rate("EUR", "1.10", "2026-09-01", "manual");
      await rate("EUR", "1.20", "2026-09-05", "auto");
      await rate("EUR", "1.30", "2026-09-20", "manual");
      // AUD: only an auto rate before the voucher; the manual one is dated after it.
      await rate("AUD", "0.65", "2026-09-08", "auto");
      await rate("AUD", "0.70", "2026-09-25", "manual");
      // NZD: only a rate dated after the voucher, so no rate at all.
      await rate("NZD", "0.60", "2026-09-30", "manual");

      const voucher = async (key: string, currency: string, voucherRate: string, total: string) => {
        const id = (
          await client.query(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, source_module)
             VALUES ($1, $2, 'Journal', '2026-09-10', $3, $4, $5, 'FACTORY') RETURNING id`,
            [ctx.companyId, `${PREFIX}-${key}`, total, currency, voucherRate]
          )
        ).rows[0].id;
        voucherIds[key] = id;
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $4, $2, $3, 0)`,
          [id, ctx.cashAccountId, total, ctx.companyId]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, company_id, factory_supplier_id, debit_amount, credit_amount) VALUES ($1, $4, $2, 0, $3)`,
          [id, supplierId, total, ctx.companyId]
        );
      };
      // Legacy-shaped lines (native amounts in the USD columns) as history left
      // them: the currency trigger v2 (wave 17 D) refuses a new one, so they are
      // written with the triggers off.
      await client.query("SET LOCAL session_replication_role = replica");
      await voucher("eur", "EUR", "1", "100");
      await voucher("aud", "AUD", "0", "50");
      await voucher("nzd", "NZD", "1", "40");
      await voucher("own", "EUR", "1.15", "10");
    });
  }, 60000);

  it("plans each line at its own or dated rate, with the source, and lists a line with none", async () => {
    const plan = await asMaintenance(() => planFactoryFxLegacyRepair(ctx.companyId));
    const of = (key: string) =>
      plan.lines
        .filter((line) => line.voucherId === voucherIds[key])
        .map((line) => [line.rate, line.rateSource, line.rateEffectiveDate, line.newStoredAmount, line.skipReason]);
    expect(of("eur")).toEqual([
      ["1.1000000000", "dated-manual", "2026-09-01", "110.00", null],
      ["1.1000000000", "dated-manual", "2026-09-01", "110.00", null],
    ]);
    expect(of("aud")).toEqual([
      ["0.6500000000", "dated-auto", "2026-09-08", "32.50", null],
      ["0.6500000000", "dated-auto", "2026-09-08", "32.50", null],
    ]);
    expect(of("nzd")).toEqual([
      ["1.0000000000", null, null, null, "RATE_NOT_SET"],
      ["1.0000000000", null, null, null, "RATE_NOT_SET"],
    ]);
    expect(of("own")).toEqual([
      ["1.1500000000", "line", null, "11.50", null],
      ["1.1500000000", "line", null, "11.50", null],
    ]);
    expect(plan.datedRateLines).toBe(4);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a changed plan, then applies the reviewed one through the trigger, audited, leaving no-rate lines", async () => {
    expect(await installedCurrencyNormalizationVersion(pool)).toBe(CURRENCY_NORMALIZATION_GUARD_VERSION);
    const plan = await asMaintenance(() => planFactoryFxLegacyRepair(ctx.companyId));
    const actor = { userId: ctx.userId, username: `${PREFIX}_testuser` };
    await expect(
      asMaintenance(() => applyFactoryFxLegacyRepair(ctx.companyId, { actor, expectedPlanHash: "0".repeat(64) }))
    ).rejects.toBeInstanceOf(FactoryFxRepairPlanChangedError);

    const applied = await asMaintenance(() =>
      applyFactoryFxLegacyRepair(ctx.companyId, { actor, expectedPlanHash: plan.planHash })
    );
    expect(applied.repairableLines).toBe(6);

    const rows = (
      await asMaintenance(() =>
        pool.query(
          `SELECT v.voucher_number, ve.debit_amount::text AS d, ve.credit_amount::text AS c, ve.transaction_currency AS tc,
                  ve.transaction_debit_amount::text AS td, ve.base_debit_amount::text AS bd,
                  ve.historical_exchange_rate::text AS r, ve.rate_convention AS rc
             FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
            WHERE v.company_id = $1 ORDER BY v.id, ve.id`,
          [ctx.companyId]
        )
      )
    ).rows;
    const of = (key: string) => rows.filter((row) => row.voucher_number === `${PREFIX}-${key}`);
    expect(of("eur").map((row) => [row.d, row.c, row.tc, row.r, row.rc])).toEqual([
      ["110.00", "0.00", "EUR", "1.1000000000", "BASE_PER_TRANSACTION"],
      ["0.00", "110.00", "EUR", "1.1000000000", "BASE_PER_TRANSACTION"],
    ]);
    expect(of("eur")[0]).toMatchObject({ td: "100.000000", bd: "110.000000" });
    expect(of("aud").map((row) => [row.d, row.c, row.r])).toEqual([
      ["32.50", "0.00", "0.6500000000"],
      ["0.00", "32.50", "0.6500000000"],
    ]);
    expect(of("nzd").map((row) => [row.d, row.c, row.tc])).toEqual([
      ["40.00", "0.00", null],
      ["0.00", "40.00", null],
    ]);

    // The repaired lines are what the trigger accepts: re-saving one unchanged passes,
    // a base that contradicts its rate is refused.
    const repairedId = (
      await pool.query(`SELECT id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id LIMIT 1`, [voucherIds.eur])
    ).rows[0].id;
    await withFixtureTransaction(async (client) => {
      await client.query(
        `UPDATE voucher_entries SET base_debit_amount = base_debit_amount, rate_convention = rate_convention WHERE id = $1`,
        [repairedId]
      );
      await expect(
        client.query(`UPDATE voucher_entries SET base_debit_amount = 100 WHERE id = $1`, [repairedId])
      ).rejects.toThrow(/native\/base amounts do not match/);
      // The failed statement aborted the transaction; the helper rolls it back.
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toMatch(/rollback|current transaction is aborted/));

    const audit = await auditRows("voucher_entries");
    const repair = audit.filter((row) => row.record_identifier === "factory-fx-legacy-repair");
    expect(repair).toHaveLength(1);
    expect(repair[0].changes.lines.new.map((line: { rateSource: string }) => line.rateSource).sort()).toEqual([
      "dated-auto",
      "dated-auto",
      "dated-manual",
      "dated-manual",
      "line",
      "line",
    ]);

    const again = await asMaintenance(() => planFactoryFxLegacyRepair(ctx.companyId));
    expect(again.repairableLines).toBe(0);
    expect(again.lines.map((line) => line.skipReason)).toEqual(["RATE_NOT_SET", "RATE_NOT_SET"]);
  });
});
