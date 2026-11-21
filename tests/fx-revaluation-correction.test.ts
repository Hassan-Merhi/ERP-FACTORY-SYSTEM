import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getValuation: vi.fn(),
  closedThrough: vi.fn(),
  businessDate: vi.fn(),
}));
vi.mock("../server/db", () => ({
  db: {
    execute: mocks.execute,
    transaction: (run: (tx: object) => Promise<unknown>) => run({}),
  },
}));
vi.mock("../server/services/accounting/monetaryFxValuationService", () => ({
  getMonetaryFxValuation: mocks.getValuation,
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({
  companyBusinessDate: mocks.businessDate,
}));
vi.mock("../server/services/accounting/voucherCorrection", () => ({
  companyClosedThroughTx: mocks.closedThrough,
  reverseVoucherTx: vi.fn(),
}));
vi.mock("../server/services/accounting/databasePostingDependencies", () => ({
  createDatabasePostingDependencies: vi.fn(),
}));
vi.mock("../server/services/accounting/erpVoucherPosting", () => ({
  postErpEntriesTx: vi.fn(),
}));
vi.mock("../server/services/accounting/systemAccounts", () => ({
  ensureSystemAccounts: vi.fn(),
}));
vi.mock("../server/services/audit", () => ({
  writeAuditEvent: vi.fn(),
}));

import { previewFxCorrection } from "../server/services/accounting/fxRevaluationCorrection";

const original = {
  id: 130,
  voucher_number: "JV-9-2026-000009",
  voucher_date: "2026-11-20",
  effective_date: null,
  total_amount: "2.00",
  optional: false,
  deleted: false,
  reversed: false,
  later_fx: false,
};
const sourceLines = [
  {
    id: 1,
    rate_convention: "BASE_ONLY_REVALUATION",
    transaction_currency: "CFA",
    transaction_debit_amount: "0",
    transaction_credit_amount: "0",
    historical_exchange_rate: "613.0000000000",
  },
  {
    id: 2,
    rate_convention: "IDENTITY",
    transaction_currency: "USD",
    transaction_debit_amount: "2",
    transaction_credit_amount: "0",
    historical_exchange_rate: "1.0000000000",
  },
];
const valuation = {
  baseCurrency: "USD",
  businessDate: "2026-11-19",
  accounts: [
    {
      accountKind: "ledger",
      id: 10,
      name: "CASH",
      deleted: false,
      eligibility: "cash_bank",
      linkedLedgerId: null,
      nativeBalancesByCurrency: { CFA: "6130.000000" },
      provisional: false,
      currentTranslatedUsd: "10.000000",
      bookClosingUsd: "12.000000",
      translationDifferenceUsd: "-2.000000",
    },
  ],
  rates: [{ currency: "CFA", rate: "613.0000000000", direction: "FOREIGN_PER_USD", effectiveDate: "2026-11-19" }],
};
function prepare(source = original, rows = sourceLines, snapshot = valuation) {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows });
  mocks.getValuation.mockResolvedValue(snapshot);
}

beforeEach(() => {
  mocks.businessDate.mockReset().mockResolvedValue("2026-11-21");
  mocks.closedThrough.mockReset().mockResolvedValue(null);
});

describe("Admin FX date-correction preflight", () => {
  it("previews a dated base-only journal without native cash movements", async () => {
    prepare();
    const { preview, entries } = await previewFxCorrection(9, 130, "2026-11-19");
    expect(preview.status).toBe("ready");
    expect(preview.originalDate).toBe("2026-11-20");
    expect(preview.reversalDate).toBe("2026-11-20");
    expect(preview.correctedUsdTotal).toBe("2.00");
    expect(preview.netGainUsd).toBe("-2.00");
    expect(preview.previewKey).toMatch(/^[0-9a-f]{64}$/);
    expect(entries).toMatchObject([
      {
        ledgerAccountId: 10,
        debitAmount: "0",
        creditAmount: "2.00",
        transactionCurrency: "CFA",
        transactionDebitAmount: "0",
        transactionCreditAmount: "0",
        rateConvention: "BASE_ONLY_REVALUATION",
      },
    ]);
  });

  it("recomputes USD book movements without manufacturing CFA cash", async () => {
    prepare();
    const { preview, entries } = await previewFxCorrection(9, 130, "2026-11-19", [
      { accountKind: "ledger", accountId: 10, adjustmentUsd: "-5.75" },
    ]);
    expect(preview.status).toBe("ready");
    expect(preview.lines).toMatchObject([
      {
        accountKind: "ledger",
        accountId: 10,
        adjustmentUsd: "-5.75",
        automaticAdjustmentUsd: "-2.00",
        manuallyOverridden: true,
      },
    ]);
    expect(preview.correctedUsdTotal).toBe("5.75");
    expect(preview.netGainUsd).toBe("-5.75");
    expect(entries).toMatchObject([
      {
        debitAmount: "0",
        creditAmount: "5.75",
        baseDebitAmount: "0",
        baseCreditAmount: "5.75",
        transactionCurrency: "CFA",
        transactionDebitAmount: "0",
        transactionCreditAmount: "0",
      },
    ]);
  });

  it("refuses manual amount changes to accounts outside the verified valuation", async () => {
    prepare();
    await expect(
      previewFxCorrection(9, 130, "2026-11-19", [{ accountKind: "ledger", accountId: 999999, adjustmentUsd: "15.00" }])
    ).rejects.toMatchObject({ status: 400, code: "FX_CORRECTION_ACCOUNT_INVALID" });
  });

  it("blocks a source that has dependent later revaluation journals", async () => {
    prepare({ ...original, later_fx: true });
    const { preview } = await previewFxCorrection(9, 130, "2026-11-19");
    expect(preview.status).toBe("blocked");
    expect(preview.blockers.join(" ")).toMatch(/Later FX/);
    expect(preview.previewKey).toBeNull();
  });

  it("blocks backdating when the original rate was not effective on that date", async () => {
    prepare(original, sourceLines, {
      ...valuation,
      rates: [{ ...valuation.rates[0], rate: "612.0000000000" }],
    });
    const { preview } = await previewFxCorrection(9, 130, "2026-11-19");
    expect(preview.status).toBe("blocked");
    expect(preview.blockers.join(" ")).toMatch(/not recorded/);
  });

  it("never edits a closed accounting period", async () => {
    prepare();
    mocks.closedThrough.mockResolvedValue("2026-11-19");
    const { preview } = await previewFxCorrection(9, 130, "2026-11-19");
    expect(preview.status).toBe("blocked");
    expect(preview.blockers.join(" ")).toMatch(/closed/);
  });
});
