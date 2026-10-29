import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  statements: [] as string[],
  transaction: vi.fn(),
  voucher: vi.fn(),
  daybook: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("drizzle-orm", () => ({
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }),
}));
vi.mock("../server/db", () => ({
  db: { transaction: harness.transaction },
}));
vi.mock("../server/lib/queryResult", () => ({
  resultRows: (value: { rows?: unknown[] }) => value.rows ?? [],
}));
vi.mock("../server/lib/httpHandlers", () => ({
  HttpError: class HttpError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
  },
}));
vi.mock("../server/services/accounting/erpVoucherPosting", () => ({
  postErpVoucherTx: harness.voucher,
}));
vi.mock("../server/services/factory/factoryDaybookWriter", () => ({
  writeDaybookEntry: harness.daybook,
}));
vi.mock("../server/routes/helpers/auditHelpers", () => ({
  logAudit: harness.audit,
}));

import {
  postTargetBonusPayments,
  reverseTargetBonusPayment,
} from "../server/services/factory/targetBonusPaymentService";

const actor = { userId: "user-admin", username: "Administrator" };
const command = {
  paymentDate: "2026-10-30", currency: "USD", cashAccountId: 41, confirm: true,
  selections: [{ date: "2026-10-29", workerId: 8, expectedAmount: "9.50" }],
};

function fakeExecute(query: { parts: readonly string[]; values: unknown[] }) {
  const source = query.parts.join("?").replace(/\s+/g, " ");
  harness.statements.push(source);
  const value = (phrase: string): unknown[] => harness.responses.get(phrase) as unknown[] ?? [];
  if (source.includes("SELECT pg_advisory_xact_lock")) return Promise.resolve({ rows: [] });
  if (source.includes("FROM ledger_accounts") && source.includes("account_type AS"))
    return Promise.resolve({ rows: [{ id: 41, active: true, accountType: "Cash", openingCurrency: "USD" }] });
  if (source.includes("FROM factory_target_bonus_reviews rv"))
    return Promise.resolve({ rows: value("review") });
  if (source.includes("FROM factory_workers WHERE"))
    return Promise.resolve({ rows: [{ id: 8, fullName: "Worker Eight" }] });
  if (source.includes("FROM factory_staff_tracking_period_closures"))
    return Promise.resolve({ rows: [{ ready: 1 }] });
  if (source.includes("SELECT id, review_id AS") && source.includes("FROM factory_target_bonus_payments"))
    return Promise.resolve({ rows: value("reversal") });
  if (source.includes("FROM factory_target_bonus_payments") && source.includes("FOR UPDATE"))
    return Promise.resolve({ rows: value("payment") });
  if (source.includes("FROM factory_production_bonus_allocations"))
    return Promise.resolve({ rows: value("payroll") });
  if (source.includes("INSERT INTO factory_target_bonus_payments"))
    return Promise.resolve({ rows: [{ id: 304 }] });
  if (source.includes("FROM factory_target_bonus_payments") && source.includes("WHERE company_id"))
    return Promise.resolve({ rows: value("reversal") });
  if (source.includes("SELECT id, active, sub_type"))
    return Promise.resolve({ rows: [{ id: 51, active: true, subType: null }] });
  return Promise.resolve({ rows: [] });
}

describe("Production Targets payout transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.responses.clear();
    harness.statements.length = 0;
    harness.responses.set("review", [{
      id: 11, workerId: 8, date: "2026-10-29", status: "approved", amount: "9.50", extraBales: "2",
    }]);
    harness.voucher.mockResolvedValue({ voucher: { id: 99 }, replayed: false });
    harness.daybook.mockResolvedValue({ id: 1 });
    harness.audit.mockResolvedValue(undefined);
    harness.transaction.mockImplementation(async (fn: (tx: { execute: typeof fakeExecute }) => unknown) =>
      fn({ execute: fakeExecute }));
  });

  it("posts a balanced Deposit Expense voucher, payment record, daybook and audit together", async () => {
    const result = await postTargetBonusPayments(3, command, actor);
    expect(result.posted).toBe(1);
    expect(result.results[0]).toMatchObject({ paymentId: 304, reviewId: 11, amount: "9.50", replayed: false });
    expect(harness.voucher).toHaveBeenCalledOnce();
    expect(harness.voucher.mock.calls[0][1]).toMatchObject({
      companyId: 3, voucherType: "Payment", voucherDate: "2026-10-30",
      lines: [
        { ledgerAccountId: 51, debit: "9.50" },
        { ledgerAccountId: 41, credit: "9.50" },
      ],
    });
    expect(harness.statements.some((sql) => sql.includes("INSERT INTO factory_target_bonus_payments"))).toBe(true);
    expect(harness.daybook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      txType: "PRODUCTION_TARGET_BONUS_PAYMENT", amountUsd: 9.5,
    }));
    expect(harness.audit).toHaveBeenCalledOnce();
  });

  it("rejects unapproved reviews before creating vouchers", async () => {
    harness.responses.set("review", [{
      id: 11, workerId: 8, date: "2026-10-29", status: "rejected", amount: "9.50", extraBales: "2",
    }]);
    await expect(postTargetBonusPayments(3, command, actor)).rejects.toThrow(/approved/);
    expect(harness.voucher).not.toHaveBeenCalled();
  });

  it("rejects duplicate payroll allocation for same worker/date", async () => {
    harness.responses.set("payroll", [{ blocked: 1 }]);
    await expect(postTargetBonusPayments(3, command, actor)).rejects.toThrow(/payroll/);
    expect(harness.voucher).not.toHaveBeenCalled();
  });

  it("exactly replays identical payment without posting a second voucher", async () => {
    harness.responses.set("payment", [{
      id: 304, amount: "9.50", status: "POSTED",
      cashAccountId: 41, paymentDate: "2026-10-30", currency: "USD", voucherId: 99,
    }]);
    const result = await postTargetBonusPayments(3, command, actor);
    expect(result.replayed).toBe(1);
    expect(result.posted).toBe(0);
    expect(harness.voucher).not.toHaveBeenCalled();
  });

  it("preserves a reversed payout claim, prohibiting re-payment", async () => {
    harness.responses.set("payment", [{
      id: 304, amount: "9.50", status: "REVERSED",
      cashAccountId: 41, paymentDate: "2026-10-30", currency: "USD", voucherId: 99,
    }]);
    await expect(postTargetBonusPayments(3, command, actor)).rejects.toThrow(/already paid or reversed/);
    expect(harness.voucher).not.toHaveBeenCalled();
  });

  it("reverses by a separate balanced receipt voucher without deleting original", async () => {
    harness.responses.set("reversal", [{
      id: 304, reviewId: 11, workerId: 8, amount: "9.50",
      productionDate: "2026-10-29", paymentDate: "2026-10-30",
      cashAccountId: 41, expenseAccountId: 51, status: "POSTED", reversalVoucherId: null,
    }]);
    const result = await reverseTargetBonusPayment(3, 304, "2026-10-31", "Wrong payment", actor);
    expect(result).toMatchObject({ reversed: true, replayed: false, voucherId: 99 });
    expect(harness.voucher.mock.calls[0][1]).toMatchObject({
      voucherType: "Receipt",
      lines: [{ ledgerAccountId: 41, debit: "9.50" }, { ledgerAccountId: 51, credit: "9.50" }],
    });
    expect(harness.statements.some((text) => text.includes("SET status='REVERSED'"))).toBe(true);
    expect(harness.daybook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountUsd: -9.5 }));
  });
});
