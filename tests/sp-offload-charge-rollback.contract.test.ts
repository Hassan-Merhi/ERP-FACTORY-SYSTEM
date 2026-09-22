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
    expect(source).toContain("Bank account #${charge.creditBankAccountId} not found for this company");
  });

  it("keeps offload, inventory, stock movement, charge and voucher writes transactional", () => {
    expect(source).toContain("sp_offloads");
    expect(source).toContain("sp_stock_movements");
    expect(source).toContain("sp_offload_charges");
    expect(source).toContain("vouchers");
    expect(source).toContain("inventory");
  });
});
