import { describe, expect, it } from "vitest";
import {
  auditPhase3Accounting,
  type Phase3AccountingAuditInput,
  type SaleAuditSnapshot,
} from "../server/services/accounting/phase3AccountingAudit";

function cleanInput(): Phase3AccountingAuditInput {
  return {
    companyId: 7,
    vouchers: [
      {
        voucherId: 101,
        voucherType: "Receipt",
        totalAmount: "125.50",
        ledgerDebit: "125.50",
        ledgerCredit: "125.50",
        ledgerExpectation: "balanced",
      },
      {
        voucherId: 102,
        voucherType: "Payment",
        totalAmount: "80.00",
        ledgerDebit: "80.00",
        ledgerCredit: "80.00",
        ledgerExpectation: "balanced",
      },
      {
        voucherId: 103,
        voucherType: "Sales",
        totalAmount: "250.00",
        ledgerDebit: "250.00",
        ledgerCredit: "250.00",
        ledgerExpectation: "balanced",
      },
    ],
    payments: [
      {
        voucherId: 101,
        voucherType: "Receipt",
        totalAmount: "125.50",
        ledgerDebit: "125.50",
        ledgerCredit: "125.50",
        cashDebit: "125.50",
        cashCredit: "0",
      },
      {
        voucherId: 102,
        voucherType: "Payment",
        totalAmount: "80.00",
        ledgerDebit: "80.00",
        ledgerCredit: "80.00",
        cashDebit: "0",
        cashCredit: "80.00",
      },
    ],
    sales: [
      {
        voucherId: 103,
        totalAmount: "250.00",
        revenueCredit: "250.00",
        soldQuantity: "5",
        recordedCogsValue: "150.00",
        inventoryMovementQuantity: "-5",
        inventoryMovementValue: "-150.00",
      },
    ],
    payrolls: [
      {
        payrollId: 501,
        status: "PAID",
        netSalary: "80.00",
        cashAccountId: 44,
        paymentVoucherCount: 1,
        paymentVoucherTotal: "80.00",
        paymentLedgerDebit: "80.00",
        paymentLedgerCredit: "80.00",
        paymentCashCredit: "80.00",
        daybookCount: 1,
        daybookAmount: "80.00",
      },
    ],
    stock: {
      companyId: 7,
      operationalInventoryValue: "1000.00",
      accountingInventoryValue: "1000.00",
      accountingInventoryAccountCount: 1,
    },
    duplicateEntries: [],
  };
}

function withSale(input: Phase3AccountingAuditInput, sale: SaleAuditSnapshot): Phase3AccountingAuditInput {
  return {
    ...input,
    sales: [sale],
    vouchers: input.vouchers.map((voucher) =>
      voucher.voucherId === sale.voucherId
        ? {
            ...voucher,
            totalAmount: sale.totalAmount,
            ledgerDebit: sale.totalAmount,
            ledgerCredit: sale.totalAmount,
          }
        : voucher
    ),
  };
}

