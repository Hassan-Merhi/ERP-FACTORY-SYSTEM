/**
 * Company 12 management-dashboard presentation exception.
 *
 * October's $435.81 duplicate paid wages were reclassified to a genuine
 * payroll-overpayment receivable (vouchers #17120 and #17121). The owner has
 * requested that this specifically named account not contribute to the
 * operational Accounts/Analytics lists or Net Position dashboards.
 *
 * IMPORTANT: This is ONLY a reporting projection. The underlying asset and
 * balanced vouchers remain posted and visible in the audit trail, trial
 * balance and statutory/general-ledger reports; no financial statement is
 * adjusted or any cash/worker balance changed by this predicate.
 */
export const OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT =
  "Payroll Overpayments Receivable - October 2026";

export function isExcludedFromCompany12ManagementReports(
  companyId: number,
  account: { name: string | null | undefined },
): boolean {
  return companyId === 12 && (account.name ?? "").trim() === OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT;
}
