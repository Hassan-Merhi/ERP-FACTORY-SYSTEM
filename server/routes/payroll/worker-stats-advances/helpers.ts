/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../../services/factory/factoryDaybookWriter";

// Helper: Compute monthly pay from actual attendance records.
// Monthly payroll uses attendance-based calculation (Present/Late = 1 day, Half Day = 0.5 day)
// rather than calendar-day proration to match actual work performed.

/** ERP-mode company resolution: the ERP payroll page posts companyId explicitly, and
 *  these endpoints sit outside the factory middleware, so the factory pin is the fallback. */
export function getErpCompanyId(req: import("express").Request): number | undefined {
  return req.body?.companyId
    ? parseInt(req.body.companyId)
    : req.query?.companyId
      ? parseInt(req.query.companyId as string)
      : req.session.currentCompanyId || req.session.factoryCompanyId;
}
