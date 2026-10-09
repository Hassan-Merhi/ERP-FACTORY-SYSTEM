/** True when freight should be included in the supplier's payable balance.
 *  Explicit freightPaidBy flag takes priority.
 *  For legacy offloaded containers missing the flag: the offload route always
 *  sets freightSupplierId when it credits the supplier — so if that column is
 *  null on an already-offloaded container, the freight went to an own account.
 *
 *  Exported so supplierStatementRoutes.ts can apply the same guard. */
export const isSupplierPaidFreight = (c: Record<string, unknown>): boolean => {
  if (c.freightPaidBy === "own") return false;
  if (c.freightPaidBy === "supplier") return true;
  // freightPaidBy is null (legacy row): use freightSupplierId as ground truth
  // only for containers that have already been offloaded (offload always writes
  // freightSupplierId for supplier-paid freight, leaves it null for own-account).
  const offloadedStatuses = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);
  if (offloadedStatuses.has(String(c.status || "").toUpperCase())) {
    return c.freightSupplierId !== null && c.freightSupplierId !== undefined;
  }
  // Pending / OTW: default to "supplier" (legacy behaviour; determined at offload).
  return true;
};
