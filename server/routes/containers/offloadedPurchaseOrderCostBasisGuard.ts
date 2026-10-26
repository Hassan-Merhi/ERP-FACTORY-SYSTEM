/**
 * Once a container has been offloaded, its PO item cost basis is already posted
 * to inventory. Cosmetic item names can change, but economic fields cannot:
 * otherwise the purchase voucher and received stock silently diverge.
 */
import { HttpError } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";

export interface PurchaseOrderCostBasisLine {
  stockItemId: number | string | null | undefined;
  quantity: string | number | null | undefined;
  rate: string | number | null | undefined;
  lineTotal: string | number | null | undefined;
}

function costBasisSignature(item: PurchaseOrderCostBasisLine): string {
  const id = Number(item.stockItemId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(409, "An offloaded container must keep its original stock item identities.");
  }

  return [
    id,
    toMoney(item.quantity).toFixed(3),
    toMoney(item.rate).toFixed(2),
    toMoney(item.lineTotal).toFixed(2),
  ].join("|");
}

/** Compare complete economic line multisets, not just the set of stock IDs. */
export function assertOffloadedPurchaseOrderCostBasisUnchanged(
  previous: readonly PurchaseOrderCostBasisLine[],
  proposed: readonly PurchaseOrderCostBasisLine[]
): void {
  const before = previous.map(costBasisSignature).sort();
  const after = proposed.map(costBasisSignature).sort();
  if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
    throw new HttpError(
      409,
      "This container is already offloaded. Its purchase quantities, item rates, and costs cannot be changed separately from inventory. Use the controlled offload correction workflow."
    );
  }
}
