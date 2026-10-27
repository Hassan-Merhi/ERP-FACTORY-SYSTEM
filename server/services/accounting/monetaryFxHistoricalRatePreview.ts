/**
 * Phase 5: report-time effective FX rates as of a selected business date.
 *
 * IMPORTANT: an earlier FX *rate* can be reconstructed from exchange_rates,
 * but the older *account balances* cannot be reconstructed safely from
 * unversioned opening edits/deletions without the historical balance engine.
 * Never expose today's account balances under an older rate as a historic view.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { datedMonetaryRateTx, fxCurrency, fxDay, MonetaryFxError, type MonetaryRate } from "./monetaryFxRates";

type CompanyRow = { base_currency: string | null; display_currency: string | null } & Record<string, unknown>;
type CurrencyRow = { currency: string } & Record<string, unknown>;

export interface FxRateAsOfRow {
  currency: string;
  status: "RESOLVED" | "MISSING";
  rate: MonetaryRate | null;
}

export interface HistoricalFxRatePreview {
  companyId: number;
  businessToday: string;
  requestedAsOf: string;
  valuationMode: "EFFECTIVE_RATE_PREVIEW_ONLY";
  historicalBookUsdLocked: true;
  historicalBalancesRevalued: false;
  rates: FxRateAsOfRow[];
  unresolvedCurrencies: string[];
}

/** Validates date and isolates ALL rate reads to a consistent company snapshot. */
export async function getMonetaryFxHistoricalRatePreview(
  companyId: number,
  requestedDay: string
): Promise<HistoricalFxRatePreview> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new MonetaryFxError("FX_COMPANY_INVALID", "Select a company first", 400);
  }
  const asOf = fxDay(requestedDay);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await assertTransactionCompanyScope(tx, companyId);
    const [company] = resultRows<CompanyRow>(await tx.execute(sql`
      SELECT base_currency, display_currency FROM companies WHERE id = ${companyId}
    `));
    if (!company) throw new MonetaryFxError("FX_COMPANY_NOT_FOUND", "Company not found", 404);
    const businessToday = fxDay(await companyBusinessDate(companyId, tx));
    if (asOf > businessToday) {
      throw new MonetaryFxError(
        "FX_DATE_FUTURE", "Historical FX rate preview cannot use a future business date", 400
      );
    }
    const base = fxCurrency(company.base_currency || "USD");
    if (base !== "USD") {
      throw new MonetaryFxError(
        "FX_BASE_UNSUPPORTED",
        "This company does not yet have a verified non-USD functional-currency ledger policy", 409
      );
    }
    // Include configured display currency even if no rate was ever saved,
    // so that the preview reports a missing rate, not a false USD identity.
    const currencies = new Set<string>();
    const display = String(company.display_currency || "").trim();
    if (display && display.toLowerCase() !== "none") currencies.add(fxCurrency(display));
    const recorded = resultRows<CurrencyRow>(await tx.execute(sql`
      SELECT UPPER(from_currency) AS currency FROM exchange_rates
       WHERE company_id = ${companyId} AND effective_date <= ${asOf}::date
      UNION
      SELECT UPPER(to_currency) AS currency FROM exchange_rates
       WHERE company_id = ${companyId} AND effective_date <= ${asOf}::date
    `));
    for (const row of recorded) currencies.add(fxCurrency(row.currency));
    currencies.delete("USD");
    const rates: FxRateAsOfRow[] = [];
    for (const currency of [...currencies].sort()) {
      // One authoritative resolver: same effective-date/conflict semantics as
      // the current USD valuation; never use a later rate.
      const rate = await datedMonetaryRateTx(tx, companyId, currency, asOf);
      rates.push({ currency, status: rate ? "RESOLVED" : "MISSING", rate });
    }
    return {
      companyId,
      businessToday,
      requestedAsOf: asOf,
      valuationMode: "EFFECTIVE_RATE_PREVIEW_ONLY" as const,
      historicalBookUsdLocked: true as const,
      historicalBalancesRevalued: false as const,
      rates,
      unresolvedCurrencies: rates.filter((row) => row.status === "MISSING").map((row) => row.currency),
    };
  });
}
