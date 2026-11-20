import { describe, expect, it } from "vitest";

import {
  auditPhase3Accounting,
  type Phase3AccountingAuditInput,
} from "../server/services/accounting/phase3AccountingAudit";

function base(overrides: Partial<Phase3AccountingAuditInput> = {}): Phase3AccountingAuditInput {
  return {
    companyId: 9,
    payments: [],
    vouchers: [],
    sales: [],
    payrolls: [],
    stock: {
      companyId: 9,
      operationalInventoryValue: "0",
      accountingInventoryValue: "0",
      accountingInventoryAccountCount: 0,
    },
    duplicateEntries: [],
    ...overrides,
  };
}

function codes(input: Phase3AccountingAuditInput) {
  return auditPhase3Accounting(input).issues.map((issue) => issue.code);
}

describe("auditPhase3Accounting input guards", () => {
  it("refuses bad company ids, crossed stock snapshots and duplicate snapshots", () => {
    expect(() => auditPhase3Accounting(base({ companyId: 0 }))).toThrow(/companyId must be a positive integer/);
    expect(() => auditPhase3Accounting(base({ stock: { ...base().stock, companyId: 10 } }))).toThrow(
      expect.objectContaining({ code: "PHASE3_COMPANY_MISMATCH" })
    );
    const payroll = {
      payrollId: 4,
      status: "draft",
      netSalary: "0",
      cashAccountId: null,
      paymentVoucherCount: 0,
      paymentVoucherTotal: "0",
      paymentLedgerDebit: "0",
      paymentLedgerCredit: "0",
      paymentCashCredit: "0",
      daybookCount: 0,
      daybookAmount: "0",
    };
    expect(() => auditPhase3Accounting(base({ payrolls: [payroll, payroll] }))).toThrow(
      expect.objectContaining({ code: "PHASE3_DUPLICATE_SNAPSHOT" })
    );
  });

  it("refuses non-finite decimals and negative counts", () => {
    expect(() =>
      auditPhase3Accounting(
        base({
          vouchers: [
            {
              voucherId: 1,
              voucherType: "Journal",
              totalAmount: "Infinity",
              ledgerDebit: "0",
              ledgerCredit: "0",
              ledgerExpectation: "balanced",
            },
          ],
        })
      )
    ).toThrow(expect.objectContaining({ code: "PHASE3_DECIMAL_INVALID" }));
    expect(() => auditPhase3Accounting(base({ stock: { ...base().stock, operationalInventoryValue: "abc" } }))).toThrow(
      expect.objectContaining({ code: "PHASE3_DECIMAL_INVALID" })
    );
    expect(() =>
      auditPhase3Accounting(base({ stock: { ...base().stock, accountingInventoryAccountCount: -1 } }))
    ).toThrow(expect.objectContaining({ code: "PHASE3_COUNT_INVALID" }));
  });
});

