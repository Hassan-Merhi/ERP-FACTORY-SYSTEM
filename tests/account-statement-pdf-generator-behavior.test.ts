import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    selectResults: [] as unknown[][],
    bankEntries: [] as any[],
    supplierEntries: [] as any[],
    customerStatement: [] as any[],
    company: { id: 4, name: "GC Lshi", baseCurrency: "USD", companyType: "erp" } as any,
    settings: { logoUrl: null } as any,
  };

  const select = vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder: any = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  return { ...state, db: { select } };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/storage", () => ({
  storage: {
    getVoucherEntriesByLedger: vi.fn(async () => []),
    getVoucherEntriesByBankAccount: vi.fn(async () => harness.bankEntries),
    getVoucherEntriesByFixedAsset: vi.fn(async () => []),
    getVoucherEntriesBySupplier: vi.fn(async () => harness.supplierEntries),
    getVoucherEntriesByEmployee: vi.fn(async () => []),
    getCustomerStatement: vi.fn(async () => harness.customerStatement),
    getCompanyById: vi.fn(async () => harness.company),
    getCompanySettings: vi.fn(async () => harness.settings),
  },
}));
vi.mock("../server/lib/factoryCustomerLedger", () => ({
  getCustomerByLedgerId: vi.fn(async () => null),
}));
// Wave 10: a customer statement is the customer's ledger lines on the balance
// engine (no longer the customer_balances cache), opened at the engine opening.
vi.mock("../server/services/accounting/balances/customerLedgerStatement", () => ({
  loadCustomerLedgerLines: vi.fn(async () => harness.customerStatement),
}));
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  getPartyBalance: vi.fn(async () => ({ opening: "200.00" })),
}));
vi.mock("../server/routes/helpers/supplierBalanceHelpers", () => ({
  isParentCompanyContext: vi.fn(async () => true),
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: "sql", strings: Array.from(strings), values }),
    { raw: (value: string) => ({ type: "raw", value }) }
  ),
}));
vi.mock("@shared/schema", () => ({
  ledgerAccounts: { id: "ledgerAccounts.id", name: "ledgerAccounts.name" },
  bankAccounts: { id: "bankAccounts.id", name: "bankAccounts.name" },
  fixedAssets: { id: "fixedAssets.id", name: "fixedAssets.name" },
  suppliers: { id: "suppliers.id" },
  customers: {
    id: "customers.id",
    companyId: "customers.companyId",
    ledgerAccountId: "customers.ledgerAccountId",
    openingBalance: "customers.openingBalance",
    openingBalanceSide: "customers.openingBalanceSide",
  },
  employees: {
    id: "employees.id",
    firstName: "employees.firstName",
    lastName: "employees.lastName",
    openingBalance: "employees.openingBalance",
  },
  vouchers: {
    id: "vouchers.id",
    companyId: "vouchers.companyId",
    optional: "vouchers.optional",
    deletedAt: "vouchers.deletedAt",
    voucherDate: "vouchers.voucherDate",
  },
  voucherEntries: {
    voucherId: "voucherEntries.voucherId",
    ledgerAccountId: "voucherEntries.ledgerAccountId",
    bankAccountId: "voucherEntries.bankAccountId",
    fixedAssetId: "voucherEntries.fixedAssetId",
    supplierId: "voucherEntries.supplierId",
    employeeId: "voucherEntries.employeeId",
    customerId: "voucherEntries.customerId",
    debitAmount: "voucherEntries.debitAmount",
    creditAmount: "voucherEntries.creditAmount",
  },
}));

import { generateAccountStatementPdf } from "../server/lib/accountStatementPdfGenerator";

function expectPdf(buffer: Buffer) {
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.length).toBeGreaterThan(1_000);
  expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
}

