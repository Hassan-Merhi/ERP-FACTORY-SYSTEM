/**
 * Phase 2: monetary FX valuation POLICY and pure Decimal conversion.
 *
 * This is deliberately not a journal posting service. Historical USD postings
 * and original native amounts never change when an effective FX rate changes.
 */
import Decimal from "decimal.js";
import { normalizeAccountingCurrencyAlias } from "@shared/currencyCatalog";

export type MonetaryFxKind = "ledger" | "bank" | "customer";
export type MonetaryFxCategory = "cash_bank" | "customer" | "monetary_asset" | "loan";
export type MonetaryFxEligibility = MonetaryFxCategory | "needs_review" | "excluded";

export interface MonetaryFxCandidate {
  kind: MonetaryFxKind;
  id: number;
  accountType: string | null;
  subType: string | null;
  code: string | null;
  name: string;
}

/** An approved *company-scoped* monetary-asset code registry, never an inferred name match. */
export interface MonetaryFxEligibilityOptions {
  approvedMonetaryAssetCodes?: ReadonlySet<string>;
}

const norm = (input: string | null | undefined) => (input ?? "").trim().toLowerCase();
const normCode = (input: string | null | undefined) => (input ?? "").trim().toUpperCase();

/** Includes system perpetual stock, production, clearing and non-monetary asset codes. */
const NON_MONETARY_CODES = new Set([
  "INVENTORY", "GOODS_IN_TRANSIT", "FACTORY_RAW_MATERIAL_STOCK", "FACTORY_WIP",
  "FACTORY_FINISHED_GOODS", "CLOSING_STOCK", "OPENING_STOCK", "STOCK",
  "STOCK_IN_HAND", "PURCHASES", "PRODUCTION_ADJUSTMENT", "CONSUMPTION_EXPENSE",
]);

export function monetaryFxEligibility(
  candidate: MonetaryFxCandidate,
  options: MonetaryFxEligibilityOptions = {}
): MonetaryFxEligibility {
  if (candidate.kind === "customer") return "customer";
  if (candidate.kind === "bank") return "cash_bank";

  const type = norm(candidate.accountType);
  const subType = norm(candidate.subType);
  const code = normCode(candidate.code);
  const name = norm(candidate.name);
  if (
    NON_MONETARY_CODES.has(code) ||
    /^(INVENTORY|STOCK|PURCHASES|FACTORY_WIP|FACTORY_RAW_MATERIAL_STOCK)_/.test(code) ||
    /\b(inventory|raw material|stock on hand|stock in hand|work in progress|fixed asset)\b/.test(name)
  ) return "excluded";

  // Explicit types only: arbitrary 'Liability', 'Agent', 'Intercompany',
  // 'Supplier' and 'Asset' cannot be assumed to be a monetary loan.
  if (type === "cash" || type === "bank") return "cash_bank";
  if (type === "loan" || type === "loans") return "loan";
  if (!type && (subType === "cash" || subType === "bank")) return "cash_bank";
  if (!type && (subType === "loan" || subType === "loans")) return "loan";

  if (type === "asset" || type === "current asset" || (!type && (subType === "asset" || subType === "current asset"))) {
    return options.approvedMonetaryAssetCodes?.has(code) ? "monetary_asset" : "needs_review";
  }
  return "excluded";
}

export type MonetaryFxRateDirection = "FOREIGN_PER_USD" | "USD_PER_FOREIGN";
export interface MonetaryFxRate {
  currency: string;
  rate: string;
  direction: MonetaryFxRateDirection;
  effectiveDate: string;
}
export type MonetaryFxRateMap = ReadonlyMap<string, MonetaryFxRate>;

export function canonicalMonetaryCurrency(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeAccountingCurrencyAlias(value);
  // Unsupported or unparseable currency evidence is not a rate lookup request.
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

export interface MonetaryFxCalculation {
  nativeBalancesByCurrency: Record<string, string>;
  currentTranslatedUsd: string | null;
  historicalBaseUsd: string | null;
  translationDifferenceUsd: string | null;
  unresolvedCurrencies: string[];
  provisional: boolean;
}

/**
 * Returns current USD translation, or NULL (never a misleading fallback) for
 * missing/invalid rates or unproven original-currency evidence.
 * Input map and historical book USD must already be assembled by the canonical
 * ledger attribution/one-opening collector. Neither is mutated.
 */
export function translateMonetaryFxBalance(
  nativeAmounts: ReadonlyMap<string, Decimal>,
  historicalBaseUsd: Decimal | null,
  rates: MonetaryFxRateMap,
  evidenceUnresolved = false
): MonetaryFxCalculation {
  const nativeBalancesByCurrency: Record<string, string> = {};
  const unresolvedCurrencies: string[] = [];
  let total = new Decimal(0);
  for (const [untrustedCode, amount] of nativeAmounts.entries()) {
    const currency = canonicalMonetaryCurrency(untrustedCode);
    if (!amount.isFinite() || !currency) {
      unresolvedCurrencies.push(untrustedCode || "UNKNOWN");
      continue;
    }
    if (amount.isZero()) continue;
    nativeBalancesByCurrency[currency] = new Decimal(nativeBalancesByCurrency[currency] ?? 0)
      .plus(amount).toDecimalPlaces(6).toFixed(6);
    if (currency === "USD") {
      total = total.plus(amount);
      continue;
    }
    const quote = rates.get(currency);
    if (!quote || canonicalMonetaryCurrency(quote.currency) !== currency) {
      unresolvedCurrencies.push(currency);
      continue;
    }
    let rate: Decimal;
    try {
      rate = new Decimal(quote.rate);
    } catch {
      unresolvedCurrencies.push(currency);
      continue;
    }
    if (!rate.isFinite() || !rate.gt(0)) {
      unresolvedCurrencies.push(currency);
      continue;
    }
    if (quote.direction === "FOREIGN_PER_USD") total = total.plus(amount.div(rate));
    else if (quote.direction === "USD_PER_FOREIGN") total = total.plus(amount.mul(rate));
    else unresolvedCurrencies.push(currency);
  }

  const provisional = evidenceUnresolved || unresolvedCurrencies.length > 0 || historicalBaseUsd === null ||
    !historicalBaseUsd.isFinite();
  return {
    nativeBalancesByCurrency,
    currentTranslatedUsd: provisional ? null : total.toDecimalPlaces(6).toFixed(6),
    historicalBaseUsd: historicalBaseUsd?.isFinite() ? historicalBaseUsd.toDecimalPlaces(6).toFixed(6) : null,
    translationDifferenceUsd: provisional || historicalBaseUsd === null
      ? null : total.minus(historicalBaseUsd).toDecimalPlaces(6).toFixed(6),
    unresolvedCurrencies: [...new Set(unresolvedCurrencies)],
    provisional,
  };
}
