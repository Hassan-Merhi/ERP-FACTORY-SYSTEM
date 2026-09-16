/**
 * Shared state and helpers for the factoryContainersRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryContainersRoutes.ts.
 */
import Decimal from "decimal.js";
import { RateConvention } from "../../../services/accounting/currencyAmounts";

/**
 * Normalize a factory voucher entry.
 *
 * Factory stores fxRateToUsd in BASE_PER_TRANSACTION convention
 * (USD per foreign unit), while ERP voucher entries persist the historical
 * rate in TRANSACTION_PER_BASE convention (foreign units per USD).
 *
 * Factory supports currencies such as AUD/LBP that are valid in the factory
 * UI but are not part of the narrower general-ERP currency whitelist. Do the
 * factory conversion here using the already-resolved factory FX rate instead
 * of sending the currency through that unrelated whitelist.
 */
export function normFactoryEntry(
  transactionCurrency: string | null | undefined,
  debit: string | number,
  credit: string | number,
  fxRateToUsdFactory: number | string | null | undefined
) {
  const ccy = (transactionCurrency || "USD").trim().toUpperCase();
  const txDebit = new Decimal(debit ?? 0);
  const txCredit = new Decimal(credit ?? 0);

  if (txDebit.lt(0)) throw new Error("transactionDebitAmount must be ≥ 0");
  if (txCredit.lt(0)) throw new Error("transactionCreditAmount must be ≥ 0");

  const debitPositive = txDebit.gt(0);
  const creditPositive = txCredit.gt(0);
  if (debitPositive && creditPositive) {
    throw new Error(
      `A voucher entry cannot have both debit (${txDebit.toFixed()}) and credit (${txCredit.toFixed()}) > 0.`
    );
  }
  if (!debitPositive && !creditPositive) {
    throw new Error("A posted voucher entry must have either debit or credit > 0.");
  }

  let baseDebit: Decimal;
  let baseCredit: Decimal;
  let historicalRate: string;
  let rateConvention: (typeof RateConvention)[keyof typeof RateConvention];

  if (ccy === "USD") {
    baseDebit = txDebit;
    baseCredit = txCredit;
    historicalRate = "1.0000000000";
    rateConvention = RateConvention.IDENTITY;
  } else {
    if (fxRateToUsdFactory === null || fxRateToUsdFactory === undefined || fxRateToUsdFactory === "") {
      throw new Error(`Factory fxRateToUsd for ${ccy} is required.`);
    }

    let factoryRate: Decimal;
    try {
      factoryRate = new Decimal(fxRateToUsdFactory);
    } catch {
      throw new Error(`Factory fxRateToUsd for ${ccy} must be numeric.`);
    }
    if (!factoryRate.isFinite() || factoryRate.lte(0)) {
      throw new Error(`Factory fxRateToUsd for ${ccy} must be a positive finite rate.`);
    }

    // Factory: USD = foreign amount × fxRateToUsd.
    baseDebit = txDebit.times(factoryRate);
    baseCredit = txCredit.times(factoryRate);

    // ERP voucher metadata keeps the inverse historical rate: foreign per USD.
    historicalRate = new Decimal(1).div(factoryRate).toDecimalPlaces(10).toFixed(10);
    rateConvention = RateConvention.TRANSACTION_PER_BASE;
  }

  const transactionDebitAmount = txDebit.toDecimalPlaces(6).toFixed(6);
  const transactionCreditAmount = txCredit.toDecimalPlaces(6).toFixed(6);
  const baseDebitAmount = baseDebit.toDecimalPlaces(6).toFixed(6);
  const baseCreditAmount = baseCredit.toDecimalPlaces(6).toFixed(6);

  return {
    transactionCurrency: ccy,
    transactionDebitAmount,
    transactionCreditAmount,
    baseDebitAmount,
    baseCreditAmount,
    historicalExchangeRate: historicalRate,
    rateConvention,
    debitAmount: baseDebitAmount,
    creditAmount: baseCreditAmount,
  };
}
