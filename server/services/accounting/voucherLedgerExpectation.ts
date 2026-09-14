/**
 * What ledger evidence a voucher type owes.
 *
 * Convergence reconciliation started from one assumption — every voucher posts
 * a balanced double entry whose sides each equal the document total — and that
 * is not true for every persisted document shape. Each type states what it
 * actually posts, and a type nobody has classified is reported rather than
 * quietly skipped.
 *
 * "balanced"        Debits equal credits, and each side equals the document total.
 * "balanced-only"   Debits equal credits, but the document header is not the
 *                   ledger-side total. Credit/Debit Notes are the important case:
 *                   the refund/receipt header can differ from inventory cost and
 *                   the variance account makes the ledger balance at cost value.
 * "single-sided"    Exactly one GL side is posted. Inventory is the contra side.
 * "inventory-sided" One or both GL sides can be posted and inventory carries the
 *                   net contra. Mixed production/consumption documents use this.
 * "none"            The document posts no ledger entry at all; stock evidence is
 *                   reconciled separately.
 */
export type VoucherLedgerExpectation =
  "balanced" | "balanced-only" | "single-sided" | "inventory-sided" | "none" | "unclassified";

/**
 * Evidence for each classification comes from the writers, not from whichever
 * rows happen to exist in production today.
 */
const VOUCHER_LEDGER_EXPECTATIONS: Record<string, VoucherLedgerExpectation> = {
  Journal: "balanced",
  Payment: "balanced",
  Receipt: "balanced",
  Sales: "balanced",
  Purchase: "balanced",
  "Credit Note": "balanced-only",
  "Debit Note": "balanced-only",
  "Stock Adjustment": "single-sided",
  Production: "single-sided",
  Consumption: "single-sided",
  Mixed: "inventory-sided",
  "Stock Transfer": "none",
  StockTransfer: "none",
  Transfer: "none",
};

/**
 * Classifies a voucher type. An unrecognised type is "unclassified" rather than
 * assumed harmless: the reconciler reports it, so a newly introduced posting
 * path cannot silently escape accounting checks.
 */
export function classifyVoucherLedgerExpectation(voucherType: unknown): VoucherLedgerExpectation {
  const key = String(voucherType ?? "").trim();
  if (!key) return "unclassified";
  return VOUCHER_LEDGER_EXPECTATIONS[key] ?? "unclassified";
}

/** The classified types, for tests and documentation. */
export function classifiedVoucherTypes(): string[] {
  return Object.keys(VOUCHER_LEDGER_EXPECTATIONS).sort();
}
