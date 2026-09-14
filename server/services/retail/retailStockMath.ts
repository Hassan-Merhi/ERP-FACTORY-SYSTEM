export interface RetailCartItemInput {
  variantId: number;
  quantity: number;
}

export function aggregateRetailCartItems(items: RetailCartItemInput[]): RetailCartItemInput[] {
  const aggregate = new Map<number, number>();
  for (const item of items) {
    aggregate.set(item.variantId, (aggregate.get(item.variantId) ?? 0) + item.quantity);
  }
  return [...aggregate.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export function nextRetailSaleQuantity(before: number, quantity: number, allowNegative: boolean): number {
  const after = before - quantity;
  if (!allowNegative && after < -0.000001) {
    throw new Error(`Insufficient stock. Available: ${before}`);
  }
  return after;
}

export function validateRetailReturnQuantity(sold: number, alreadyReturned: number, requested: number): number {
  const remaining = sold - alreadyReturned;
  if (requested > remaining + 0.000001) {
    throw new Error("Return quantity exceeds the remaining sold quantity");
  }
  return alreadyReturned + requested;
}

export function nextRetailReturnQuantity(before: number, quantity: number): number {
  return before + quantity;
}

export function nextRetailTransferQuantities(
  sourceBefore: number,
  destinationBefore: number,
  quantity: number,
  allowNegative: boolean
): { sourceAfter: number; destinationAfter: number } {
  const sourceAfter = nextRetailSaleQuantity(sourceBefore, quantity, allowNegative);
  return { sourceAfter, destinationAfter: destinationBefore + quantity };
}
