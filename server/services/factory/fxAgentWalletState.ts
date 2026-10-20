/**
 * Native agent wallet projection. This NEVER edits an existing USD ledger amount.
 * The booked-USD basis travels with the EUR units, while Settings determines
 * their CURRENT USD display value only.
 */
import { toMoney } from "../../lib/money";

export type FxAgentWalletEvent = {
  kind: "USD_TO_EUR" | "EUR_SETTLEMENT" | "EUR_TO_USD_REVERSAL";
  sourceAmount: string;
  targetAmount: string;
  sourceBookUsd: string;
};

export type FxAgentWalletState = {
  usd: string;
  eur: string;
  eurBookUsd: string;
  totalBookUsd: string;
};

export function replayFxAgentWallet(openingUsd: string, events: readonly FxAgentWalletEvent[]): FxAgentWalletState {
  let usd = toMoney(openingUsd);
  let eur = toMoney(0);
  let eurBookUsd = toMoney(0);
  if (usd.lt(0)) throw new Error("Negative wallet opening balance");
  for (const event of events) {
    const from = toMoney(event.sourceAmount);
    const to = toMoney(event.targetAmount);
    const book = toMoney(event.sourceBookUsd);
    if (from.lte(0) || to.lte(0) || book.lt(0)) throw new Error("Invalid FX agent operation");
    if (event.kind === "USD_TO_EUR") {
      if (!book.eq(from) || from.gt(usd)) throw new Error("USD wallet has insufficient balance");
      usd = usd.minus(from);
      eur = eur.plus(to);
      eurBookUsd = eurBookUsd.plus(book);
    } else if (event.kind === "EUR_TO_USD_REVERSAL") {
      // Compensating, immutable event: restore precisely the original USD
      // book basis, not a fresh market-rate quote.
      if (from.gt(eur) || book.gt(eurBookUsd) || !book.eq(to)) {
        throw new Error("EUR wallet has insufficient balance for reversal");
      }
      eur = eur.minus(from);
      eurBookUsd = eurBookUsd.minus(book);
      usd = usd.plus(to);
      if (eur.isZero() && !eurBookUsd.isZero()) throw new Error("Unallocated final EUR book basis");
    } else if (event.kind === "EUR_SETTLEMENT") {
      if (from.gt(eur) || book.gt(eurBookUsd)) throw new Error("EUR wallet has insufficient balance");
      eur = eur.minus(from);
      eurBookUsd = eurBookUsd.minus(book);
      // Consuming the last EUR must consume the last bit of booked USD basis.
      if (eur.isZero() && !eurBookUsd.isZero()) throw new Error("Unallocated final EUR book basis");
    } else {
      throw new Error("Unsupported FX agent wallet event");
    }
  }
  return {
    usd: usd.toFixed(6),
    eur: eur.toFixed(6),
    eurBookUsd: eurBookUsd.toFixed(6),
    totalBookUsd: usd.plus(eurBookUsd).toFixed(6),
  };
}

export function conversionPreview(usdAmount: string, rateUsdPerEur: string) {
  const from = toMoney(usdAmount);
  const rate = toMoney(rateUsdPerEur);
  if (from.lte(0) || rate.lte(0)) throw new Error("Conversion amount and rate must be positive");
  const eur = from.div(rate).toDecimalPlaces(6);
  if (eur.lte(0)) throw new Error("EUR amount below supported precision");
  return { usd: from.toFixed(6), eur: eur.toFixed(6), rate: rate.toFixed(10) };
}

export function settlementPreview(
  eurAmount: string,
  rateUsdPerEur: string,
  state: Pick<FxAgentWalletState, "eur" | "eurBookUsd">
) {
  const from = toMoney(eurAmount);
  const rate = toMoney(rateUsdPerEur);
  const eurBalance = toMoney(state.eur);
  const bookBalance = toMoney(state.eurBookUsd);
  if (from.lte(0) || rate.lte(0) || from.gt(eurBalance) || eurBalance.lte(0)) {
    throw new Error("Invalid EUR settlement or insufficient funds");
  }
  const paid = from.times(rate).toDecimalPlaces(2);
  if (paid.lte(0)) throw new Error("USD payout below supported precision");
  const book = from.eq(eurBalance) ? bookBalance : bookBalance.times(from).div(eurBalance).toDecimalPlaces(6);
  const gain = paid.minus(book);
  return {
    eur: from.toFixed(6),
    usd: paid.toFixed(2),
    bookUsd: book.toFixed(6),
    gainUsd: gain.toFixed(6),
    rate: rate.toFixed(10),
  };
}

export function walletCurrentUsd(state: FxAgentWalletState, rateUsdPerEur: string): string {
  const rate = toMoney(rateUsdPerEur);
  if (rate.lte(0)) throw new Error("Current EUR rate is missing");
  return toMoney(state.usd).plus(toMoney(state.eur).times(rate)).toFixed(2);
}
