/**
 * A stock-flow bridge is diagnostic in periodic accounting.
 * Do not interpret (receipts + adjustments - closing stock - saved COGS) as
 * an adjusting journal when purchases and consumption are not posted through
 * perpetual inventory. Keep the source figures unchanged and visible to audit.
 */
export function describeInventoryCostBridge(perpetualInventoryActive: boolean) {
  return {
    accountingBasis: perpetualInventoryActive ? ("perpetual" as const) : ("periodic" as const),
    inventoryBridgeIsJournalReconciliation: perpetualInventoryActive,
    reconciliationInterpretation: perpetualInventoryActive
      ? "Inventory movement and stored COGS bridge; review source-level movements before posting corrections."
      : "Diagnostic stock-flow comparison only. Periodic inventory does not book each sale through the inventory control account; production, consumption, returns, legacy transfers and historical repricing can explain a nonzero difference. Do not book the difference as a standalone adjustment.",
  };
}
