/**
 * Read-only cash/bank translation rate lookup.
 *
 * Historical vouchers and openings retain their original USD book values;
 * only a present-day cash/bank snapshot may use these currently effective
 * rates. ERP rates are foreign currency units per 1 USD (not Factory USD/unit).
 */
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";
import { db } from "../../db";
import { getLatestExchangeRate } from "../../storage/accounting/exchange-rates";
import { getLatestCfaPerUsd } from "./latestCfaPerUsd";

export interface CashBankTranslationRates {
  CFA: Decimal | null;
  ZMW: Decimal | null;
}

/**
 * CFA preserves its existing Mali/XOF fallback lookup.
 * ZMW is resolved exclusively for a company configured USD base/ZMW display.
 * Missing or invalid values are represented as null, NEVER as rate = 1.
 */
export async function getCashBankTranslationRates(companyId: number, asOf?: string): Promise<CashBankTranslationRates> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency, displayCurrency: companies.displayCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const isZambiaPair =
    String(company?.baseCurrency ?? "").toUpperCase() === "USD" &&
    String(company?.displayCurrency ?? "").toUpperCase() === "ZMW";

  const [cfa, zmw] = await Promise.all([
    getLatestCfaPerUsd(companyId, asOf),
    isZambiaPair ? getLatestExchangeRate(companyId, "USD", "ZMW", asOf) : Promise.resolve(undefined),
  ]);
  let raw: Decimal | null = null;
  if (zmw?.rate != null) {
    try {
      const parsed = new Decimal(String(zmw.rate));
      if (parsed.isFinite() && parsed.gt(0)) raw = parsed;
    } catch {
      // Invalid stored rate is missing, never an implicit 1:1 conversion.
    }
  }
  return {
    CFA: cfa && cfa.isFinite() && cfa.gt(0) ? cfa : null,
    ZMW: raw && raw.isFinite() && raw.gt(0) ? raw : null,
  };
}
