/**
 * Explicit module identity for shared rental UI. These API paths are transport
 * configuration, never a signal for reporting or accounting behavior.
 *
 * This client policy affects presentation and endpoint selection only:
 * posting, authorization, account selection, and transfers remain server-owned.
 */
export type RentalModule = "PROPERTIES" | "FACTORY" | "ERP";

type RentalModulePolicy = Readonly<{
  module: RentalModule;
  apiBase: string;
  /** Properties' dated warehouse reconciliation is a read-only presentation. */
  usesPropertiesReconciliation: boolean;
}>;

export const RENTAL_MODULE_POLICIES: Readonly<Record<RentalModule, RentalModulePolicy>> = {
  PROPERTIES: {
    module: "PROPERTIES",
    apiBase: "/api/properties/rental",
    usesPropertiesReconciliation: true,
  },
  FACTORY: {
    module: "FACTORY",
    apiBase: "/api/factory/rental",
    usesPropertiesReconciliation: false,
  },
  ERP: {
    module: "ERP",
    apiBase: "/api/erp/rental",
    usesPropertiesReconciliation: false,
  },
};

export function getRentalModulePolicy(module: RentalModule): RentalModulePolicy {
  return RENTAL_MODULE_POLICIES[module];
}
