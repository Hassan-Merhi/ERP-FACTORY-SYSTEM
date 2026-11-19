import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachAccountingRequestIdentity,
  isProtectedAccountingRequest,
  markAccountingRequestOutcomeUncertain,
  releaseAccountingRequestIdentity,
  shouldReleaseAccountingRequestIdentity,
} from "../client/src/lib/accountingRequestIdentity";
import voucherReview from "../config/voucher-write-evidence-review.json";
import writeEvidenceBaseline from "../config/write-evidence-baseline.json";
import { auditWriteEvidence } from "../scripts/audit-write-evidence.mjs";
import {
  isPhase4OperationalVoucherRequest,
  resolvePhase4OperationalVoucherCompanyId,
} from "../server/services/accounting/operationalVoucherRequestBoundary";

const PHASE4_WRITERS = [
  "server/routes/employees/salaryAdvanceRoutes.ts",
  "server/routes/erp-payroll/bonuses.ts",
  "server/routes/erp-payroll/bulk-adjustments.ts",
  "server/routes/erp-payroll/employee-deposits.ts",
  "server/routes/erp-payroll/runs.ts",
  "server/routes/erp-payroll/withdrawals.ts",
  "server/routes/erp-payroll/worker-payments.ts",
  "server/routes/factory/employee-pos/employee-crud/bulk-payroll.ts",
  "server/routes/factory/employee-pos/employee-crud/bulk-withdraw.ts",
  "server/routes/factory/employee-pos/employee-crud/cash.ts",
  "server/routes/factory/employee-pos/employeeAdvancesBonusRoutes.ts",
  "server/routes/factory/employee-pos/pos-financial/sale-write.ts",
  "server/routes/factory/suppliers/crud/payments.ts",
  "server/routes/payroll/advance-accounting/bulk-repay.ts",
  "server/routes/payroll/advance-accounting/cash.ts",
  "server/routes/payroll/advance-accounting/repay-by-month.ts",
  "server/routes/payroll/advance-accounting/repayment-audit.ts",
  "server/routes/payroll/advance-accounting/repayments.ts",
  "server/routes/payroll/core/mark-paid.ts",
  "server/routes/vouchers/voucherCreateRoutes.ts",
  "server/routes/vouchers/voucherJournalRoutes.ts",
  "server/routes/vouchers/voucherPaymentRoutes.ts",
] as const;

type Method = "POST" | "PATCH";
type RouteCase = [Method, string, Record<string, unknown>];

const ROUTES: RouteCase[] = [
  ["POST", "/api/vouchers", { voucherType: "Journal" }],
  ["POST", "/api/vouchers/with-entries", { voucher: { optional: false }, entries: [] }],
  ["POST", "/api/vouchers/journal", { optional: false }],
  ["POST", "/api/vouchers/journal-entries", { optional: false }],
  ["POST", "/api/vouchers/payment-receipt", { voucherType: "Payment", optional: false }],
  ["POST", "/api/salary-advances", { amount: "10.00" }],
  ["POST", "/api/payroll/bonus-employee", { amount: "10.00" }],
  ["POST", "/api/payroll/bulk-bonus-employees", { amount: "10.00" }],
  ["POST", "/api/payroll/bulk-withdraw-employees", { amount: "10.00" }],
  ["POST", "/api/payroll/deposit-employee", { amount: "10.00" }],
  ["POST", "/api/payroll/bulk-deposit-employees", { amount: "10.00" }],
  ["PATCH", "/api/payroll/runs/42", { action: "pay", paymentAccountId: 9 }],
  ["POST", "/api/payroll/withdraw-employee", { amount: "10.00" }],
  ["POST", "/api/payroll/pay-worker", { amount: "10.00" }],
  ["POST", "/api/payroll/bulk-pay-workers", { amount: "10.00" }],
  ["POST", "/api/factory/employees/bulk-payroll", { amount: "10.00" }],
  ["POST", "/api/factory/employees/bulk-withdraw", { amount: "10.00" }],
  ["POST", "/api/factory/employees/42/deposit", { amount: "10.00" }],
  ["POST", "/api/factory/employees/42/withdraw", { amount: "10.00" }],
  ["POST", "/api/factory/employee-bonuses", { amount: "10.00" }],
  ["POST", "/api/factory/worker-bonuses/42/pay", { cashAccountId: 9 }],
  ["POST", "/api/factory/pos/sale", { amount: "10.00" }],
  ["POST", "/api/factory/supplier-payments", { amount: "10.00" }],
  ["POST", "/api/factory/workers/42/bulk-repay-advances", { amount: "10.00" }],
  ["POST", "/api/factory/advances/cash-adjustment", { amount: "10.00" }],
  ["POST", "/api/factory/advances/repay-by-month", { month: "2026-08" }],
  ["POST", "/api/factory/advances/post-repayment-vouchers", { cashAccountId: 9 }],
  ["POST", "/api/factory/advances/42/repayments", { amount: "10.00" }],
  ["PATCH", "/api/factory/payrolls/42/mark-paid", { cashAccountId: 9 }],
  ["PATCH", "/api/factory/payrolls/42/fix-accounting", { cashAccountId: 9 }],
  ["POST", "/api/factory/payrolls/mark-paid-bulk", { cashAccountId: 9 }],
];

