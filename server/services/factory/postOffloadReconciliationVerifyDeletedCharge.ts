// Extracted from ./postOffloadReconciliation.ts
import {
  closeEnough,
  loadDaybook,
  metadata,
  parseDecimal,
  verifyOriginalDaybook,
  type ChargeRow,
  type ReconciliationQueryClient,
} from "./postOffloadReconciliationReconcileActiveVoucher";

export async function verifyDeletedCharge(params: {
  client: ReconciliationQueryClient;
  companyId: number;
  containerId: number;
  charge: ChargeRow;
  accountingIssues: string[];
}): Promise<{ voucherChecked: boolean; reversalChecked: boolean; daybookChecked: boolean }> {
  const { client, companyId, containerId, charge, accountingIssues } = params;
  let voucherChecked = false;

  if (charge.voucher_id) {
    const voucherResult = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM vouchers WHERE id = $1 FOR UPDATE`,
      [charge.voucher_id]
    );
    voucherChecked = true;
    if (!voucherResult.rows[0]) {
      accountingIssues.push(`charge ${charge.id}: deleted charge voucher is missing`);
    } else if (!voucherResult.rows[0].deleted_at) {
      accountingIssues.push(`charge ${charge.id}: deleted charge still has an active voucher`);
    }
  }

  const original = await loadDaybook(client, charge.daybook_entry_id);
  verifyOriginalDaybook({ row: original, companyId, containerId, charge, issues: accountingIssues });
  const reversal = await loadDaybook(client, charge.reversal_daybook_entry_id);
  if (!reversal) {
    accountingIssues.push(`charge ${charge.id}: deleted charge has no reversing daybook entry`);
    return { voucherChecked, reversalChecked: false, daybookChecked: Boolean(original) };
  }
  if (!original) {
    return { voucherChecked, reversalChecked: true, daybookChecked: false };
  }

  const reversalMeta = metadata(reversal.meta_json);
  if (
    reversal.company_id !== companyId ||
    reversal.reference_id !== containerId ||
    reversal.tx_type !== "OTHER_CHARGE" ||
    reversalMeta.sourceType !== "POST_OFFLOAD_ADDITIONAL_REVERSAL" ||
    Number(reversalMeta.chargeId) !== charge.id ||
    Number(reversalMeta.reversesDaybookEntryId) !== original.id
  ) {
    accountingIssues.push(`charge ${charge.id}: reversing daybook scope or metadata is invalid`);
  }
  if (!closeEnough(parseDecimal(reversal.amount_currency), parseDecimal(original.amount_currency).negated(), "0.01")) {
    accountingIssues.push(`charge ${charge.id}: reversing transaction amount does not negate the original`);
  }
  if (!closeEnough(parseDecimal(reversal.amount_usd), parseDecimal(original.amount_usd).negated(), "0.01")) {
    accountingIssues.push(`charge ${charge.id}: reversing USD amount does not negate the original`);
  }

  return { voucherChecked, reversalChecked: true, daybookChecked: true };
}
