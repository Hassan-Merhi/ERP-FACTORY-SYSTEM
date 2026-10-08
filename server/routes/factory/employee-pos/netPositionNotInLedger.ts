/**
 * "Not yet in the ledger" lines specific to the factory net position
 * (accounting audit wave 10). Shown next to the report, never added to What
 * We Have / What We Owe.
 */
import type { NotInLedgerLine } from "../../../services/accounting/balances/netPositionParties";

interface OrderSummary {
  grandTotal: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Unfinalized orders at selling price: no invoice, nothing in the ledger, not a
 * receivable yet. They used to be added to What We Have.
 */
export function factoryOrderMemoLines(orders: {
  pendingOrders: OrderSummary[];
  verifiedOrders: OrderSummary[];
  loadingOrders: OrderSummary[];
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
}): NotInLedgerLine[] {
  const lines: NotInLedgerLine[] = [];
  const add = (label: string, code: string, value: number, count: number) => {
    if (count > 0) lines.push({ label, code, value: round2(value), category: "Not yet in the ledger", count });
  };
  add(
    "Pending orders at selling price (not invoiced)",
    "PENDING_ORDERS",
    orders.pendingTotal,
    orders.pendingOrders.length
  );
  add(
    "Verified orders at selling price (not invoiced)",
    "VERIFIED_ORDERS",
    orders.verifiedTotal,
    orders.verifiedOrders.length
  );
  add(
    "Loading orders at selling price (not invoiced)",
    "LOADING_ORDERS",
    orders.loadingTotal,
    orders.loadingOrders.length
  );
  return lines;
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
