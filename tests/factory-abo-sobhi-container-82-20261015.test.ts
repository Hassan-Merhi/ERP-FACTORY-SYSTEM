import { describe, expect, it } from "vitest";
import { toMoney } from "../server/lib/money";
import { supplierUsdEquivalent } from "../server/routes/factory/suppliers/balance/supplierUsdEquivalent";
import { buildFactoryVoucherRequest } from "../server/services/factory/factoryVoucherPosting";

describe("ABO SOBHI DIRECT isolated correction — company 12 container 82", () => {
  it("identifies exactly EUR 858.40 of goods payable from the stored 0.36 rate", () => {
    const goods = toMoney("21460").times("0.36");
    const original = toMoney("6867.20");
    expect(goods.toFixed(2)).toBe("7725.60");
    expect(original.dividedBy("21460").toFixed(2)).toBe("0.32");
    expect(goods.minus(original).toFixed(2)).toBe("858.40");
    expect(toMoney("41572").plus(goods.minus(original)).toFixed(2)).toBe("42430.40");
  });

  it("posts equal debit to original inventory account and credit to supplier at original FX", () => {
    const { voucher, entries } = buildFactoryVoucherRequest({
      companyId: 12,
      voucherNumber: "FACTORY-GOODS-DELTA-20261015-82",
      voucherType: "Journal",
      voucherDate: "2026-10-15",
      description: "ABO SOBHI container 82 catch-up",
      currency: "EUR",
      fxRateToUsd: "1.18",
      source: { sourceType: "factory-goods-value-catchup", sourceId: "82-20261015" },
      lines: [
        { ledgerAccountId: 814, debit: "858.40" },
        { factorySupplierId: 41, credit: "858.40" },
      ],
    });
    expect(voucher.companyId).toBe(12);
    expect(entries).toHaveLength(2);
    expect(entries[0].ledgerAccountId).toBe(814);
    expect(entries[1].factorySupplierId).toBe(41);
    expect(toMoney(entries[0].transactionDebitAmount).toFixed(2)).toBe("858.40");
    expect(toMoney(entries[1].transactionCreditAmount).toFixed(2)).toBe("858.40");
    expect(toMoney(entries[0].debitAmount).toFixed(2)).toBe("1012.91");
    expect(entries[0].debitAmount).toBe(entries[1].creditAmount);
    expect(
      toMoney(entries[0].debitAmount)
        .minus(entries[1].creditAmount ?? "0")
        .isZero()
    ).toBe(true);
  });

  it("current factory rate gives EUR 42,430.40 = USD 50,067.87, without changing historical transactions", () => {
    expect(
      supplierUsdEquivalent([{ currencyCode: "EUR", balance: "42430.40" }], { EUR: 1.18 }).usdEquivalentBalance
    ).toBe("50067.87");
  });
});
