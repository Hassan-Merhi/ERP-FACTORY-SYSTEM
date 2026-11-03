export const PHASE8_CASH_BOX_VOUCHER_TYPES: readonly ["Payment", "Receipt"];
export function phase8CashBoxRefusal(
  voucherType: string,
  entries: ReadonlyArray<{ ledgerAccountId: number | string; debitAmount?: unknown; creditAmount?: unknown }>,
  accountTypeById: ReadonlyMap<number, string>
): string | null;
