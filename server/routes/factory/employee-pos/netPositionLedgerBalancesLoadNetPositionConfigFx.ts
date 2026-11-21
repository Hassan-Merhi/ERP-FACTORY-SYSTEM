// Extracted from ./netPositionLedgerBalances.ts
import { netPositionRecordedThrough } from "../../../services/factory/netPositionAsOf";
import { db } from "../../../db";
import { sql } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import type { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";
import type { loadFactoryHistoricalCoverage } from "../../../services/factory/netPositionHistoryCoverage";

export type LoadFactoryHistoricalCoverageResult = Awaited<ReturnType<typeof loadFactoryHistoricalCoverage>>;

export type LoadFactoryNetPositionEmployeesResult = Awaited<ReturnType<typeof loadFactoryNetPositionEmployees>>;

export type LoadNetPositionConfigFxResult = Awaited<ReturnType<typeof loadNetPositionConfigFx>>;

export async function loadNetPositionConfigFx({
  companyId,
  asOf,
  asOfContext,
}: {
  companyId: number;
  asOf: string;
  asOfContext: FactoryNetPositionAsOf;
}) {
  // Load user-configured display FX rates (set in Settings → FX Rates)
  const fxRateRows = await db.execute(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual' AND effective_date <= ${asOf}::date
          ${
            asOfContext.isHistorical
              ? sql`AND ${netPositionRecordedThrough(sql`created_at`, asOfContext, "utc-naive-timestamp")}`
              : sql``
          }
        ORDER BY currency_code, effective_date DESC, created_at DESC, id DESC
      `);
  const configFxRates: Record<string, number> = {};
  for (const row of fxRateRows.rows) {
    const currency = String(row.currency_code ?? "")
      .trim()
      .toUpperCase();
    if (currency) configFxRates[currency] = toMoney(row.rate_to_usd as string).toNumber();
  }
  // Only use manually configured rates — no hardcoded fallbacks
  const getConfigFx = (cc: string): number => {
    const currency = cc.trim().toUpperCase();
    if (currency === "USD") return 1;
    const rate = configFxRates[currency];
    if (!rate || !Number.isFinite(rate) || rate <= 0) throw new Error(`Missing confirmed USD exchange rate for ${cc}`);
    return rate;
  };

  return { configFxRates, getConfigFx };
}
