/**
 * Read-only 26 October 2026 rental history snapshot for HASSAN PROPERTIES.
 *
 * This is NOT a new payment, a voucher, or an accounting adjustment. It is a
 * dated, voucher-backed selection of real rental allocations from the existing
 * Properties warehouse payment read model. It includes historical ended leases
 * and explicitly excludes later receipts, guarantee releases, and unvouchered
 * billing adjustments. Keep the active-lease Total Paid metric separately
 * available so dated and current totals cannot be confused.
 */
export const HISTORICAL_RENT_CUTOFF = "2026-10-26";
export const HISTORICAL_RENT_CUTOFF_LABEL = "26 Oct 2026";
export const HISTORICAL_RENT_COMPANY = "HASSAN PROPERTIES";

export interface HistoricalRentPayment {
  amount: string | number;
  paymentDate: string;
  voucherId?: number | null;
  postingStatus?: string;
  reconciliationCategory?: string;
}

export function belongsToHistoricalRentSnapshot(payment: HistoricalRentPayment): boolean {
  const category = payment.reconciliationCategory;
  return (
    (category === "ACTIVE_RENT" || category === "ENDED_RENT") &&
    payment.postingStatus === "POSTED" &&
    payment.voucherId != null &&
    String(payment.paymentDate).slice(0, 10) <= HISTORICAL_RENT_CUTOFF
  );
}

export function historicalRentSnapshotTotal(payments: HistoricalRentPayment[]): number {
  return payments
    .filter(belongsToHistoricalRentSnapshot)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}
