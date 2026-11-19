// Extracted from ./operationalVoucherRequestBoundary.ts

export const REQUEST_KEY_MAX = 180;

export const CONCURRENT_REPLAY_WAIT_MS = 15_000;

export const CONCURRENT_REPLAY_POLL_MS = 50;

export const PHASE4_OPERATIONAL_POST_PATHS = new Set([
  "/api/vouchers",
  "/api/vouchers/with-entries",
  "/api/vouchers/journal",
  "/api/vouchers/journal-entries",
  "/api/vouchers/payment-receipt",
  "/api/salary-advances",
  "/api/payroll/bonus-employee",
  "/api/payroll/bulk-bonus-employees",
  "/api/payroll/bulk-withdraw-employees",
  "/api/payroll/deposit-employee",
  "/api/payroll/bulk-deposit-employees",
  "/api/payroll/withdraw-employee",
  "/api/payroll/pay-worker",
  "/api/payroll/bulk-pay-workers",
  "/api/factory/employees/bulk-payroll",
  "/api/factory/employees/bulk-withdraw",
  "/api/factory/employee-bonuses",
  "/api/factory/pos/sale",
  "/api/factory/supplier-payments",
  "/api/factory/advances/cash-adjustment",
  "/api/factory/advances/repay-by-month",
  "/api/factory/advances/post-repayment-vouchers",
  "/api/factory/payrolls/mark-paid-bulk",
]);

export type JsonRecord = Record<string, unknown>;

export type StoredOperationalRequest = {
  requestPath: string;
  requestFingerprint: string;
  state: string;
  responseStatus: number | null;
  responseBody: unknown;
};
