/**
 * Presentation-only factory customer statement grouping.
 *
 * A charge is only combined when its posted voucher is explicitly linked to
 * this customer's order, or when its anchored narration uniquely identifies
 * a single container. Original vouchers and monetary movements are unchanged.
 *
 * The displayed date for a grouped row is the latest posting date of its
 * components. Where a date window exists, never combine components across its
 * start/end boundaries: brought-forward and window totals must remain exact.
 */
import type { FactoryStatementRow } from "./statementRows";

export interface StatementContainerOrder {
  containerNumber: string;
  status: string;
}

export interface StatementGroupingWindow {
  from?: string | null;
  to?: string | null;
}

function containerFromChargeNarration(value: string | null): string | null {
  // Legacy charges sometimes use "for container" rather than "for offloaded container".
  const match = /^(?:freight|clearance|customs|handling|port charges?|document charges?|other charges?)\s+for\s+(?:offloaded\s+)?container\s*[-:]\s*([A-Z]{4}\d{7})\s*$/i.exec(
    (value ?? "").trim()
  );
  return match ? match[1].toUpperCase() : null;
}

function periodBucket(date: string, window: StatementGroupingWindow): "before" | "within" | "after" {
  const day = date.slice(0, 10);
  if (window.from && day < window.from) return "before";
  if (window.to && day > window.to) return "after";
  return "within";
}

export function consolidateContainerCharges(
  rows: FactoryStatementRow[],
  ordersById: ReadonlyMap<number, StatementContainerOrder | string>,
  chargeOrderByVoucherId: ReadonlyMap<number, number> = new Map(),
  window: StatementGroupingWindow = {}
): FactoryStatementRow[] {
  const orderInfo = (id: number): StatementContainerOrder | null => {
    const value = ordersById.get(id);
    return value ? typeof value === "string"
      ? { containerNumber: value, status: "FINALIZED" }
      : value : null;
  };
  const saleByOrder = new Map<number, number>();
  rows.forEach((row, index) => {
    if (row.referenceType !== "INVOICE" ||
        row.transactionType.toUpperCase() !== "SALE" ||
        row.referenceId == null ||
        !row.combinedEffect.greaterThanOrEqualTo(0) ||
        orderInfo(row.referenceId)?.status !== "FINALIZED") return;
    // An order with multiple displayable sales is ambiguous. Never double-add.
    saleByOrder.set(row.referenceId, saleByOrder.has(row.referenceId) ? -1 : index);
  });

  const ordersByContainer = new Map<string, number[]>();
  for (const [id] of ordersById) {
    const info = orderInfo(id);
    const container = info?.containerNumber.trim().toUpperCase();
    if (!container) continue;
    const candidates = ordersByContainer.get(container) ?? [];
    candidates.push(id);
    ordersByContainer.set(container, candidates);
  }

  const result = rows.map((row) => ({ ...row }));
  const removed = new Set<number>();
  const standaloneByKey = new Map<string, number>();
  rows.forEach((row, index) => {
    // No payments, refunds, adjustments, negative/reversed journals, or
    // inferred amounts: a genuine posted customer debit Journal only.
    if (row.referenceType !== "VOUCHER" ||
        row.transactionType.toUpperCase() !== "JOURNAL" ||
        row.notInLedger ||
        !row.combinedEffect.greaterThan(0) ||
        !row.ledgerEffect.greaterThan(0) ||
        Number(row.creditAmount) !== 0 ||
        row.referenceId == null) return;

    let orderId: number | undefined;
    if (chargeOrderByVoucherId.has(row.referenceId)) {
      const linkedId = chargeOrderByVoucherId.get(row.referenceId);
      if (linkedId !== undefined && linkedId > 0 && orderInfo(linkedId)) orderId = linkedId;
      // An ambiguous or invalid explicit link must not fall back to narration.
    } else {
      const container = containerFromChargeNarration(row.description);
      if (!container) return;
      const candidates = ordersByContainer.get(container) ?? [];
      if (candidates.length === 1) orderId = candidates[0];
    }
    if (orderId === undefined) return;
    const order = orderInfo(orderId);
    if (!order ||
        ["CANCELLED", "DELETED"].includes(order.status.toUpperCase()) ||
        row.companyId !== rows[0]?.companyId ||
        row.customerId !== rows[0]?.customerId) return;

    const saleIndex = saleByOrder.get(orderId);
    const sale = saleIndex !== undefined && saleIndex >= 0 ? result[saleIndex] : undefined;
    if (sale &&
        sale.customerId === row.customerId &&
        sale.companyId === row.companyId &&
        sale.currency.toUpperCase() === row.currency.toUpperCase() &&
        periodBucket(rows[saleIndex!].transactionDate, window) === periodBucket(row.transactionDate, window)) {
      sale.combinedEffect = sale.combinedEffect.plus(row.combinedEffect);
      sale.ledgerEffect = sale.ledgerEffect.plus(row.ledgerEffect);
      sale.debitAmount = sale.combinedEffect.toFixed(2);
      sale.creditAmount = "0";
      // Cross-date charges must not be visually backdated before their posting.
      sale.transactionDate = sale.transactionDate > row.transactionDate ? sale.transactionDate : row.transactionDate;
      if (sale.notInLedger) {
        sale.notInLedgerLabel = "Container total includes posted charges and an invoice portion not yet in the ledger";
      }
      removed.add(index);
      return;
    }

    // A verified/not-yet-finalized container has posted charges but no Sale.
    // Report these honestly as container costs, not as a completed sale or an
    // anonymous Journal. Preserve each posting date for period reports.
    const bucket = periodBucket(row.transactionDate, window);
    const key = `${orderId}|${row.transactionDate.slice(0, 10)}|${row.currency.toUpperCase()}|${bucket}`;
    const existingIndex = standaloneByKey.get(key);
    if (existingIndex !== undefined) {
      const previous = result[existingIndex];
      previous.combinedEffect = previous.combinedEffect.plus(row.combinedEffect);
      previous.ledgerEffect = previous.ledgerEffect.plus(row.ledgerEffect);
      previous.debitAmount = previous.combinedEffect.toFixed(2);
      removed.add(index);
    } else {
      result[index] = {
        ...result[index],
        transactionType: "CONTAINER_COST",
        referenceType: "INVOICE",
        referenceId: orderId,
        description: `Container costs — ${order.containerNumber}`,
      };
      standaloneByKey.set(key, index);
    }
  });
  return result.filter((_, index) => !removed.has(index));
}
