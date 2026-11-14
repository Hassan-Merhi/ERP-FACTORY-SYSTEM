/** Shared Factory API tab ownership constants and helpers. */
import type { Request } from "express";
import { hasPrefix, requirement, type FactoryApiAccessRequirement } from "./factoryBackendAccessBoundaryRules";

export const PAYROLL_WORKERS = "hide_tab_payrollhub_workers";
export const PAYROLL_EMPLOYEES = "hide_tab_payrollhub_employees";
export const WORKERS_LIST = "hide_tab_workers_workers";
export const WORKERS_PAYROLL = "hide_tab_workers_payroll";
export const WORKERS_ATTENDANCE = "hide_tab_workers_attendance";
export const WORKERS_REPORT = "hide_tab_workers_report";
export const WORKERS_ADVANCES = "hide_tab_workers_advances";
export const EMPLOYEES_LIST = "hide_tab_employees_employees";
export const EMPLOYEES_PAYROLL = "hide_tab_employees_payroll";
export const EMPLOYEES_ATTENDANCE = "hide_tab_employees_attendance";
export const EMPLOYEES_ADVANCES = "hide_tab_employees_advances";
export const EMPLOYEES_BONUSES = "hide_tab_employees_bonuses";
export const EMPLOYEES_WITHDRAWALS = "hide_tab_employees_withdrawals";

export function workerRequirement(req: Request, path: string): FactoryApiAccessRequirement {
  const base = [PAYROLL_WORKERS];

  if (req.method === "GET" && path === "/workers" && String(req.query.profile || "") === "picker") {
    return requirement("factory/payroll-hub", base);
  }
  if (/^\/workers\/\d+\/payrolls(?:\/|$)/.test(path) || path === "/workers/amount-due") {
    return requirement("factory/payroll-hub", [...base, WORKERS_PAYROLL]);
  }
  if (/^\/workers\/\d+\/(?:advances|deductions|advance-balance|bulk-repay-advances)(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_ADVANCES]);
  }
  if (/^\/workers\/\d+\/statement(?:-pdf)?(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_statement"]);
  }
  if (/^\/workers\/\d+\/documents(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_documents"]);
  }
  if (/^\/workers\/\d+\/bales(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_bales"]);
  }
  if (/^\/workers\/\d+\/stats(?:\/|$)/.test(path) || path === "/workers/attendance-report") {
    return requirement("factory/payroll-hub", [...base, WORKERS_REPORT]);
  }
  return requirement("factory/payroll-hub", [...base, WORKERS_LIST]);
}

export function employeeRequirement(path: string): FactoryApiAccessRequirement {
  const base = [PAYROLL_EMPLOYEES];
  if (/^\/employees\/\d+\/(?:deposit|withdraw)(?:\/|$)/.test(path) || path === "/employees/bulk-withdraw") {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_WITHDRAWALS]);
  }
  if (path === "/employees/bulk-payroll") {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_PAYROLL]);
  }
  if (path.includes("/advances")) {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_ADVANCES]);
  }
  if (path.includes("/bonuses")) {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_BONUSES]);
  }
  return requirement("factory/payroll-hub", [...base, EMPLOYEES_LIST]);
}

export function attendanceRequirement(): FactoryApiAccessRequirement {
  return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_ATTENDANCE]);
}

export function importRequirement(path: string): FactoryApiAccessRequirement {
  if (hasPrefix(path, "/import/suppliers") || path === "/import/template/suppliers") {
    return requirement("factory/import", ["hide_tab_import_suppliers"]);
  }
  if (hasPrefix(path, "/import/raw-stock") || path === "/import/template/raw-stock") {
    return requirement("factory/import", ["hide_tab_import_raw_stock"]);
  }
  if (hasPrefix(path, "/import/bales") || path === "/import/template/bales") {
    return requirement("factory/import", ["hide_tab_import_bales"]);
  }
  if (hasPrefix(path, "/import/opening-raw-stock") || path === "/import/template/opening-raw-stock") {
    return requirement("factory/import", ["hide_tab_import_opening_stock"]);
  }
  return requirement("factory/import");
}

export function invoicingRequirement(path: string): FactoryApiAccessRequirement {
  if (
    hasPrefix(path, "/invoice-loading-sessions") ||
    /^\/invoices\/\d+\/(?:loading-|loading-sessions)/.test(path) ||
    /\/create-remaining-proforma(?:\/|$)/.test(path)
  ) {
    return requirement("factory/invoicing", ["hide_invoicing_loadings_tab"]);
  }

  if (hasPrefix(path, "/invoices") || hasPrefix(path, "/sales/invoices")) {
    return requirement("factory/invoicing", ["hide_invoicing_invoices_tab"]);
  }

  if (hasPrefix(path, "/customer-proformas") || hasPrefix(path, "/customer-proforma-lines")) {
    return requirement("factory/invoicing", ["hide_invoicing_proformas_tab"]);
  }

  if (hasPrefix(path, "/customer-orders")) {
    const loadingSpecific =
      /\/(?:bales|loading-list|pending-export|verification-summary|loading-note|bale-removals)(?:\/|$)/.test(path) ||
      /\/create-loading(?:\/|$)/.test(path);
    if (loadingSpecific) {
      return requirement("factory/invoicing", ["hide_invoicing_loadings_tab"]);
    }
    return {
      pageKey: "factory/invoicing",
      tabAlternatives: [["hide_invoicing_invoices_tab"], ["hide_invoicing_loadings_tab"]],
    };
  }

  return requirement("factory/invoicing");
}