const NEGATIVE_ROUTES = [
  ["GET", "/api/vouchers", {}],
  ["POST", "/api/credit-notes", {}],
  ["POST", "/api/payroll/auto-calculate-bonuses", {}],
  ["POST", "/api/payroll/runs", {}],
  ["PATCH", "/api/payroll/runs/42", { action: "update" }],
  ["POST", "/api/factory/employee-advances", {}],
  ["PUT", "/api/factory/pos/sales/42", {}],
  ["PATCH", "/api/vouchers/42/journal", {}],
] as const;

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("Phase 4 operational voucher retry boundary", () => {
  it("keeps exactly the 22 reviewed Phase 4 writers pinned as completed", () => {
    expect(voucherReview.summary.phase4OperationalCompleted).toBe(22);
    expect(voucherReview.summary.unreviewed).toBe(0);
    expect(voucherReview.completed["phase-4-operational-writers"].files).toEqual(PHASE4_WRITERS);
  });

  it("keeps every Phase 4 writer out of the remaining measured identity backlog", () => {
    const baseline = writeEvidenceBaseline.voucherWritesWithoutRequestIdentity;
    const measured = auditWriteEvidence();
    const remaining = new Set(measured.voucherWritesWithoutRequestIdentity);

    expect(baseline.ceiling).toBeGreaterThanOrEqual(measured.voucherWritesWithoutRequestIdentity.length);
    expect(measured.unapprovedDirectVoucherCreation).toEqual([]);
    for (const file of PHASE4_WRITERS) expect(remaining.has(file)).toBe(false);
  });

  it("protects every voucher-creation operation in the completed cohort", () => {
    expect(ROUTES).toHaveLength(31);
    for (const [method, url, data] of ROUTES) {
      expect(isPhase4OperationalVoucherRequest(method, url, data)).toBe(true);
      expect(isProtectedAccountingRequest(method, url, data)).toBe(true);
    }
  });

  it("does not widen Phase 4 onto non-voucher sibling operations", () => {
    for (const [method, url, data] of NEGATIVE_ROUTES) {
      expect(isPhase4OperationalVoucherRequest(method, url, data)).toBe(false);
      expect(isProtectedAccountingRequest(method, url, data)).toBe(false);
    }
  });

  it("resolves the posting company from authenticated server-owned session context", () => {
    const erpRequest = {
      path: "/api/payroll/pay-worker",
      session: { userId: 7, currentCompanyId: 12 },
    } as unknown as Parameters<typeof resolvePhase4OperationalVoucherCompanyId>[0];
    const factoryRequest = {
      path: "/api/factory/payrolls/mark-paid-bulk",
      session: { userId: 7, currentCompanyId: 12, factoryCompanyId: 34 },
    } as unknown as Parameters<typeof resolvePhase4OperationalVoucherCompanyId>[0];
    const unauthenticatedRequest = {
      path: "/api/payroll/pay-worker",
      session: { currentCompanyId: 12 },
    } as unknown as Parameters<typeof resolvePhase4OperationalVoucherCompanyId>[0];

    expect(resolvePhase4OperationalVoucherCompanyId(erpRequest)).toBe(12);
    expect(resolvePhase4OperationalVoucherCompanyId(factoryRequest)).toBe(34);
    expect(resolvePhase4OperationalVoucherCompanyId(unauthenticatedRequest)).toBeNull();
  });

  it("persists and reuses the first browser identity until a definite outcome releases it", () => {
    const values = new Map<string, string>();
    const localStorage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } as Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    const payload = { amount: "37.25", accountId: 9 };
    const first = attachAccountingRequestIdentity("POST", "/api/salary-advances", payload) as {
      clientRequestId: string;
    };
    const retry = attachAccountingRequestIdentity("POST", "/api/salary-advances", payload) as {
      clientRequestId: string;
    };

    expect(first.clientRequestId).toBe(retry.clientRequestId);
    expect(values.size).toBe(1);
    releaseAccountingRequestIdentity("POST", "/api/salary-advances", retry, true);

    const next = attachAccountingRequestIdentity("POST", "/api/salary-advances", payload) as {
      clientRequestId: string;
    };
    expect(next.clientRequestId).not.toBe(first.clientRequestId);
    releaseAccountingRequestIdentity("POST", "/api/salary-advances", next, true);
  });

  it("keeps an uncertain identity across legacy release attempts and long delays", () => {
    const payload = { amount: "91.75", accountId: 44 };
    const first = attachAccountingRequestIdentity("POST", "/api/payroll/pay-worker", payload) as {
      clientRequestId: string;
    };

    expect(shouldReleaseAccountingRequestIdentity(409, "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN")).toBe(false);
    markAccountingRequestOutcomeUncertain("POST", "/api/payroll/pay-worker", first);
    releaseAccountingRequestIdentity("POST", "/api/payroll/pay-worker", first);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000);
    const retry = attachAccountingRequestIdentity("POST", "/api/payroll/pay-worker", payload) as {
      clientRequestId: string;
    };
    expect(retry.clientRequestId).toBe(first.clientRequestId);
    releaseAccountingRequestIdentity("POST", "/api/payroll/pay-worker", retry, true);
  });

  it("releases definite client outcomes but retains unknown 409 and server outcomes", () => {
    expect(shouldReleaseAccountingRequestIdentity(422, "VALIDATION_ERROR")).toBe(true);
    expect(shouldReleaseAccountingRequestIdentity(409, "POSTING_IDEMPOTENCY_CONFLICT")).toBe(true);
    expect(shouldReleaseAccountingRequestIdentity(409)).toBe(false);
    expect(shouldReleaseAccountingRequestIdentity(500)).toBe(false);
  });

  it("keeps optional manual vouchers outside the active posting boundary", () => {
    expect(isProtectedAccountingRequest("POST", "/api/vouchers", { optional: true })).toBe(false);
    expect(
      isProtectedAccountingRequest("POST", "/api/vouchers/with-entries", {
        voucher: { optional: true },
        entries: [],
      })
    ).toBe(false);
  });
});
