export type MigrationEntryLike = {
  id: number;
  voucherId: number;
  ledgerAccountId: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  customerId?: number | null;
  factorySupplierId?: number | null;
  debitAmount: string | null;
  creditAmount: string | null;
  narration?: string | null;
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | null;
  transactionCreditAmount?: string | null;
  baseDebitAmount?: string | null;
  baseCreditAmount?: string | null;
  historicalExchangeRate?: string | null;
  rateConvention?: string | null;
};

export type MigrationVoucherPlan = {
  voucherId: number;
  selectedEntries: MigrationEntryLike[];
  isExclusive: boolean;
  debit: number;
  credit: number;
  net: number;
};

function amount(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildMigrationVoucherPlan(
  voucherId: number,
  entries: MigrationEntryLike[],
  selectedAccountIds: ReadonlySet<number>,
): MigrationVoucherPlan {
  const selectedEntries = entries.filter(
    (entry) => entry.ledgerAccountId !== null && selectedAccountIds.has(entry.ledgerAccountId),
  );

  const hasForeignDimension = entries.some((entry) => {
    const hasNonSelectedLedger =
      entry.ledgerAccountId !== null && !selectedAccountIds.has(entry.ledgerAccountId);
    return (
      hasNonSelectedLedger ||
      entry.bankAccountId != null ||
      entry.fixedAssetId != null ||
      entry.supplierId != null ||
      entry.employeeId != null ||
      entry.customerId != null ||
      entry.factorySupplierId != null
    );
  });

  const debit = selectedEntries.reduce((sum, entry) => sum + amount(entry.debitAmount), 0);
  const credit = selectedEntries.reduce((sum, entry) => sum + amount(entry.creditAmount), 0);

  return {
    voucherId,
    selectedEntries,
    isExclusive: selectedEntries.length > 0 && !hasForeignDimension,
    debit,
    credit,
    net: debit - credit,
  };
}

export function migrationDestinationTotal(plan: MigrationVoucherPlan): string {
  return Math.max(plan.debit, plan.credit).toFixed(2);
}

export function migrationClearingAmounts(plan: MigrationVoucherPlan): {
  debitAmount: string;
  creditAmount: string;
} | null {
  if (Math.abs(plan.net) < 0.0000005) return null;
  if (plan.net > 0) {
    return { debitAmount: "0.00", creditAmount: plan.net.toFixed(2) };
  }
  return { debitAmount: Math.abs(plan.net).toFixed(2), creditAmount: "0.00" };
}
