import { describe, expect, it } from "vitest";
import {
  describeSupplierFxConversion,
  type SupplierFxJournalDocument,
} from "../server/services/factory/supplierFxTransferJournal";

function sample(overrides: Partial<SupplierFxJournalDocument> = {}): SupplierFxJournalDocument {
  return {
    id: 17,
    companyId: 12,
    date: "2026-10-01",
    fromSupplierId: 39,
    toSupplierId: 27,
    sourceType: "supplier",
    fromCurrencyCode: "EUR",
    fromAmount: "1000",
    fxRateToUsd: "1.18",
    toAmountUsd: "1180",
    ...overrides,
  };
}

describe("supplier FX transfer rates and settlement posting", () => {
  it("preserves the entered forward rate", () => {
    const result = describeSupplierFxConversion(sample());
    expect(result.convention).toBe("multiply");
    expect(result.postingUsdPerUnit.toFixed(10)).toBe("1.1800000000");
    expect(result.residual.abs().lte("0.005")).toBe(true);
  });

  it("recognizes reciprocal historical EUR rates", () => {
    const input = sample({
      id: 29,
      fromAmount: "17000",
      fxRateToUsd: "0.85",
      toAmountUsd: "20000",
    });
    expect(describeSupplierFxConversion(input).convention).toBe("divide");
    expect(input.fxRateToUsd).toBe("0.85");
  });

  it("recognizes both historical AUD conventions", () => {
    const forward = sample({
      fromCurrencyCode: "AUD",
      fromAmount: "16140",
      fxRateToUsd: "0.67131351",
      toAmountUsd: "10835.0001",
    });
    const reciprocal = sample({
      fromCurrencyCode: "AUD",
      fromAmount: "13479.5",
      fxRateToUsd: "1.4581891",
      toAmountUsd: "9244",
    });
    expect(describeSupplierFxConversion(forward).convention).toBe("multiply");
    expect(describeSupplierFxConversion(reciprocal).convention).toBe("divide");
  });

  it("rejects inconsistent monetary amounts", () => {
    const invalid = sample({
      fromAmount: "17000",
      fxRateToUsd: "0.85",
      toAmountUsd: "125",
    });
    expect(() => describeSupplierFxConversion(invalid)).toThrow(/inconsistent stored rate/);
  });
});
