/**
 * HADI L'SHI (company #1) historic ERP shop expense consolidation.
 *
 * KEEP existing voucher_entries on retired ledger #881. Moving their
 * ledger_account_id would rewrite previously posted vouchers; instead, the
 * surviving #1007 account reads those entries as historical statement lines.
 * The alias activates only once the source is explicitly retired (hidden,
 * inactive, and zero opening balance) by the guarded one-time repair.
 */
export const HADI_ERP_RENT_MERGE = Object.freeze({
  companyId: 1,
  targetLedgerId: 1007,
  legacyLedgerId: 881,
  targetName: "Rent Expense - ERP Shops",
  legacyName: "Rent Expense Lubumbashi - ERP Shops",
});

/** Bound voucher-statement predicate, never supplied by an HTTP client. */
export function consolidatedHadiRentLedgerPredicate(
  column: string,
  parameter: string,
  companyId: number | undefined,
  ledgerAccountId: number
): string {
  if (
    companyId !== HADI_ERP_RENT_MERGE.companyId ||
    ledgerAccountId !== HADI_ERP_RENT_MERGE.targetLedgerId
  ) {
    return `${column} = ${parameter}`;
  }
  // The archived master stays in the same company for RLS and voucher audits.
  // The EXISTS condition prevents reporting two live, separate accounts as one
  // if the one-time opening transfer was refused or never enabled.
  return `(${column} = ${parameter} OR
    (${column} = ${HADI_ERP_RENT_MERGE.legacyLedgerId} AND EXISTS (
      SELECT 1 FROM ledger_accounts merged_source
      WHERE merged_source.id = ${HADI_ERP_RENT_MERGE.legacyLedgerId}
        AND merged_source.company_id = ${HADI_ERP_RENT_MERGE.companyId}
        AND merged_source.is_hidden = true
        AND merged_source.active = false
        AND merged_source.deleted_at IS NULL
        AND COALESCE(merged_source.opening_balance,0) = 0
    )))`;
}

/** Future old-name rental postings must use the surviving account. */
export function canonicalHadiRentExpenseName(
  companyId: number,
  name: string,
  codePrefix: string
): string {
  return companyId === HADI_ERP_RENT_MERGE.companyId &&
    name === HADI_ERP_RENT_MERGE.legacyName &&
    codePrefix === "SHOP-RENT-EXP"
    ? HADI_ERP_RENT_MERGE.targetName
    : name;
}

/** Hide only the verified retired zero-balance master, never other accounts. */
export function isArchivedHadiRentExpenseLedger(account: {
  id: number;
  companyId: number;
  active: boolean;
  isHidden: boolean;
  openingBalance: string | number | null;
}): boolean {
  return account.companyId === HADI_ERP_RENT_MERGE.companyId &&
    account.id === HADI_ERP_RENT_MERGE.legacyLedgerId &&
    !account.active && account.isHidden && Number(account.openingBalance ?? 0) === 0;
}
