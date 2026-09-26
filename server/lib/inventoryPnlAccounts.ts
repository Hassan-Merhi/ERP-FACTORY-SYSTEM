export interface InventoryPnlAccountLike {
  code?: string | null;
  name?: string | null;
}

/**
 * Inventory valuation/control movements already flow through stock/COGS.
 * They must not also be counted as operating/direct/indirect expenses.
 */
export function isInventoryValuationOnlyAccount(account: InventoryPnlAccountLike): boolean {
  const code = (account.code || "").trim().toUpperCase();
  if (
    code === "INVENTORY" ||
    code === "STOCK_ADJUSTMENT" ||
    code === "PRODUCTION_ADJUSTMENT" ||
    code === "CONSUMPTION_EXPENSE"
  ) {
    return true;
  }

  const name = (account.name || "").trim().toLowerCase();
  return name === "credit note - customer return" || name === "stock adjustment (production/consumption)";
}