describe("auditPhase3Accounting voucher expectations", () => {
  const voucher = (
    voucherId: number,
    ledgerExpectation: Phase3AccountingAuditInput["vouchers"][number]["ledgerExpectation"],
    debit: string,
    credit: string,
    extra: Partial<Phase3AccountingAuditInput["vouchers"][number]> = {}
  ) => ({
    voucherId,
    voucherType: "Misc",
    totalAmount: "10",
    ledgerDebit: debit,
    ledgerCredit: credit,
    ledgerExpectation,
    ...extra,
  });

  it("flags every voucher-shape problem and skips cancelled vouchers", () => {
    const report = auditPhase3Accounting(
      base({
        vouchers: [
          voucher(1, "unclassified", "0", "0"),
          voucher(2, "balanced", "10", "9", { voucherType: "Journal" }),
          voucher(3, "balanced", "10", "8"),
          voucher(4, "balanced-only", "5", "5"),
          voucher(5, "single-sided", "0", "0"),
          voucher(6, "single-sided", "4", "3"),
          voucher(7, "single-sided", "4", "4"),
          voucher(8, "single-sided", "4", "0"),
          voucher(9, "inventory-sided", "0", "0"),
          voucher(10, "inventory-sided", "0", "2"),
          voucher(11, "none", "1", "0"),
          voucher(12, "none", "0", "0"),
          voucher(13, "unclassified", "0", "0", { cancelled: true }),
          voucher(14, "balanced", "10", "10", { documentDebit: "12", documentCredit: "10" }),
        ],
      })
    );
    const byId = (id: number) => report.issues.filter((issue) => issue.identity === `voucher:${id}`);
    expect(byId(1).map((i) => i.code)).toEqual(["VOUCHER_TYPE_UNCLASSIFIED"]);
    expect(byId(2).map((i) => i.code)).toEqual(["VOUCHER_CREDIT_TOTAL_MISMATCH", "UNBALANCED_JOURNAL"]);
    expect(byId(3).map((i) => i.code)).toEqual(["VOUCHER_CREDIT_TOTAL_MISMATCH", "UNBALANCED_VOUCHER"]);
    expect(byId(4)).toEqual([]);
    expect(byId(5)).toEqual([expect.objectContaining({ actual: "no ledger side" })]);
    expect(byId(6)).toEqual([expect.objectContaining({ actual: "both ledger sides, unequal" })]);
    expect(byId(7)).toEqual([]);
    expect(byId(8)).toEqual([]);
    expect(byId(9).map((i) => i.code)).toEqual(["INVENTORY_SIDED_VOUCHER_EMPTY"]);
    expect(byId(10)).toEqual([]);
    expect(byId(11)).toEqual([expect.objectContaining({ code: "NO_LEDGER_VOUCHER_HAS_ENTRIES", actual: "1 / 0" })]);
    expect(byId(12)).toEqual([]);
    expect(byId(13)).toEqual([]);
    expect(byId(14).map((i) => i.code)).toEqual(["VOUCHER_DEBIT_TOTAL_MISMATCH"]);
    expect(report.issues.find((i) => i.code === "TOTAL_DEBITS_CREDITS_MISMATCH")).toMatchObject({
      expected: "35",
      actual: "32",
    });
    expect(report.clean).toBe(false);
    expect(report.checked.vouchers).toBe(14);
  });
});