describe("Phase 3 accounting reconciliation", () => {
  it("accepts a fully reconciled company snapshot", () => {
    const report = auditPhase3Accounting(cleanInput());

    expect(report.clean).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checked).toEqual({
      payments: 2,
      vouchers: 3,
      sales: 1,
      payrolls: 1,
      duplicateEntryGroups: 0,
    });
  });

  it("keeps create and edit sale states reconciled when revenue, COGS, and inventory move together", () => {
    const created = auditPhase3Accounting(cleanInput());
    expect(created.clean).toBe(true);

    const edited = auditPhase3Accounting(
      withSale(cleanInput(), {
        voucherId: 103,
        totalAmount: "325.00",
        revenueCredit: "325.00",
        soldQuantity: "7",
        recordedCogsValue: "196.00",
        inventoryMovementQuantity: "-7",
        inventoryMovementValue: "-196.00",
      })
    );

    expect(edited.clean).toBe(true);
  });

  it("requires cancellation/reversal to leave no live sale posting and zero net inventory movement", () => {
    const input = cleanInput();
    input.vouchers = input.vouchers.map((voucher) =>
      voucher.voucherId === 103 ? { ...voucher, cancelled: true } : voucher
    );
    input.sales = [
      {
        voucherId: 103,
        totalAmount: "250.00",
        revenueCredit: "0",
        soldQuantity: "5",
        recordedCogsValue: "150.00",
        inventoryMovementQuantity: "0",
        inventoryMovementValue: "0",
        cancelled: true,
      },
    ];

    expect(auditPhase3Accounting(input).clean).toBe(true);

    input.sales[0] = { ...input.sales[0], inventoryMovementQuantity: "-5", inventoryMovementValue: "-150" };
    expect(auditPhase3Accounting(input).issues.map((issue) => issue.code)).toEqual([
      "CANCELLED_SALE_INVENTORY_NOT_REVERSED",
      "CANCELLED_SALE_VALUE_NOT_REVERSED",
    ]);
  });

  it("detects retry-created duplicate accounting entries instead of treating a second write as success", () => {
    const cleanRetry = cleanInput();
    expect(auditPhase3Accounting(cleanRetry).clean).toBe(true);

    const duplicateRetry = cleanInput();
    duplicateRetry.duplicateEntries = [
      {
        voucherId: 102,
        signature: "ledger=44|dr=0|cr=80|Payroll payment",
        occurrences: 2,
      },
    ];

    const report = auditPhase3Accounting(duplicateRetry);
    expect(report.clean).toBe(false);
    expect(report.issues).toContainEqual({
      domain: "invariants",
      identity: "voucher:102",
      code: "DUPLICATE_ACCOUNTING_ENTRY",
      expected: "1",
      actual: "2 × ledger=44|dr=0|cr=80|Payroll payment",
    });
  });

  it("detects an unbalanced journal and the company-wide debit/credit invariant failure", () => {
    const input = cleanInput();
    input.vouchers.push({
      voucherId: 104,
      voucherType: "Journal",
      totalAmount: "10",
      ledgerDebit: "10",
      ledgerCredit: "9",
      ledgerExpectation: "balanced",
    });

    const codes = auditPhase3Accounting(input).issues.map((issue) => issue.code);
    expect(codes).toContain("VOUCHER_CREDIT_TOTAL_MISMATCH");
    expect(codes).toContain("UNBALANCED_JOURNAL");
    expect(codes).toContain("TOTAL_DEBITS_CREDITS_MISMATCH");
  });

  it("detects payment cash-side mismatches independently from journal balance", () => {
    const input = cleanInput();
    input.payments[1] = { ...input.payments[1], cashCredit: "79.99" };

    expect(auditPhase3Accounting(input).issues).toContainEqual({
      domain: "payments",
      identity: "payment:102",
      code: "PAYMENT_CASH_CREDIT_MISMATCH",
      expected: "80",
      actual: "79.99",
    });
  });

  it("detects missing or duplicated payroll payment evidence", () => {
    const input = cleanInput();
    input.payrolls[0] = {
      ...input.payrolls[0],
      cashAccountId: null,
      paymentVoucherCount: 2,
      paymentVoucherTotal: "160",
      paymentLedgerDebit: "160",
      paymentLedgerCredit: "160",
      paymentCashCredit: "160",
      daybookCount: 0,
      daybookAmount: "0",
    };

    const codes = auditPhase3Accounting(input).issues.map((issue) => issue.code);
    expect(codes).toContain("PAID_PAYROLL_CASH_ACCOUNT_MISSING");
    expect(codes).toContain("PAYROLL_PAYMENT_VOUCHER_COUNT_MISMATCH");
    expect(codes).toContain("PAYROLL_PAYMENT_TOTAL_MISMATCH");
    expect(codes).toContain("PAYROLL_DAYBOOK_COUNT_MISMATCH");
  });

  it("detects sales revenue, COGS, quantity, and inventory-value divergence", () => {
    const input = cleanInput();
    input.sales[0] = {
      ...input.sales[0],
      revenueCredit: "249.99",
      inventoryMovementQuantity: "-4",
      inventoryMovementValue: "-149.99",
    };

    expect(auditPhase3Accounting(input).issues.map((issue) => issue.code)).toEqual([
      "SALE_REVENUE_MISMATCH",
      "SALE_INVENTORY_QUANTITY_MISMATCH",
      "SALE_COGS_INVENTORY_VALUE_MISMATCH",
    ]);
  });

  it("detects missing stock-account mapping and stock/accounting value mismatches", () => {
    const missing = cleanInput();
    missing.stock = {
      companyId: 7,
      operationalInventoryValue: "500",
      accountingInventoryValue: "0",
      accountingInventoryAccountCount: 0,
    };
    expect(auditPhase3Accounting(missing).issues.map((issue) => issue.code)).toContain(
      "STOCK_ACCOUNTING_MAPPING_MISSING"
    );

    const mismatched = cleanInput();
    mismatched.stock.accountingInventoryValue = "999.99";
    expect(auditPhase3Accounting(mismatched).issues.map((issue) => issue.code)).toContain(
      "STOCK_ACCOUNTING_VALUE_MISMATCH"
    );
  });

  it("does not carry cancelled payments into live cash invariants", () => {
    const input = cleanInput();
    input.payments[1] = {
      ...input.payments[1],
      cancelled: true,
      ledgerDebit: "160",
      ledgerCredit: "0",
      cashCredit: "0",
    };
    input.vouchers = input.vouchers.map((voucher) =>
      voucher.voucherId === 102 ? { ...voucher, cancelled: true } : voucher
    );
    input.payrolls = [];

    expect(auditPhase3Accounting(input).clean).toBe(true);
  });
});
