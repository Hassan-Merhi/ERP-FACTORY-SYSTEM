import type Decimal from "decimal.js";
import { and, desc, eq, lte, or } from "drizzle-orm";
import { exchangeRates } from "@shared/schema";

import { db } from "../../db";
import { toMoney } from "../../lib/money";
import { companyBusinessDate } from "./companyBusinessDate";

/**
 * The company's latest USD→CFA rate (CFA per USD) dated on or before `asOf`
 * (default: the company's business date), or null when there is none or it is
 * not positive. Shared by the cash/bank revaluation and the cash account
 * summary; a rate dated after the as-of date is never used (wave 17 C, owner
 * decision 3).
 */
export async function getLatestCfaPerUsd(companyId: number, asOf?: string): Promise<Decimal | null> {
  const cutoff = asOf ?? (await companyBusinessDate(companyId));
  const rows = await db
    .select({ rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        lte(exchangeRates.effectiveDate, cutoff),
        or(
          and(eq(exchangeRates.fromCurrency, "USD"), eq(exchangeRates.toCurrency, "CFA")),
          and(eq(exchangeRates.fromCurrency, "USD"), eq(exchangeRates.toCurrency, "XOF"))
        )
      )
    )
    .orderBy(desc(exchangeRates.effectiveDate), desc(exchangeRates.id))
    .limit(1);

  if (!rows[0]?.rate) return null;
  const rate = toMoney(rows[0].rate);
  return rate.gt(0) ? rate : null;
}
