import { describe, expect, it } from "vitest";

import {
  auditHistoricalReconciliationCorruption,
  type HistoricalReconciliationCorruptionInput,
} from "../server/services/accounting/historicalReconciliationCorruptionAudit";

function cleanInput(): HistoricalReconciliationCorruptionInput {
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
    sales: [],
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
    duplicateVouchers: [],
    supplierBalances: [],
    intercompanyBalances: [],
  };
}

function issueCodes(input: HistoricalReconciliationCorruptionInput): string[] {
  return auditHistoricalReconciliationCorruption(input).issues.map((issue) => issue.code);
}

describe("Phase 29 historical reconciliation corruption detection", () => {
  it("accepts reconciled historical evidence", () => {
    const input = cleanInput();
    input.duplicateVouchers = [{ signature: "PO-2026-001", voucherIds: [101] }];
    input.supplierBalances = [{ supplierId: 21, statementBalance: "450", counterpartyBalance: "450.00" }];
    input.intercompanyBalances = [
      {
        transferId: 77,
        fromCompanyId: 7,
        toCompanyId: 8,
        transferAmount: "100",
        fromVoucherAmount: "100.00",
        toVoucherAmount: "100.00",
      },
    ];

    const report = auditHistoricalReconciliationCorruption(input);
    expect(report.clean).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checked.duplicateVoucherGroups).toBe(1);
    expect(report.checked.supplierBalances).toBe(1);
    expect(report.checked.intercompanyBalances).toBe(1);
  });

  it("detects duplicate historical voucher identities", () => {
    const input = cleanInput();
    input.duplicateVouchers = [{ signature: "PO-2026-001", voucherIds: [101, 801, 801] }];

    expect(issueCodes(input)).toContain("DUPLICATE_VOUCHER");
  });

  it("detects an unbalanced historical journal", () => {
    const input = cleanInput();
    input.vouchers.push({
      voucherId: 103,
      voucherType: "Journal",
      totalAmount: "50",
      ledgerDebit: "50",
      ledgerCredit: "49",
      ledgerExpectation: "balanced",
    });

    const codes = issueCodes(input);
    expect(codes).toContain("UNBALANCED_JOURNAL");
    expect(codes).toContain("TOTAL_DEBITS_CREDITS_MISMATCH");
  });

  it("detects stock/accounting valuation drift", () => {
    const input = cleanInput();
    input.stock.accountingInventoryValue = "982.35";

    expect(issueCodes(input)).toContain("STOCK_ACCOUNTING_VALUE_MISMATCH");
  });

  it("detects payroll/Daybook mismatch", () => {
    const input = cleanInput();
    input.payrolls[0] = {
      ...input.payrolls[0],
      daybookCount: 1,
      daybookAmount: "79.00",
    };

    expect(issueCodes(input)).toContain("PAYROLL_DAYBOOK_AMOUNT_MISMATCH");
  });

  it("detects supplier statement/counterparty mismatch", () => {
    const input = cleanInput();
    input.supplierBalances = [{ supplierId: 21, statementBalance: "450.00", counterpartyBalance: "449.00" }];

    expect(issueCodes(input)).toContain("SUPPLIER_RECONCILIATION_MISMATCH");
  });

  it("detects intercompany source, destination and mirrored-side mismatch", () => {
    const input = cleanInput();
    input.intercompanyBalances = [
      {
        transferId: 77,
        fromCompanyId: 7,
        toCompanyId: 8,
        transferAmount: "100.00",
        fromVoucherAmount: "100.00",
        toVoucherAmount: "99.00",
      },
    ];

    const codes = issueCodes(input);
    expect(codes).toContain("INTERCOMPANY_DESTINATION_AMOUNT_MISMATCH");
    expect(codes).toContain("INTERCOMPANY_MIRROR_MISMATCH");
  });

  it("detects all six requested corruption classes in one historical audit", () => {
    const input = cleanInput();
    input.duplicateVouchers = [{ signature: "LEGACY-RETRY-001", voucherIds: [9001, 9002] }];
    input.vouchers.push({
      voucherId: 103,
      voucherType: "Journal",
      totalAmount: "50",
      ledgerDebit: "50",
      ledgerCredit: "49",
      ledgerExpectation: "balanced",
    });
    input.stock.accountingInventoryValue = "950.00";
    input.payrolls[0] = { ...input.payrolls[0], daybookAmount: "75.00" };
    input.supplierBalances = [{ supplierId: 21, statementBalance: "450.00", counterpartyBalance: "440.00" }];
    input.intercompanyBalances = [
      {
        transferId: 77,
        fromCompanyId: 7,
        toCompanyId: 8,
        transferAmount: "100.00",
        fromVoucherAmount: "100.00",
        toVoucherAmount: "97.00",
      },
    ];

    const codes = new Set(issueCodes(input));
    for (const expected of [
      "DUPLICATE_VOUCHER",
      "UNBALANCED_JOURNAL",
      "STOCK_ACCOUNTING_VALUE_MISMATCH",
      "PAYROLL_DAYBOOK_AMOUNT_MISMATCH",
      "SUPPLIER_RECONCILIATION_MISMATCH",
      "INTERCOMPANY_MIRROR_MISMATCH",
    ]) {
      expect(codes.has(expected), expected).toBe(true);
    }
  });
});
