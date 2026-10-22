/**
 * Canonical read-only totals for a historical Factory Net Position response.
 * Every displayed header / category is derived from exactly the same rows.
 * Do not use a different inventory, payroll, or supplier formula for a subtotal.
 */
import { MoneyDecimal, toMoney } from "../../lib/money";

export interface HistoricalPositionRow {
  name: string;
  code: string;
  category: string;
  value: number;
}
export interface HistoricalPositionSide<R extends HistoricalPositionRow> {
  total: number;
  breakdown: Array<{ name: string; value: number }>;
  accounts: R[];
}
export interface HistoricalPositionReport<R extends HistoricalPositionRow> {
  forUs: HistoricalPositionSide<R>;
  onUs: HistoricalPositionSide<R>;
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
}

const zero = () => new MoneyDecimal(0);
const rounded = (amount: ReturnType<typeof toMoney>) => amount.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
const toNumber = (amount: ReturnType<typeof toMoney>) => rounded(amount).toNumber();

/** Handles signed contra-asset/prepaid rows: never sum Math.abs(value). */
export function sumPositionRows(rows: readonly Pick<HistoricalPositionRow, "value">[]): number {
  return toNumber(
    rows.reduce((total, row) => {
      if (!Number.isFinite(row.value)) throw new Error("HISTORICAL_NET_POSITION_NONFINITE_AMOUNT");
      return total.plus(rounded(toMoney(row.value)));
    }, zero())
  );
}

/** Per-category totals reconcile exactly to the rounded displayed row amounts. */
export function groupPositionRows(
  rows: readonly HistoricalPositionRow[],
  labels: Readonly<Record<string, string>> = {}
) {
  const categories = new Map<string, ReturnType<typeof toMoney>>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) throw new Error("HISTORICAL_NET_POSITION_NONFINITE_AMOUNT");
    const category = labels[row.category || "Other"] ?? (row.category || "Other");
    categories.set(category, (categories.get(category) ?? zero()).plus(rounded(toMoney(row.value))));
  }
  return [...categories].map(([name, amount]) => ({ name, value: toNumber(amount) })).sort((a, b) => b.value - a.value);
}

/**
 * Called AFTER all historical calculators and the inventory overlay.
 * Current-date reporting is intentionally unchanged; historical totals can
 * never diverge between summary, expanded rows, and category breakdowns.
 */
export function reconcileHistoricalPosition<R extends HistoricalPositionRow, T extends HistoricalPositionReport<R>>(
  report: T
): T {
  report.forUs.breakdown = groupPositionRows(report.forUs.accounts);
  // Today's liability breakdown labels the supplier rows' group "Suppliers".
  report.onUs.breakdown = groupPositionRows(report.onUs.accounts, { Supplier: "Suppliers" });
  report.forUs.total = sumPositionRows(report.forUs.accounts);
  report.onUs.total = sumPositionRows(report.onUs.accounts);
  report.forUsTotal = report.forUs.total;
  report.onUsTotal = report.onUs.total;
  report.netPosition = toNumber(toMoney(report.forUsTotal).minus(toMoney(report.onUsTotal)));
  report.netPositionLabel = report.netPosition >= 0 ? "We have more than we owe" : "We owe more than we have";
  return report;
}