describe("account statement PDF generator behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.bankEntries.splice(0);
    harness.supplierEntries.splice(0);
    harness.customerStatement.splice(0);
    harness.company = { id: 4, name: "GC Lshi", baseCurrency: "USD", companyType: "erp" };
    harness.settings = { logoUrl: null };
  });

  it("groups bank voucher lines and renders a running-balance statement", async () => {
    harness.selectResults.push([{ id: 30, name: "Main Bank", openingBalance: "1000", openingBalanceSide: "Dr" }]);
    harness.bankEntries.push(
      {
        voucherId: 2,
        voucherNumber: "PAY-2",
        voucherType: "Payment",
        voucherDate: "2026-08-05",
        voucherDescription: "Supplier payment",
        narration: "",
        debitAmount: "0",
        creditAmount: "150",
      },
      {
        voucherId: 1,
        voucherNumber: "REC-1",
        voucherType: "Receipt",
        voucherDate: "2026-08-03",
        voucherDescription: "Customer receipt",
        narration: "first line",
        debitAmount: "200",
        creditAmount: "0",
      },
      {
        voucherId: 1,
        voucherNumber: "REC-1",
        voucherType: "Receipt",
        voucherDate: "2026-08-03",
        voucherDescription: "Customer receipt",
        narration: "second line",
        debitAmount: "50",
        creditAmount: "0",
      }
    );

    const buffer = await generateAccountStatementPdf({
      accountType: "bank",
      accountId: 30,
      companyId: 4,
      endDate: "2026-08-12",
      lang: "en",
    });

    expectPdf(buffer);
  });

  it("applies supplier opening and pre-period balances in parent-company books", async () => {
    harness.selectResults.push([{ id: 7, legalName: "Supplier A", openingBalance: "500" }], [{ d: "40", c: "90" }]);
    harness.supplierEntries.push(
      {
        voucherId: 10,
        voucherNumber: "PAY-10",
        voucherType: "Payment",
        voucherDate: "2026-08-04",
        voucherDescription: "Paiement fournisseur",
        narration: "Paiement fournisseur",
        debitAmount: "100",
        creditAmount: "0",
      },
      {
        voucherId: 11,
        voucherNumber: "JV-11",
        voucherType: "Journal",
        voucherDate: "2026-08-06",
        voucherDescription: "Achat",
        narration: "Achat",
        debitAmount: "0",
        creditAmount: "250",
      }
    );

    const buffer = await generateAccountStatementPdf({
      accountType: "supplier",
      accountId: 7,
      companyId: 4,
      startDate: "2026-08-01",
      endDate: "2026-08-12",
      lang: "fr",
    });

    expectPdf(buffer);
  });

  it("renders an Arabic customer statement in the company base currency", async () => {
    harness.company = { id: 4, name: "شركة جي سي", baseCurrency: "CFA", companyType: "erp" };
    harness.selectResults.push([{ id: 12, legalName: "عميل رئيسي", openingBalance: "200", openingBalanceSide: "Dr" }]);
    harness.customerStatement.push(
      {
        id: 1,
        voucherId: 44,
        voucherNumber: "SALE-44",
        voucherType: "Sales",
        voucherDate: "2026-08-07",
        voucherDescription: "فاتورة مبيعات",
        narration: "فاتورة مبيعات",
        debitAmount: "1250",
        creditAmount: "0",
      },
      {
        id: 2,
        voucherId: 45,
        voucherNumber: "RECEIPT-45",
        voucherType: "Receipt",
        voucherDate: "2026-08-08",
        voucherDescription: "دفعة نقدية",
        narration: "دفعة نقدية",
        debitAmount: "0",
        creditAmount: "500",
      }
    );

    const buffer = await generateAccountStatementPdf({
      accountType: "customer",
      accountId: 12,
      companyId: 4,
      lang: "ar",
    });

    expectPdf(buffer);
  });

  it("carries the running balance exactly, so whole amounts print without stray cents", async () => {
    const PDFDocument = (await import("pdfkit")).default;
    const printed: string[] = [];
    const original = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: any, ...args: any[]) {
      if (typeof args[0] === "string") printed.push(args[0]);
      return original.apply(this, args as never);
    });
    harness.selectResults.push([{ id: 31, name: "Petty Bank", openingBalance: "0", openingBalanceSide: "Dr" }]);
    harness.bankEntries.push(
      ...["0.2", "0.7", "0.1"].map((debitAmount, index) => ({
        voucherId: index + 1,
        voucherNumber: `REC-${index + 1}`,
        voucherType: "Receipt",
        voucherDate: `2026-08-0${index + 1}`,
        voucherDescription: "Receipt",
        narration: "",
        debitAmount,
        creditAmount: "0",
      }))
    );

    try {
      expectPdf(await generateAccountStatementPdf({ accountType: "bank", accountId: 31, companyId: 4, lang: "en" }));
    } finally {
      spy.mockRestore();
    }

    // 0.2 + 0.7 + 0.1 is 1 exactly; the float sum 0.9999999999999999 printed as 1.00.
    expect(printed).toContain("$ 1 Dr");
    expect(printed).not.toContain("$ 1.00 Dr");
  });

  it("rejects unknown account types before attempting PDF generation", async () => {
    await expect(generateAccountStatementPdf({ accountType: "mystery", accountId: 1, companyId: 4 })).rejects.toThrow(
      "Unknown account type: mystery"
    );
  });
});
