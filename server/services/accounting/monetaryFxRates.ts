/**
 * Phase 5: one as-of FX read boundary shared by ERP, Factory and Rentals.
 *
 * exchange_rates is company-scoped. A USD -> EUR rate in ERP means EUR per
 * USD, while a EUR -> USD rate means USD per EUR. Factory raw-material USD
 * per currency conventions remain in their separate factory_fx_rates service.
 *
 * No fallbacks to current/future rates, Internet rates or a guessed 1.
 * The company's existing saved rate is the only authority.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";

export type MonetaryCurrency = string;
export class MonetaryFxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "MonetaryFxError";
  }
}
export function fxCurrency(value: string): MonetaryCurrency {
  const input = String(value ?? "")
    .trim()
    .toUpperCase();
  const normalized = input === "XOF" ? "CFA" : input;
  if (!/^[A-Z]{3}$/.test(normalized))
    throw new MonetaryFxError("FX_CURRENCY_INVALID", "Currency must be a three-letter currency code", 400);
  return normalized;
}
export function fxDay(value: string): string {
  const d = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new MonetaryFxError("FX_DATE_INVALID", "Use YYYY-MM-DD", 400);
  const parsed = new Date(d + "T00:00:00Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== d)
    throw new MonetaryFxError("FX_DATE_INVALID", "Invalid effective date", 400);
  return d;
}
export interface MonetaryRate {
  currency: string;
  baseCurrency: string;
  effectiveDate: string;
  rateBasePerUnit: string;
  rateUnitPerBase: string;
  source: "IDENTITY" | "DIRECT_RECORDED" | "INVERSE_RECORDED";
  rateId: number | null;
}
interface RateRow extends Record<string, unknown> {
  id: number;
  from_currency: string;
  to_currency: string;
  rate: string;
  effective_date: string;
}
const decimal = (v: unknown) => new Decimal(String(v));
export async function datedMonetaryRateTx(
  tx: DbTransaction,
  companyId: number,
  currencyCode: string,
  day: string
): Promise<MonetaryRate | null> {
  await assertTransactionCompanyScope(tx, companyId);
  const code = fxCurrency(currencyCode),
    date = fxDay(day);
  const cc = resultRows<{ base_currency: string | null } & Record<string, unknown>>(
    await tx.execute(sql`
    SELECT base_currency FROM companies WHERE id=${companyId}
  `)
  )[0];
  if (!cc) throw new MonetaryFxError("FX_COMPANY_NOT_FOUND", "Company does not exist", 404);
  // The existing voucher currency normalizer records USD as the base.
  // Non-USD functional currencies must have their own full monetary ledger
  // implementation before use in this USD-denominated report.
  const base = fxCurrency(cc.base_currency || "USD");
  if (base !== "USD")
    throw new MonetaryFxError(
      "FX_BASE_UNSUPPORTED",
      "Non-USD functional currency requires an explicit accounting conversion policy"
    );
  if (code === base)
    return {
      currency: code,
      baseCurrency: base,
      effectiveDate: date,
      rateBasePerUnit: "1.0000000000",
      rateUnitPerBase: "1.0000000000",
      source: "IDENTITY",
      rateId: null,
    };
  const rows = resultRows<RateRow>(
    await tx.execute(sql`
    SELECT id,UPPER(from_currency) AS from_currency,
      UPPER(to_currency) AS to_currency,rate::text,
      effective_date::text
    FROM exchange_rates
    WHERE company_id=${companyId} AND effective_date<=${date}::date
      AND ((UPPER(from_currency)='USD' AND UPPER(to_currency)=${code})
        OR (UPPER(from_currency)=${code} AND UPPER(to_currency)='USD')
        OR (${code}='CFA' AND ((UPPER(from_currency)='USD' AND UPPER(to_currency)='XOF')
          OR (UPPER(from_currency)='XOF' AND UPPER(to_currency)='USD'))))
    ORDER BY effective_date DESC,id DESC
    LIMIT 10
  `)
  );
  const byDate = rows.filter((r) => r.effective_date === rows[0]?.effective_date);
  // Multiple same-day opposite-direction rates may contradict; do not choose
  // whichever row the database happened to return first.
  const rates = byDate.map((r) => {
    const n = decimal(r.rate);
    if (!n.isFinite() || n.lte(0))
      throw new MonetaryFxError("FX_RATE_INVALID", "The stored exchange rate must be positive and finite");
    const direct = r.from_currency === "USD";
    const basePer = direct ? new Decimal(1).div(n) : n;
    return { r, basePer, direct };
  });
  if (!rates.length) return null;
  if (rates.some((r) => r.basePer.minus(rates[0].basePer).abs().gt("0.00000001")))
    throw new MonetaryFxError(
      "FX_RATE_CONFLICT",
      "Opposite-direction FX rates saved on the same day disagree; resolve them before reporting"
    );
  const picked = rates[0];
  // Preserve the stored direction and precision. Deriving the direct
  // USD->CFA rate back from a rounded reciprocal loses precision on large
  // amounts, even though the display rate only has ten decimal places.
  const storedRate = decimal(picked.r.rate);
  return {
    currency: code,
    baseCurrency: base,
    effectiveDate: picked.r.effective_date,
    rateBasePerUnit: picked.direct
      ? new Decimal(1).div(storedRate).toDecimalPlaces(10).toFixed(10)
      : storedRate.toDecimalPlaces(10).toFixed(10),
    rateUnitPerBase: picked.direct
      ? storedRate.toDecimalPlaces(10).toFixed(10)
      : new Decimal(1).div(storedRate).toDecimalPlaces(10).toFixed(10),
    source: picked.direct ? "DIRECT_RECORDED" : "INVERSE_RECORDED",
    rateId: Number(picked.r.id),
  };
}
export function translateMonetaryAmount(nativeAmount: string, rate: MonetaryRate): string {
  const n = decimal(nativeAmount);
  if (!n.isFinite()) throw new MonetaryFxError("FX_AMOUNT_INVALID", "Invalid original currency amount", 400);
  // For the direct USD->foreign convention, divide by the exact recorded
  // foreign-per-USD rate, not the rounded presentation reciprocal.
  const usd = rate.source === "DIRECT_RECORDED" ? n.div(rate.rateUnitPerBase) : n.times(rate.rateBasePerUnit);
  return usd.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}
