/**
 * Decide which tab displays a shared rental unit. Properties shows internal
 * ERP/Factory warehouse contracts under Warehouses rather than Shops.
 * Factory internal occupancy leases may be recorded as SHOP for tenant-side
 * accounting, but are property references in the Warehouses tab. Non-internal
 * linked leases keep their existing Shops presentation.
 *
 * This is presentation-only: no new Properties contract, monthly ledger or
 * accounting entries are created for these cross-module references.
 */
export function isPropertiesInternalSourceReference(
  viewingModule: string,
  contract: { module: string; isInternal: boolean }
): boolean {
  return (
    viewingModule === "PROPERTIES" &&
    contract.isInternal &&
    (contract.module === "ERP" || contract.module === "FACTORY")
  );
}

export function sharedRentalDisplayTab(
  viewingModule: string,
  contract: { module: string; isInternal: boolean },
  unit: { unitType: string }
): "WAREHOUSE" | "SHOP" {
  if (
    isPropertiesInternalSourceReference(viewingModule, contract) &&
    (unit.unitType === "WAREHOUSE" || contract.module === "FACTORY")
  ) {
    return "WAREHOUSE";
  }
  return "SHOP";
}
