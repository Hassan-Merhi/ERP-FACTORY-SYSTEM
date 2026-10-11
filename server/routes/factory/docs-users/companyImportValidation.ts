/**
 * Validation of a company-data export file before it is imported
 * (companyImportRoutes.ts; split out in accounting audit phase 19 C).
 */
import Decimal from "decimal.js";

type ImportRow = Record<string, unknown> & { id?: number };

export const IMPORT_UNBALANCED_VOUCHERS_MESSAGE =
  "The file contains posted vouchers whose debits do not equal their credits. They cannot be imported: correct them in the source company first.";

/**
 * Posted (not deleted, not optional) vouchers of an export file whose lines do
 * not balance to the cent in the base columns.
 */
export function unbalancedImportedVouchers(
  tables: Record<string, ImportRow[]>
): Array<{ voucherNumber: string; voucherType: string; debit: string; credit: string }> {
  const totals = new Map<number, { debit: Decimal; credit: Decimal }>();
  const amount = (value: unknown) => {
    try {
      const parsed = new Decimal(value == null || value === "" ? 0 : String(value));
      return parsed.isFinite() ? parsed : new Decimal(0);
    } catch {
      return new Decimal(0);
    }
  };
  for (const line of tables.voucher_entries ?? []) {
    const voucherId = Number(line.voucherId);
    if (!Number.isInteger(voucherId)) continue;
    const current = totals.get(voucherId) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    totals.set(voucherId, {
      debit: current.debit.plus(amount(line.debitAmount)),
      credit: current.credit.plus(amount(line.creditAmount)),
    });
  }
  const unbalanced: Array<{ voucherNumber: string; voucherType: string; debit: string; credit: string }> = [];
  for (const voucher of tables.vouchers ?? []) {
    if (voucher.deletedAt != null || voucher.optional === true) continue;
    const total = totals.get(Number(voucher.id)) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    const debit = total.debit.toDecimalPlaces(2);
    const credit = total.credit.toDecimalPlaces(2);
    if (!debit.equals(credit)) {
      unbalanced.push({
        voucherNumber: String(voucher.voucherNumber ?? voucher.id),
        voucherType: String(voucher.voucherType ?? ""),
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
      });
    }
  }
  return unbalanced;
}
