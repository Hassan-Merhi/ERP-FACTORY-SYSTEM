/** Shared helpers of the factory advance routes (split out of advanceManagementRoutes.ts). */

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../services/factory/factoryDaybookWriter";
