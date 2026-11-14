/** Reporting-only book-basis tolerance for live monetary translation. */
import Decimal from "decimal.js";
import type { MonetaryFxValuationRow } from "./monetaryFxValuationService";

/** Display rounding tolerance between a report row and the valuation's book figure. */
export const BOOK_MATCH_TOLERANCE = "0.03";

/**
 * A report row may present the same posted lines on either book basis: the
 * historical base amounts (6 dp, Net Position) or the posted debit/credit
 * amounts (2 dp per line, the balance engine's `closing` used by the Accounts
 * list, the Customers list and the Factory Net Position). Both are the same
 * ledger; neither is a translated figure. A row is replaced only when its
 * signed value equals one of them within display rounding.
 */
export function reportRowMatchesBook(signedRowValue: Decimal, val: MonetaryFxValuationRow): boolean {
  if (!signedRowValue.isFinite()) return false;
  const candidates = [val.historicalBaseUsd, val.bookClosingUsd];
  return candidates.some((book) => {
    if (book === null || book === undefined) return false;
    const decimal = new Decimal(book);
    return decimal.isFinite() && decimal.minus(signedRowValue).abs().lte(BOOK_MATCH_TOLERANCE);
  });
}
