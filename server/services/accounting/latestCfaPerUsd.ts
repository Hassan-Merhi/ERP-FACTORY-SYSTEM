import type Decimal from "decimal.js";

import { db } from "../../db";
import { toMoney } from "../../lib/money";
import { companyBusinessDate } from "./companyBusinessDate";
import { resolveCompanyPairRate } from "./fx/rateResolver";

/**
 * The company's latest USD→CFA rate (CFA per USD) dated on or before `asOf`
 * (default: the company's business date), or null when there is none or it is
 * not positive. Shared by the cash/bank revaluation and the cash account
 * summary; a rate dated after the as-of date is never used (wave 17 C, owner
 * decision 3). Phase 24 (M1): read through the one resolver (USD→CFA or
 * USD→XOF, latest date first).
 */
export async function getLatestCfaPerUsd(companyId: number, asOf?: string): Promise<Decimal | null> {
  const cutoff = asOf ?? (await companyBusinessDate(companyId));
  const found = await resolveCompanyPairRate(db, companyId, "USD", "CFA", cutoff);
  if (!found?.rate) return null;
  const rate = toMoney(found.rate);
  return rate.gt(0) ? rate : null;
}
