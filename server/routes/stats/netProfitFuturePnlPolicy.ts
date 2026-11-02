/**
 * Live P&L excludes transactions whose accounting-effective date is after
 * the company's report business day. Explicit dated reports keep their own
 * historical as-of. Ledger/supplier/cash/net-position balances are NOT
 * filtered by this additional P&L-only rule.
 */
export function getNetProfitFuturePnlPolicy(
  companyId: number,
  toDate: string | null | undefined,
  liveBusinessDate: string | null | undefined,
) {
  const explicit = toDate || null;
  const live = explicit ? null : (liveBusinessDate || null);
  if (live && !/^\d{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$/.test(live)) {
    throw new Error("Invalid live net-profit accounting business date");
  }
  return {
    ledgerDateFilter: explicit ? "AND COALESCE(v.effective_date, v.voucher_date) <= $2" : "",
    futurePnlFilter: live ? "AND COALESCE(v.effective_date, v.voucher_date) > $2" : "AND FALSE",
    params: explicit ? [companyId, explicit] : live ? [companyId, live] : [companyId],
    appliedLivePnlCutoff: live,
  };
}
