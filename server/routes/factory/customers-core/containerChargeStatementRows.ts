/**
 * Presentation-only consolidation for factory customer statements.
 *
 * Factory invoice journals may contain the merchandise amount while separate
 * customer-debit Journal vouchers contain freight/clearance/other charges.
 * Show those parts as ONE container sale in customer statements, but never
 * rewrite or remove the underlying accounting vouchers.
 *
 * Date-sensitive reports: only fold charges booked on the invoice's own date.
 * A later-dated charge stays separate (as does a charge with an ambiguous
 * container), so filtered statements and brought-forward amounts stay honest.
 */
import type { FactoryStatementRow } from "./statementRows";

const containerFromOffloadNarration = (value: string | null): string | null => {
  const match = /^.+?\s+for\s+offloaded\s+container\s*[-:]\s*([A-Z0-9-]+)\s*$/i.exec(value ?? "");
  return match ? match[1].toUpperCase() : null;
};

const containerKey = (value: string | undefined | null) => (value ?? "").trim().toUpperCase();

export function consolidateContainerCharges(
  rows: FactoryStatementRow[],
  invoiceContainerByOrder: ReadonlyMap<number, string>,
  chargeOrderByVoucherId: ReadonlyMap<number, number> = new Map()
): FactoryStatementRow[] {
  const saleByOrder = new Map<number, number>();
  const salesByContainerAndDate = new Map<string, number[]>();

  rows.forEach((row, index) => {
    if (row.referenceType !== "INVOICE" || row.transactionType.toUpperCase() !== "SALE" ||
        row.referenceId == null || !row.combinedEffect.greaterThanOrEqualTo(0)) return;
    // Do not consolidate a credit note or adjustment into a container sale.
    if (saleByOrder.has(row.referenceId)) {
      saleByOrder.set(row.referenceId, -1); // multiple sale rows: ambiguous
    } else {
      saleByOrder.set(row.referenceId, index);
    }
    const number = containerKey(invoiceContainerByOrder.get(row.referenceId));
    if (!number) return;
    const key = `${number}|-${row.transactionDate.slice(0, 10)}`;
    const targets = salesByContainerAndDate.get(key) ?? [];
    targets.push(index);
    salesByContainerAndDate.set(key, targets);
  });

  const consolidated = rows.map((row) => ({ ...row }));
  const remove = new Set<number>();
  rows.forEach((row, index) => {
    // Only genuine customer-debit Journal charges can be included. Payments,
    // refunds, reversals, sales and other accounting events keep their own rows.
    if (row.referenceType !== "VOUCHER" || row.transactionType.toUpperCase() !== "JOURNAL" ||
        row.notInLedger || !row.combinedEffect.greaterThan(0) || !row.ledgerEffect.greaterThan(0) ||
        row.creditAmount !== "0" && Number(row.creditAmount) !== 0) return;
    let targetIndex: number | undefined;
    const linkedOrderId = row.referenceId == null ? undefined : chargeOrderByVoucherId.get(row.referenceId);
    if (linkedOrderId !== undefined) {
      const indexForOrder = saleByOrder.get(linkedOrderId);
      if (indexForOrder !== undefined && indexForOrder >= 0) targetIndex = indexForOrder;
    } else {
      const container = containerFromOffloadNarration(row.description);
      if (!container) return;
      const candidates = salesByContainerAndDate.get(`${container}|-${row.transactionDate.slice(0, 10)}`) ?? [];
      if (candidates.length === 1) targetIndex = candidates[0];
    }
    if (targetIndex === undefined) return;
    const target = consolidated[targetIndex];
    if (target.transactionDate.slice(0, 10) !== row.transactionDate.slice(0, 10) ||
        target.currency.toUpperCase() !== row.currency.toUpperCase() ||
        target.customerId !== row.customerId || target.companyId !== row.companyId) return;

    const nextCombined = target.combinedEffect.plus(row.combinedEffect);
    const nextLedger = target.ledgerEffect.plus(row.ledgerEffect);
    if (!nextCombined.greaterThanOrEqualTo(0)) return;
    target.combinedEffect = nextCombined;
    target.ledgerEffect = nextLedger;
    target.debitAmount = nextCombined.toFixed(2);
    target.creditAmount = "0";
    if (target.notInLedger) {
      target.notInLedgerLabel = "Container total includes posted charges and an invoice portion not yet in the ledger";
    }
    remove.add(index);
  });

  return consolidated.filter((_, index) => !remove.has(index));
}
