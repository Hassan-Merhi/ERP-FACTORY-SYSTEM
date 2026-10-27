import { toMoney } from "../../../lib/money";

export interface OffloadCostBasisLine {
  stockItemId: number;
  quantity: string;
  totalValue: string;
}

/** Compare the exact amount and quantity posted per item, independent of line ordering. */
export function offloadEconomicBasisChanged(
  previous: readonly OffloadCostBasisLine[],
  proposed: readonly OffloadCostBasisLine[],
  previousLocationId: number,
  proposedLocationId: number
): boolean {
  if (previousLocationId !== proposedLocationId) return true;

  const grouped = (lines: readonly OffloadCostBasisLine[]) => {
    const totals = new Map<number, { quantity: ReturnType<typeof toMoney>; value: ReturnType<typeof toMoney> }>();
    for (const line of lines) {
      const existing = totals.get(line.stockItemId) ?? { quantity: toMoney(0), value: toMoney(0) };
      totals.set(line.stockItemId, {
        quantity: existing.quantity.plus(toMoney(line.quantity)),
        value: existing.value.plus(toMoney(line.totalValue)),
      });
    }
    return totals;
  };

  const old = grouped(previous);
  const next = grouped(proposed);
  if (old.size !== next.size) return true;
  for (const [id, initial] of old) {
    const current = next.get(id);
    if (
      !current ||
      !initial.quantity.toDecimalPlaces(3).equals(current.quantity.toDecimalPlaces(3)) ||
      !initial.value.toDecimalPlaces(2).equals(current.value.toDecimalPlaces(2))
    )
      return true;
  }
  return false;
}
