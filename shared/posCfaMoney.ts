/**
 * Mali POS transaction-currency (CFA) totals. The CFA price the cashier typed
 * is the sale's real price; USD is a translated accounting value. Posting the
 * rounded USD total back through the rate leaves the CFA cash amount a few
 * francs off (700,000 CFA became 700,003.15), so a sale that carries its typed
 * CFA prices posts their exact sum instead.
 */
import Decimal from "decimal.js";

export interface CfaSaleLine {
  quantity: unknown;
  /** USD unit price (create payloads use `rate`, edits and stored lines `sellingPrice`). */
  rate?: unknown;
  sellingPrice?: unknown;
  /** CFA unit price as typed, when the client sent it. */
  originalCurrencyRate?: unknown;
}

function parse(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

const supplied = (line: CfaSaleLine) => parse(line.originalCurrencyRate);
const usdOf = (line: CfaSaleLine) => parse(line.rate ?? line.sellingPrice);
const half = (value: Decimal, places: number) => value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);

/**
 * The exact CFA total of a sale and its USD value at the sale's rate, or null
 * when the sale cannot be trusted to carry its typed CFA prices: a line has no
 * CFA price (older clients, USD-priced edits) or a CFA price that disagrees
 * with the USD price it travelled with. A null result keeps the previous
 * posting (USD total x rate), so a forged CFA price can never move the ledger.
 */
export function exactCfaSaleAmounts(
  lines: readonly CfaSaleLine[],
  exchangeRate: unknown
): { nativeTotal: string; usdTotal: number } | null {
  const rate = parse(exchangeRate);
  if (!rate || !rate.gt(0) || lines.length === 0) return null;
  // The client converts at six decimals; allow exactly that round trip.
  const tolerance = rate.times("0.00000051");
  let native = new Decimal(0);
  for (const line of lines) {
    const quantity = parse(line.quantity);
    const usd = usdOf(line);
    const cfa = supplied(line);
    if (!quantity || !usd || !cfa || !quantity.gt(0) || usd.lt(0) || cfa.lt(0) || cfa.decimalPlaces() > 2) return null;
    if (usd.times(rate).minus(cfa).abs().gt(tolerance)) return null;
    native = native.plus(half(quantity.times(cfa), 2));
  }
  if (!native.gt(0)) return null;
  // The ledger stores the USD value as the six-decimal conversion rounded to cents; match it.
  return { nativeTotal: native.toFixed(2), usdTotal: half(half(native.div(rate), 6), 2).toNumber() };
}

/** Typed CFA prices are round; prefer the roundest price a cent-rounded USD price can stand for. */
const ROUND_STEPS = [1000, 500, 250, 100, 50, 25, 10, 5];

/**
 * Older sales stored the USD unit price rounded to cents, so 40,000 CFA at 605
 * was saved as $66.12 and reads back as 40,002.60. Every whole-franc price in
 * that cent's rounding window gives the same stored USD price; this returns
 * the roundest one. Six-decimal prices are already exact and return null.
 */
function legacyRoundCfaPrice(usd: Decimal, rate: Decimal): Decimal | null {
  if (usd.decimalPlaces() > 2) return null;
  const centre = usd.times(rate);
  const low = usd.minus("0.005").times(rate).ceil();
  const high = usd.plus("0.005").times(rate).floor();
  if (!high.gte(low) || high.minus(low).gt(200)) return null;
  let best: { price: Decimal; rank: number; distance: Decimal } | null = null;
  for (let price = low; price.lte(high); price = price.plus(1)) {
    if (!price.gt(0) || !half(price.div(rate), 2).eq(usd)) continue;
    const rank = ROUND_STEPS.findIndex((step) => price.mod(step).isZero());
    if (rank < 0) continue;
    const distance = price.minus(centre).abs();
    if (!best || rank < best.rank || (rank === best.rank && distance.lt(best.distance))) {
      best = { price, rank, distance };
    }
  }
  return best?.price ?? null;
}

function lineSum(lines: readonly CfaSaleLine[], units: readonly Decimal[]): Decimal {
  return lines.reduce(
    (sum, line, index) => sum.plus(half((parse(line.quantity) ?? new Decimal(0)).times(units[index]), 2)),
    new Decimal(0)
  );
}

/**
 * CFA unit prices of a POSTED sale, for loading it into the edit screen.
 * Lines read back to the price they were sold at. The round reading of cent-rounded
 * legacy prices is used when it agrees with the CFA total the sale posted:
 * exactly, or (older postings were themselves USD x rate) within the rounding
 * those postings could carry. Null when the rate or a stored price is unusable.
 */
export function resolvePostedCfaUnitPrices(
  lines: readonly CfaSaleLine[],
  exchangeRate: unknown,
  postedNativeTotal: unknown
): Decimal[] | null {
  const rate = parse(exchangeRate);
  if (!rate || !rate.gt(0)) return null;
  const usdPrices: Decimal[] = [];
  for (const line of lines) {
    const usd = usdOf(line);
    if (!usd || usd.lt(0)) return null;
    usdPrices.push(usd);
  }
  // A six-decimal price converts back exactly, decimals included (40,000.50 stays 40,000.50);
  // a cent-rounded legacy price is only good to the franc.
  const nearest = lines.map(
    (line, index) => supplied(line) ?? half(usdPrices[index].times(rate), usdPrices[index].decimalPlaces() > 2 ? 2 : 0)
  );
  const round = lines.map(
    (line, index) => supplied(line) ?? legacyRoundCfaPrice(usdPrices[index], rate) ?? nearest[index]
  );
  const posted = parse(postedNativeTotal);
  // Without a posted total there is nothing to check against; round prices are what cashiers type.
  if (!posted) return round;
  if (lineSum(lines, nearest).eq(posted)) return nearest;
  const roundSum = lineSum(lines, round);
  if (roundSum.eq(posted)) return round;
  // A legacy posting is a cent-rounded USD total x rate. POS sales rounded each
  // line to the cent; imported sheets rounded each unit price, so the drift
  // there also grows with the quantity. Allow half a cent for each of both.
  const units = lines.reduce((sum, line) => sum.plus(parse(line.quantity)?.abs() ?? 0), new Decimal(lines.length));
  const legacyDrift = rate.times("0.005").times(units).plus(1);
  return roundSum.minus(posted).abs().lte(legacyDrift) ? round : nearest;
}
