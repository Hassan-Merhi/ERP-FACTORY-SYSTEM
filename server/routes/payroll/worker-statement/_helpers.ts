/**
 * Shared state and helpers for the workerStatementRoutes routes.
 *
 * Extracted verbatim from the former single-file workerStatementRoutes.ts.
 */
import { toMoney } from "../../../lib/money";
import { exactMonthlyPay } from "../core/workerPayAmounts";

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../../services/factory/factoryDaybookWriter";

export function computeMonthlyPay(salary: number, startStr: string, endStr: string): number {
  return exactMonthlyPay(toMoney(salary), startStr, endStr).toNumber();
}

// Helper: Compute monthly pay from actual attendance records.
// Monthly payroll uses attendance-based calculation (Present/Late = 1 day, Half Day = 0.5 day)
// rather than calendar-day proration to match actual work performed.
