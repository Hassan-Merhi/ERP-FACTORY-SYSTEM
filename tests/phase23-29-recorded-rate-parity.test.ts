/**
 * Phases 23–29 integration: the currency trigger v3's recorded rate
 * (erp_recorded_rate, phase 23 DI5/M8) follows the phase 24 resolver rule
 * (fx/rateResolver.ts): the latest rate dated on or before the date; in the
 * factory store a manual rate before an auto rate on the same date; in the
 * company store the direct pair USD→X before the inverse X→USD on the same
 * date; never a later rate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { RECORDED_RATE_FUNCTION_DDL } from "../server/services/accounting/currencyNormalizationGuard";
import { resolveCompanyRecordedRate, resolveFactoryRecordedRate } from "../server/services/accounting/fx/rateResolver";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p2329rate";
let ctx: TestContext;

async function sqlRate(currency: string, date: string, convention: string): Promise<string | null> {
  const { rows } = await pool.query<{ rate: string | null }>(
    `SELECT erp_recorded_rate($1, $2, $3::date, $4)::text AS rate`,
    [ctx.companyId, currency, date, convention]
  );
  return rows[0].rate;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(RECORDED_RATE_FUNCTION_DDL);
  // Company store, EUR: the inverse pair is entered AFTER the direct pair on the same date.
  await pool.query(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES
       ($1, 'USD', 'EUR', 0.80, '2026-05-01'),
       ($1, 'USD', 'EUR', 0.90, '2026-06-01'),
       ($1, 'EUR', 'USD', 1.25, '2026-06-01'),
       ($1, 'USD', 'EUR', 0.95, '2026-07-01')`,
    [ctx.companyId]
  );
  // Factory store, AUD: an auto rate entered after a manual rate on the same date.
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source) VALUES
         ($1, 'AUD', 0.60, '2026-06-01', 'manual'),
         ($1, 'AUD', 0.70, '2026-06-01', 'auto'),
         ($1, 'AUD', 0.65, '2026-06-10', 'auto')`,
      [ctx.companyId]
    );
  });
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [ctx.companyId]);
  });
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("erp_recorded_rate agrees with the phase 24 resolver", () => {
  it.each(["2026-05-15", "2026-06-01", "2026-06-20", "2026-07-01", "2026-04-30"])(
    "company store (TRANSACTION_PER_BASE) on %s",
    async (date) => {
      const resolved = await resolveCompanyRecordedRate(db, ctx.companyId, "EUR", date);
      const fromSql = await sqlRate("EUR", date, "TRANSACTION_PER_BASE");
      if (!resolved) {
        expect(fromSql).toBeNull();
        return;
      }
      expect(Number(fromSql)).toBeCloseTo(Number(resolved.unitsPerUsd), 8);
    }
  );

  it("company store: the direct pair wins on the same date", async () => {
    expect(Number(await sqlRate("EUR", "2026-06-15", "TRANSACTION_PER_BASE"))).toBeCloseTo(0.9, 8);
  });

  it.each(["2026-06-01", "2026-06-05", "2026-06-10", "2026-05-31"])(
    "factory store (BASE_PER_TRANSACTION) on %s",
    async (date) => {
      const resolved = await resolveFactoryRecordedRate(db, ctx.companyId, "AUD", date);
      const fromSql = await sqlRate("AUD", date, "BASE_PER_TRANSACTION");
      if (!resolved) {
        expect(fromSql).toBeNull();
        return;
      }
      expect(Number(fromSql)).toBeCloseTo(Number(resolved.rate), 8);
    }
  );

  it("factory store: manual before auto on the same date, a newer auto rate after it", async () => {
    expect(Number(await sqlRate("AUD", "2026-06-05", "BASE_PER_TRANSACTION"))).toBeCloseTo(0.6, 8);
    expect(Number(await sqlRate("AUD", "2026-06-10", "BASE_PER_TRANSACTION"))).toBeCloseTo(0.65, 8);
  });
});
