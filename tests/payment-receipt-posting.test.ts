import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { VoucherEntryInsertFields } from "../server/services/accounting/accountingTypes";
import { buildPaymentReceiptPostingRequest } from "../server/services/accounting/paymentReceiptPosting";

const targets: Record<string, keyof VoucherEntryInsertFields> = {
  ledger: "ledgerAccountId",
  bank: "bankAccountId",
  supplier: "supplierId",
  factorySupplier: "factorySupplierId",
  employee: "employeeId",
  fixedAsset: "fixedAssetId",
  customer: "customerId",
};

async function resolveTarget(accountType: string, accountId: number): Promise<VoucherEntryInsertFields> {
  if (accountType === "customer") {
    return { customerId: accountId, ledgerAccountId: accountId + 1000 };
  }
  const field = targets[accountType];
  if (!field) throw new Error(`Unsupported account type ${accountType}`);
  return { [field]: accountId } as VoucherEntryInsertFields;
}

async function resolveLegacyEditTarget(accountType: string, accountId: number): Promise<VoucherEntryInsertFields> {
  const field = targets[accountType];
  if (!field) throw new Error(`Unsupported account type ${accountType}`);
  return { [field]: accountId } as VoucherEntryInsertFields;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 1,
    voucherNumber: "PAYMENT-1",
    voucherType: "Payment",
    voucherDate: "2026-07-25",
    paymentAccountType: "bank",
    paymentAccountId: 10,
    entries: [{ accountType: "ledger", accountId: 20, amount: "100" }],
    notes: "Protected payment",
    currency: "USD",
    exchangeRate: "1",
    clientRequestId: "payment-request-1",
    resolveTarget,
    ...overrides,
  };
}

