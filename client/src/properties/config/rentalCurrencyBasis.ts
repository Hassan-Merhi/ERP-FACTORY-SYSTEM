/**
 * Currency evidence for read-only rental totals and USD-labelled exports.
 * Missing currency is unknown, not proof of USD. Never infer FX conversions.
 * Historical rows must be independently verified before restoring any
 * legacy missing-currency exception.
 */
export type RentalCurrencyEvidence = "USD" | "NON_USD" | "UNKNOWN";

export function rentalCurrencyEvidence(currency: string | null | undefined): RentalCurrencyEvidence {
  const recorded = currency?.trim().toUpperCase();
  if (!recorded) return "UNKNOWN";
  return recorded === "USD" ? "USD" : "NON_USD";
}

export function hasVerifiedUsdBasis(rows: readonly { currency?: string | null }[]): boolean {
  return rows.every((row) => rentalCurrencyEvidence(row.currency) === "USD");
}
