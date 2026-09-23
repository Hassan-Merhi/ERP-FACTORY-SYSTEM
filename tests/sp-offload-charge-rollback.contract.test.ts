import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "server/routes/sp/spOffloadRoutes.ts"), "utf8");

describe("SP offload charge atomic rollback contract", () => {
  it("keeps prepaid usage and later charge validation inside the same transaction", () => {
    const transactionStart = source.indexOf("db.transaction");
    const prepaidUpdate = source.indexOf("amount_used_usd");
    const paidNowValidation = source.indexOf('charge.chargeType === "paid_now"');
    const bankCompanyScope = source.indexOf("eq(bankAccounts.companyId, companyId)");

    expect(transactionStart).toBeGreaterThan(-1);
    expect(prepaidUpdate).toBeGreaterThan(transactionStart);
    expect(paidNowValidation).toBeGreaterThan(prepaidUpdate);
    expect(bankCompanyScope).toBeGreaterThan(paidNowValidation);
  });

  it("throws on invalid paid-now ownership instead of continuing with partial state", () => {
    const paidNow = source.indexOf('charge.chargeType === "paid_now"');
    const ownership = source.indexOf("eq(bankAccounts.companyId, companyId)", paidNow);
    const failure = source.indexOf("Bank account #${charge.creditBankAccountId} not found for this company", ownership);

    expect(paidNow).toBeGreaterThan(-1);
    expect(ownership).toBeGreaterThan(paidNow);
    expect(failure).toBeGreaterThan(ownership);
    expect(source.slice(ownership, failure + 100)).toContain("throw new Error");
  });

  it("keeps every state-changing offload write after the transaction boundary", () => {
    const transactionStart = source.indexOf("db.transaction");
    const mutationSites = [
      "tx.insert(vouchers)",
      "tx.insert(spOffloads)",
      "tx.insert(spOffloadCharges)",
      "tx.insert(spStockMovements)",
      "adjustSpInventoryAtomic(tx",
    ];

    for (const mutation of mutationSites) {
      expect(
        source.indexOf(mutation, transactionStart),
        `${mutation} must stay inside the transactional offload path`
      ).toBeGreaterThan(transactionStart);
    }
  });

  it("does not introduce an inner catch that can swallow charge validation failures", () => {
    const transactionStart = source.indexOf("db.transaction");
    const prepaidUpdate = source.indexOf("amount_used_usd", transactionStart);
    const bankFailure = source.indexOf("Bank account #${charge.creditBankAccountId} not found for this company", prepaidUpdate);
    const between = source.slice(prepaidUpdate, bankFailure);

    expect(prepaidUpdate).toBeGreaterThan(transactionStart);
    expect(bankFailure).toBeGreaterThan(prepaidUpdate);
    expect(between).not.toMatch(/catch\s*\(/);
  });
});
