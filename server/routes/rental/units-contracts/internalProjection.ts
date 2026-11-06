/**
 * Decide which tab displays a shared rental unit. Properties shows internal
 * ERP/Factory warehouse contracts under Warehouses rather than Shops.
 * Other linked leases keep the existing Shops presentation.
 *
 * This is presentation-only: no new Properties contract, monthly ledger or
 * accounting entries are created for these cross-module references.
 */
export function isPropertiesInternalSourceReference(
  viewingModule: string,
  contract: { module: string; isInternal: boolean }
): boolean {
  return viewingModule === "PROPERTIES" &&
    contract.isInternal &&
    (contract.module === "ERP" || contract.module === "FACTORY");
}

export function sharedRentalDisplayTab(
  viewingModule: string,
  contract: { module: string; isInternal: boolean },
  unit: { unitType: string }
): "WAREHOUSE" | "SHOP" {
  if (isPropertiesInternalSourceReference(viewingModule, contract) && unit.unitType === "WAREHOUSE") {
    return "WAREHOUSE";
  }
  return "SHOP";
}
