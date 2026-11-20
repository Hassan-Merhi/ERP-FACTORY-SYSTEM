import { describe, expect, it } from "vitest";
import {
  assessManualFxCorrection,
  reversalMirrorsOriginal,
  type FxRepairAuditBalance,
  type FxRepairAuditLine,
  type FxRepairAuditVoucher,
} from "../server/services/accounting/manualFxCorrectionAudit";

function line(
  lineId: number,
  ledgerId: number,
  debitUsd: string,
  creditUsd: string,
  accountCode: string,
  accountName: string,
  accountType: string,
  currency = "USD",
  convention = "IDENTITY"
): FxRepairAuditLine {
  return {
    voucherId: 10,
    lineId,
    ledgerId,
    bankId: null,
    customerId: null,
    debitUsd,
    creditUsd,
    currency,
    nativeDebit: convention === "BASE_ONLY_REVALUATION" ? "0" : debitUsd,
    nativeCredit: convention === "BASE_ONLY_REVALUATION" ? "0" : creditUsd,
    rateConvention: convention,
    accountCode,
    accountName,
    accountType,
  };
}

const originalLines = [
  line(1, 4334, "0.00", "11.60", "KITCAS", "KITWE CASH", "Cash"),
  line(2, 4335, "0.00", "34.03", "LUSCAS", "LUSAKA CASH", "Cash"),
  line(3, 4404, "45.63", "0.00", "FXREVGAI", "FX Revaluation Gain/Loss", "Asset"),
];
const original: FxRepairAuditVoucher = {
  id: 10,
  voucherNumber: "JV-19-2026-000001",
  sourceType: "manual-journal",
  reversalOfVoucherId: null,
  deleted: false,
  optional: false,
  lines: originalLines,
};
function reversal(originalRows = originalLines): FxRepairAuditVoucher {
  return {
    id: 11,
    voucherNumber: "JV-REVERSAL",
    sourceType: "voucher-reversal",
    reversalOfVoucherId: 10,
    deleted: false,
    optional: false,
    lines: originalRows.map((entry) => ({
      ...entry,
      voucherId: 11,
      lineId: entry.lineId + 3,
      debitUsd: entry.creditUsd,
      creditUsd: entry.debitUsd,
      nativeDebit: entry.nativeCredit,
      nativeCredit: entry.nativeDebit,
    })),
  };
}
function replacement(): FxRepairAuditVoucher {
  return {
    id: 12,
    voucherNumber: "FX-AUTOMATIC-1",
    sourceType: "fx-unrealized-revaluation",
    reversalOfVoucherId: null,
    deleted: false,
    optional: false,
    lines: [
      line(7, 4334, "0.00", "11.60", "KITCAS", "KITWE CASH", "Cash", "ZMW", "BASE_ONLY_REVALUATION"),
      line(8, 4335, "0.00", "34.03", "LUSCAS", "LUSAKA CASH", "Cash", "ZMW", "BASE_ONLY_REVALUATION"),
      line(9, 4404, "45.63", "0.00", "FXREVGAI", "FX Revaluation Gain/Loss", "Indirect Expense"),
    ],
  };
}
const balances: FxRepairAuditBalance[] = [
  {
    accountKey: "ledger:4334",
    bookClosingUsd: "3278.950000",
    currentTranslatedUsd: "3278.947368",
    nativeBalancesByCurrency: { ZMW: "68530.00", USD: "0.00" },
    provisional: false,
  },
  {
    accountKey: "ledger:4335",
    bookClosingUsd: "7705.740000",
    currentTranslatedUsd: "7705.741627",
    nativeBalancesByCurrency: { ZMW: "161050.00", USD: "0.00" },
    provisional: false,
  },
];
const classified = (): FxRepairAuditVoucher => ({
  ...original,
  lines: originalLines.map((entry) =>
    entry.ledgerId === 4404 ? { ...entry, accountType: "Indirect Expense" } : entry
  ),
});
const evaluate = (overrides: {
  original?: FxRepairAuditVoucher | null;
  reversals?: FxRepairAuditVoucher[];
  automaticFxVouchers?: FxRepairAuditVoucher[];
  balances?: FxRepairAuditBalance[];
} = {}) =>
  assessManualFxCorrection({
    originalVoucherId: 10,
    original: classified(),
    reversals: [reversal()],
    automaticFxVouchers: [replacement()],
    balances,
    ...overrides,
  });

