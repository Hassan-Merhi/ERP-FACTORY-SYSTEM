import Decimal from "decimal.js";
import { pool } from "../../db";
import { normalizeCurrencyCode } from "./currencyAmounts";

const RATE_CONVENTION = "TRANSACTION_PER_BASE";

export interface NetPositionCurrencySummary {
  rateConvention: typeof RATE_CONVENTION;
  nativeDebitByCurrency: Record<string, string>;
  nativeCreditByCurrency: Record<string, string>;
  historicalBaseDebitTotal: string;
  historicalBaseCreditTotal: string;
  unresolvedLegacyEntryCount: number;
  unresolvedLegacyRawNet: string;
  totalsProvisional: boolean;
  provisionalReason: "UNRESOLVED_LEGACY_CURRENCY" | null;
}

function decimal(value: unknown): Decimal {
  try {
    const parsed = new Decimal(value == null ? 0 : String(value));
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function normalizeCurrency(value: unknown): string {
  const raw = String(value || "USD").toUpperCase();
  try {
    return normalizeCurrencyCode(raw);
  } catch {
    return raw;
  }
}

function formatMap(values: Map<string, Decimal>): Record<string, string> {
  return Object.fromEntries(
    [...values.entries()]
      // USD is the historical base bucket, not a native/foreign-currency balance.
      // Keeping it out of this map prevents every normal USD company from
      // rendering the multi-currency dashboard summary.
      .filter(([currency, value]) => currency !== "USD" && !value.isZero())
      .map(([currency, value]) => [currency, value.toDecimalPlaces(6).toFixed(6)])
  );
}

/**
 * Report-level currency provenance. This is intentionally separate from the
 * signed Net Position scalar: legacy consumers keep that field, while this
 * contract prevents the UI and integrations from treating mixed native
 * currencies as one reliable amount.
 */
export async function getNetPositionCurrencySummary(
  companyId: number,
  toDate?: string | null
): Promise<NetPositionCurrencySummary> {
  const params: unknown[] = [companyId];
  const dateClause = toDate ? `AND v.voucher_date <= $2::date` : "";
  if (toDate) params.push(toDate);

  const result = await pool.query<{
    currency: string;
    native_debit: string;
    native_credit: string;
    base_debit: string;
    base_credit: string;
    unresolved_count: string;
    unresolved_raw_net: string;
  }>(
    `SELECT
       CASE
         WHEN ve.base_debit_amount IS NOT NULL
           AND ve.base_credit_amount IS NOT NULL
           AND ve.transaction_currency IS NOT NULL
           THEN UPPER(ve.transaction_currency)
         WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN 'USD'
         ELSE '__UNRESOLVED_LEGACY__'
       END AS currency,
       SUM(CASE
         WHEN ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL
           THEN COALESCE(ve.transaction_debit_amount, ve.debit_amount)::numeric
         WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN ve.debit_amount::numeric
         ELSE 0 END)::text AS native_debit,
       SUM(CASE
         WHEN ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL
           THEN COALESCE(ve.transaction_credit_amount, ve.credit_amount)::numeric
         WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN ve.credit_amount::numeric
         ELSE 0 END)::text AS native_credit,
       SUM(CASE
         WHEN ve.base_debit_amount IS NOT NULL THEN ve.base_debit_amount::numeric
         WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN ve.debit_amount::numeric
         ELSE 0 END)::text AS base_debit,
       SUM(CASE
         WHEN ve.base_credit_amount IS NOT NULL THEN ve.base_credit_amount::numeric
         WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN ve.credit_amount::numeric
         ELSE 0 END)::text AS base_credit,
       SUM(CASE
         WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
           AND COALESCE(UPPER(v.currency), 'USD') <> 'USD' THEN 1 ELSE 0 END)::text AS unresolved_count,
       SUM(CASE
         WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
           AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
           THEN (ve.debit_amount::numeric - ve.credit_amount::numeric)
         ELSE 0 END)::text AS unresolved_raw_net
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${dateClause}
     GROUP BY 1`,
    params
  );

  const nativeDebit = new Map<string, Decimal>();
  const nativeCredit = new Map<string, Decimal>();
  let historicalDebit = new Decimal(0);
  let historicalCredit = new Decimal(0);
  let unresolvedCount = 0;
  let unresolvedRawNet = new Decimal(0);

  for (const row of result.rows) {
    if (row.currency === "__UNRESOLVED_LEGACY__") {
      unresolvedCount += Number.parseInt(row.unresolved_count || "0", 10) || 0;
      unresolvedRawNet = unresolvedRawNet.plus(decimal(row.unresolved_raw_net));
      continue;
    }
    const currency = normalizeCurrency(row.currency);
    nativeDebit.set(currency, (nativeDebit.get(currency) || new Decimal(0)).plus(decimal(row.native_debit)));
    nativeCredit.set(currency, (nativeCredit.get(currency) || new Decimal(0)).plus(decimal(row.native_credit)));
    historicalDebit = historicalDebit.plus(decimal(row.base_debit));
    historicalCredit = historicalCredit.plus(decimal(row.base_credit));
  }

  return {
    rateConvention: RATE_CONVENTION,
    nativeDebitByCurrency: formatMap(nativeDebit),
    nativeCreditByCurrency: formatMap(nativeCredit),
    historicalBaseDebitTotal: historicalDebit.toDecimalPlaces(6).toFixed(6),
    historicalBaseCreditTotal: historicalCredit.toDecimalPlaces(6).toFixed(6),
    unresolvedLegacyEntryCount: unresolvedCount,
    unresolvedLegacyRawNet: unresolvedRawNet.toDecimalPlaces(6).toFixed(6),
    totalsProvisional: unresolvedCount > 0,
    provisionalReason: unresolvedCount > 0 ? "UNRESOLVED_LEGACY_CURRENCY" : null,
  };
}
