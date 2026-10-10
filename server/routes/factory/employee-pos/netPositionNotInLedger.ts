/**
 * "Not yet in the ledger" lines specific to the factory net position
 * (accounting audit wave 10). Shown next to the report, never added to What
 * We Have / What We Owe.
 */
import {
  notInLedgerSection,
  type NotInLedgerLine,
  type NotInLedgerSection,
} from "../../../services/accounting/balances/netPositionParties";

/** A line shown for information only: never part of the section total (wave 11). */
export type InformationalNotInLedgerLine = NotInLedgerLine & { informational: true };

interface OrderSummary {
  grandTotal: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Unfinalized orders at selling price: no invoice, nothing in the ledger, not a
 * receivable yet. They used to be added to What We Have.
 *
 * Wave 11 (owner decision): their bales are stock at cost in Stock In Hand
 * (finished goods after the cut-over), so these lines are informational only:
 * `informational: true` and left out of the section total
 * (notInLedgerSectionWithInformational). Counting their selling value as well would count
 * the same bales twice.
 */
export function factoryOrderMemoLines(orders: {
  pendingOrders: OrderSummary[];
  verifiedOrders: OrderSummary[];
  loadingOrders: OrderSummary[];
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
}): InformationalNotInLedgerLine[] {
  const lines: InformationalNotInLedgerLine[] = [];
  const add = (label: string, code: string, value: number, count: number) => {
    if (count > 0) {
      lines.push({ label, code, value: round2(value), category: "Not yet in the ledger", count, informational: true });
    }
  };
  add(
    "Pending orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    "PENDING_ORDERS",
    orders.pendingTotal,
    orders.pendingOrders.length
  );
  add(
    "Verified orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    "VERIFIED_ORDERS",
    orders.verifiedTotal,
    orders.verifiedOrders.length
  );
  add(
    "Loading orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    "LOADING_ORDERS",
    orders.loadingTotal,
    orders.loadingOrders.length
  );
  return lines;
}

/**
 * The not-in-ledger section of `lines` (in order); informational lines are
 * listed but left out of its total.
 */
export function notInLedgerSectionWithInformational(
  lines: Array<NotInLedgerLine | InformationalNotInLedgerLine>
): NotInLedgerSection {
  const counted = notInLedgerSection(lines.filter((line) => !("informational" in line && line.informational)));
  return { ...notInLedgerSection(lines), total: counted.total };
}

/**
 * The factory_worker_advances table's remaining balance over the
 * "Factory Worker Advances" ledger account (debit positive), which the report
 * used to show instead of the ledger figure.
 */
export function workerAdvanceMemoLines(tableTotal: number, ledgerValue: number): NotInLedgerLine[] {
  const delta = round2(tableTotal - ledgerValue);
  if (delta === 0) return [];
  return [
    {
      label: "Factory worker advances: the advances table differs from the ledger",
      code: "WORKER_ADVANCES",
      value: delta,
      category: "Not yet in the ledger",
      count: 0,
    },
  ];
}