describe("buildPaymentReceiptPostingRequest", () => {
  it("posts an asset-account Payment as contra debit and payment-account credit", async () => {
    const built = await buildPaymentReceiptPostingRequest(baseInput());
    expect(built.request.entries).toHaveLength(2);
    expect(built.request.entries[0]).toMatchObject({
      ledgerAccountId: 20,
      debitAmount: "100.000000",
      creditAmount: "0.000000",
    });
    expect(built.request.entries[1]).toMatchObject({
      bankAccountId: 10,
      debitAmount: "0.000000",
      creditAmount: "100.000000",
    });
  });

  it("preserves separate payment-account and contra-entry narrations", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        notes: "Voucher description",
        paymentAccountNarration: "Paid from operating account",
        entries: [{ accountType: "ledger", accountId: 20, amount: "100", narration: "Supplier settlement" }],
      })
    );

    expect(built.request.entries[0].narration).toBe("Supplier settlement");
    expect(built.request.entries[1].narration).toBe("Paid from operating account");
  });

  it("posts a liability-account Payment as payment-account debit and contra credit", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        paymentAccountType: "supplier",
        paymentAccountId: 30,
      })
    );
    expect(built.request.entries[0]).toMatchObject({ supplierId: 30, debitAmount: "100.000000" });
    expect(built.request.entries[1]).toMatchObject({ ledgerAccountId: 20, creditAmount: "100.000000" });
  });

  it("posts an asset-account Receipt as payment-account debit and contra credit", async () => {
    const built = await buildPaymentReceiptPostingRequest(baseInput({ voucherType: "Receipt" }));
    expect(built.request.entries[0]).toMatchObject({ bankAccountId: 10, debitAmount: "100.000000" });
    expect(built.request.entries[1]).toMatchObject({ ledgerAccountId: 20, creditAmount: "100.000000" });
  });

  it("posts a liability-account Receipt as contra debit and payment-account credit", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        voucherType: "Receipt",
        paymentAccountType: "employee",
        paymentAccountId: 40,
      })
    );
    expect(built.request.entries[0]).toMatchObject({ ledgerAccountId: 20, debitAmount: "100.000000" });
    expect(built.request.entries[1]).toMatchObject({ employeeId: 40, creditAmount: "100.000000" });
  });

  it("preserves a customer and linked-ledger pair", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        entries: [{ accountType: "customer", accountId: 55, amount: "25" }],
      })
    );
    expect(built.request.entries[0]).toMatchObject({
      customerId: 55,
      ledgerAccountId: 1055,
      debitAmount: "25.000000",
    });
  });

  it("preserves a customer-only target for the legacy edit resolver", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        entries: [{ accountType: "customer", accountId: 55, amount: "25" }],
        resolveTarget: resolveLegacyEditTarget,
      })
    );
    expect(built.request.entries[0]).toMatchObject({
      customerId: 55,
      debitAmount: "25.000000",
    });
    expect(built.request.entries[0]).not.toHaveProperty("ledgerAccountId");
  });

  it("keeps non-USD debit and credit totals exactly balanced", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        currency: "XOF",
        exchangeRate: "600",
        entries: [
          { accountType: "ledger", accountId: 20, amount: "100" },
          { accountType: "fixedAsset", accountId: 21, amount: "101" },
        ],
      })
    );
    const debit = built.request.entries.reduce((sum, entry) => sum + Number(entry.debitAmount || 0), 0);
    const credit = built.request.entries.reduce((sum, entry) => sum + Number(entry.creditAmount || 0), 0);
    expect(debit).toBe(credit);
    expect(built.request.voucher.totalAmount).toBe("0.335000");
  });

  // Phase 22 A (D3): no per-line adjustment (the currency trigger refuses a base
  // that does not match its rate); the engine posts the remainder to ROUNDING.
  it("keeps every leg's exact base (legs pair per line, so the voucher balances without adjustment)", async () => {
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        currency: "EUR",
        exchangeRate: "3",
        entries: [
          { accountType: "ledger", accountId: 20, amount: "1" },
          { accountType: "fixedAsset", accountId: 21, amount: "1" },
        ],
      })
    );

    const debits = built.request.entries.reduce((sum, entry) => sum.plus(entry.debitAmount ?? "0"), new Decimal(0));
    const credits = built.request.entries.reduce((sum, entry) => sum.plus(entry.creditAmount ?? "0"), new Decimal(0));
    expect(debits.toFixed(6)).toBe("0.666666");
    expect(credits.toFixed(6)).toBe("0.666666");
    expect(built.request.voucher.totalAmount).toBe("0.666666");
    for (const entry of built.request.entries) {
      expect(new Decimal(entry.debitAmount ?? "0").plus(entry.creditAmount ?? "0").toFixed(6)).toBe("0.333333");
    }
  });

  it("uses a stable idempotency key for the same protected request", async () => {
    const first = await buildPaymentReceiptPostingRequest(baseInput({ voucherNumber: "PAYMENT-1" }));
    const retry = await buildPaymentReceiptPostingRequest(baseInput({ voucherNumber: "PAYMENT-2" }));
    expect(retry.request.source.idempotencyKey).toBe(first.request.source.idempotencyKey);
  });

  it("rejects unsupported voucher types", async () => {
    await expect(buildPaymentReceiptPostingRequest(baseInput({ voucherType: "Journal" }))).rejects.toMatchObject({
      code: "POSTING_VOUCHER_TYPE_INVALID",
    });
  });

  it("applies USD defaults and preserves actor/effective-date metadata on a multi-line posting", async () => {
    const actor = { userId: 7, role: "Accountant" };
    const built = await buildPaymentReceiptPostingRequest(
      baseInput({
        currency: undefined,
        exchangeRate: undefined,
        notes: "  Month-end settlement  ",
        effectiveDate: "2026-07-31",
        actor,
        entries: [
          { accountType: "ledger", accountId: 20, amount: "40.25" },
          { accountType: "fixedAsset", accountId: 21, amount: "59.75" },
        ],
      })
    );

    expect(built.transactionTotal).toBe("100");
    expect(built.request.voucher).toMatchObject({
      currency: "USD",
      exchangeRate: null,
      effectiveDate: "2026-07-31",
      description: "Month-end settlement",
      totalAmount: "100.000000",
    });
    expect(built.request.actor).toBe(actor);
    expect(built.request.entries).toHaveLength(4);
  });

  it.each([
    [{ companyId: 0 }, "POSTING_COMPANY_INVALID"],
    [{ voucherDate: "" }, "POSTING_ENTRIES_REQUIRED"],
    [{ entries: [] }, "POSTING_ENTRIES_REQUIRED"],
    [{ paymentAccountId: -1 }, "POSTING_TARGET_ID_INVALID"],
    [{ entries: [{ accountType: "ledger", accountId: 0, amount: "10" }] }, "POSTING_TARGET_ID_INVALID"],
    [{ entries: [{ accountType: "ledger", accountId: 20, amount: "not-a-number" }] }, "POSTING_AMOUNT_INVALID"],
    [{ entries: [{ accountType: "ledger", accountId: 20, amount: "0" }] }, "POSTING_AMOUNT_INVALID"],
    [{ currency: "EUR", exchangeRate: "0" }, "POSTING_CURRENCY_INVALID"],
  ])("rejects unsafe posting input %#", async (overrides, code) => {
    await expect(buildPaymentReceiptPostingRequest(baseInput(overrides))).rejects.toMatchObject({ code });
  });
});