describe("auditPhase3Accounting payments, sales, payroll, stock and duplicates", () => {
  it("checks payment and receipt cash sides and ignores cancelled payments", () => {
    expect(
      codes(
        base({
          payments: [
            {
              voucherId: 1,
              voucherType: "Payment",
              totalAmount: "10",
              ledgerDebit: "10",
              ledgerCredit: "9",
              cashDebit: "0",
              cashCredit: "9",
            },
            {
              voucherId: 2,
              voucherType: "Receipt",
              totalAmount: "5",
              ledgerDebit: "5",
              ledgerCredit: "5",
              cashDebit: "4",
              cashCredit: "0",
            },
            {
              voucherId: 3,
              voucherType: "Payment",
              totalAmount: "x",
              ledgerDebit: "0",
              ledgerCredit: "0",
              cashDebit: "0",
              cashCredit: "0",
              cancelled: true,
            },
          ],
        })
      )
    ).toEqual(["PAYMENT_LEDGER_NOT_BALANCED", "PAYMENT_CASH_CREDIT_MISMATCH", "RECEIPT_CASH_DEBIT_MISMATCH"]);
  });

  it("checks sale revenue, quantity, COGS and cancelled reversals", () => {
    const sale = {
      totalAmount: "100",
      revenueCredit: "90",
      soldQuantity: "-3",
      recordedCogsValue: "30",
      inventoryMovementQuantity: "-2",
      inventoryMovementValue: "-25",
    };
    expect(
      codes(
        base({
          sales: [
            { voucherId: 1, ...sale },
            { voucherId: 2, ...sale, revenueRequired: false },
            { voucherId: 3, ...sale, cancelled: true },
            { voucherId: 4, ...sale, cancelled: true, inventoryMovementQuantity: "0", inventoryMovementValue: "0" },
          ],
        })
      )
    ).toEqual([
      "SALE_REVENUE_MISMATCH",
      "SALE_INVENTORY_QUANTITY_MISMATCH",
      "SALE_COGS_INVENTORY_VALUE_MISMATCH",
      "SALE_INVENTORY_QUANTITY_MISMATCH",
      "SALE_COGS_INVENTORY_VALUE_MISMATCH",
      "CANCELLED_SALE_INVENTORY_NOT_REVERSED",
      "CANCELLED_SALE_VALUE_NOT_REVERSED",
    ]);
  });

  it("checks unpaid, zero, broken and correct paid payrolls", () => {
    const payroll = {
      status: "PAID",
      netSalary: "100",
      cashAccountId: 7,
      paymentVoucherCount: 1,
      paymentVoucherTotal: "100",
      paymentLedgerDebit: "100",
      paymentLedgerCredit: "100",
      paymentCashCredit: "100",
      daybookCount: 1,
      daybookAmount: "100",
    };
    const report = auditPhase3Accounting(
      base({
        payrolls: [
          { payrollId: 1, ...payroll, status: "draft", paymentVoucherCount: 1, daybookCount: 2 },
          { payrollId: 2, ...payroll, status: "pending", paymentVoucherCount: 0, daybookCount: 0 },
          { payrollId: 3, ...payroll, netSalary: "0", cashAccountId: null },
          {
            payrollId: 4,
            ...payroll,
            status: "paid",
            cashAccountId: null,
            paymentVoucherCount: 2,
            paymentVoucherTotal: "90",
            paymentLedgerDebit: "80",
            paymentLedgerCredit: "70",
            paymentCashCredit: "60",
            daybookCount: 0,
            daybookAmount: "0",
          },
          { payrollId: 5, ...payroll },
        ],
      })
    );
    expect(report.issues.map((i) => [i.identity, i.code])).toEqual([
      ["payroll:1", "UNPAID_PAYROLL_HAS_PAYMENT_VOUCHER"],
      ["payroll:1", "UNPAID_PAYROLL_HAS_DAYBOOK_PAYMENT"],
      ["payroll:4", "PAID_PAYROLL_CASH_ACCOUNT_MISSING"],
      ["payroll:4", "PAYROLL_PAYMENT_VOUCHER_COUNT_MISMATCH"],
      ["payroll:4", "PAYROLL_PAYMENT_TOTAL_MISMATCH"],
      ["payroll:4", "PAYROLL_PAYMENT_DEBIT_MISMATCH"],
      ["payroll:4", "PAYROLL_PAYMENT_CREDIT_MISMATCH"],
      ["payroll:4", "PAYROLL_CASH_CREDIT_MISMATCH"],
      ["payroll:4", "PAYROLL_DAYBOOK_COUNT_MISMATCH"],
      ["payroll:4", "PAYROLL_DAYBOOK_AMOUNT_MISMATCH"],
    ]);
  });

  it("flags missing stock mapping, value drift and over-posted duplicate lines", () => {
    expect(codes(base({ stock: { ...base().stock, operationalInventoryValue: "50" } }))).toEqual([
      "STOCK_ACCOUNTING_MAPPING_MISSING",
    ]);
    expect(
      codes(
        base({
          stock: {
            companyId: 9,
            operationalInventoryValue: "50",
            accountingInventoryValue: "49",
            accountingInventoryAccountCount: 1,
          },
        })
      )
    ).toEqual(["STOCK_ACCOUNTING_VALUE_MISMATCH"]);
    const clean = auditPhase3Accounting(
      base({
        stock: {
          companyId: 9,
          operationalInventoryValue: "50",
          accountingInventoryValue: "50.001",
          accountingInventoryAccountCount: 2,
        },
        duplicateEntries: [{ voucherId: 3, signature: "dr=5", occurrences: 1 }],
      })
    );
    expect(clean).toMatchObject({ clean: true, issues: [], checked: { duplicateEntryGroups: 1 } });
    expect(
      auditPhase3Accounting(base({ duplicateEntries: [{ voucherId: 3, signature: "dr=5", occurrences: 3 }] })).issues
    ).toEqual([
      {
        domain: "invariants",
        identity: "voucher:3",
        code: "DUPLICATE_ACCOUNTING_ENTRY",
        expected: "1",
        actual: "3 × dr=5",
      },
    ]);
  });
});