describe("Phase 4 exact FX correction verification", () => {
  it("shows every recovery stage and never writes to accounting", () => {
    expect(evaluate({ original }).status).toBe("reclassify_fx_account");
    expect(evaluate({ reversals: [] }).status).toBe("reverse_original");
    expect(evaluate({ automaticFxVouchers: [] }).status).toBe("post_base_only");
    const result = evaluate();
    expect(result).toMatchObject({
      status: "verified",
      readonly: true,
      originalFxLossUsd: "45.63",
      reversalVoucherId: 11,
      replacementVoucherId: 12,
      matchedAccountAdjustmentsUsd: { "ledger:4334": "-11.60", "ledger:4335": "-34.03" },
      untouchedNativeForeignBalances: {
        "ledger:4334": { ZMW: "68530.00" },
        "ledger:4335": { ZMW: "161050.00" },
      },
    });
  });

  it("requires the exact original currency movements to be mirrored", () => {
    expect(reversalMirrorsOriginal(originalLines, reversal().lines)).toBe(true);
    const wrong = reversal();
    wrong.lines[0].creditUsd = "11.61";
    expect(reversalMirrorsOriginal(originalLines, wrong.lines)).toBe(false);
    expect(evaluate({ reversals: [wrong] }).blockers).toContain("REVERSAL_DOES_NOT_EXACTLY_CANCEL_ORIGINAL");
  });

  it("rejects more than one live original reversal", () => {
    const second = { ...reversal(), id: 17 };
    expect(evaluate({ reversals: [reversal(), second] }).blockers).toContain("MULTIPLE_ACTIVE_REVERSALS");
  });

  it("rejects duplicate automatic journals rather than recognizing two losses", () => {
    const other = { ...replacement(), id: 18 };
    expect(evaluate({ automaticFxVouchers: [replacement(), other] }).blockers).toContain(
      "DUPLICATE_MATCHING_FX_JOURNALS"
    );
  });

  it("refuses a replacement journal that predates the original reversal", () => {
    const priorFx = { ...replacement(), id: 9 };
    const result = evaluate({ automaticFxVouchers: [priorFx] });
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContain("EXISTING_UNRECONCILED_FX_JOURNAL");
  });

  it("does not accept revaluation lines that alter native currency", () => {
    const bad = replacement();
    bad.lines[0].nativeCredit = "11.60";
    expect(evaluate({ automaticFxVouchers: [bad] }).status).not.toBe("verified");
  });

  it("does not accept a replacement that credits a cash account twice", () => {
    const bad = replacement();
    bad.lines[0].creditUsd = "23.20";
    expect(evaluate({ automaticFxVouchers: [bad] }).status).not.toBe("verified");
  });

  it("refuses an FX journal posted to an Asset account", () => {
    const bad = replacement();
    bad.lines[2].accountType = "Asset";
    expect(evaluate({ automaticFxVouchers: [bad] }).status).not.toBe("verified");
  });

  it("requires posted book cash to equal the current-rate valuation to the cent", () => {
    const wrong = balances.map((row) => ({ ...row }));
    wrong[1].bookClosingUsd = "7705.73";
    expect(evaluate({ balances: wrong }).blockers).toContain("CLOSING_TRANSLATION_MISMATCH:ledger:4335");
  });

  it("does not certify missing or provisional original-currency evidence", () => {
    const noRate = balances.map((row) => ({ ...row }));
    noRate[0].provisional = true;
    expect(evaluate({ balances: noRate }).blockers).toContain("ACCOUNT_VALUATION_UNRESOLVED:ledger:4334");
    expect(evaluate({ balances: balances.slice(1) }).status).toBe("blocked");
  });

  it("refuses missing, deleted, optional or wrong-source originals", () => {
    expect(evaluate({ original: null }).blockers).toContain("ORIGINAL_VOUCHER_NOT_FOUND");
    expect(evaluate({ original: { ...original, deleted: true } }).status).toBe("blocked");
    expect(evaluate({ original: { ...original, optional: true } }).status).toBe("blocked");
    expect(evaluate({ original: { ...original, sourceType: "pos-sale" } }).status).toBe("blocked");
  });

  it("fails when the original counter and monetary adjustments do not balance", () => {
    const bad = classified();
    bad.lines[2].debitUsd = "45.62";
    expect(evaluate({ original: bad }).blockers).toContain("ORIGINAL_FX_VOUCHER_NOT_BALANCED");
  });
});
