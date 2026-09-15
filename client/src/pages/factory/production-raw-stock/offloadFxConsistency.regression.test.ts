import { describe, expect, it } from "vitest";
import type { OffloadContainer, OffloadFormFields } from "./offloadDialogTypes";
import {
  buildOffloadPayload,
  computeEstimatedAvgCostKg,
  resolveOffloadMaterialFxRate,
} from "./offloadFormCalculations";

function audContainer(overrides: Partial<OffloadContainer> = {}): OffloadContainer {
  return {
    id: 1,
    containerNumber: "MRSU2098510",
    supplierName: "Australia Ahmad",
    status: "RECEIVED",
    totalKg: "19550",
    declaredKg: "19550",
    currencyCode: "AUD",
    fxRateToUsd: "0.78404194",
    ratePerKg: "0.75",
    freight: "9000",
    freightCurrencyCode: "AUD",
    ...overrides,
  };
}

function audFields(overrides: Partial<OffloadFormFields> = {}): OffloadFormFields {
  return {
    offloadDate: "2026-09-15",
    offloadDestination: "",
    selectedContainerId: "1",
    actualReceivedKg: "19550",
    costPerKg: "0.75",
    currencyCode: "AUD",
    fxRateToUsd: "0.78404194",
    freight: "9000",
    freightAccountId: "",
    freightCurrencyCode: "AUD",
    freightFxRate: "0.75",
    freightFxRateLoading: false,
    freightFromContainer: true,
    otherCharges: "0",
    otherChargesAccountId: "",
    otherChargesCurrencyCode: "AUD",
    otherChargesFxRate: "0.75",
    otherChargesFxRateLoading: false,
    otherChargesFromContainer: false,
    commissionFromContainer: false,
    containerCommissionCcy: "AUD",
    commissionPersonName: "",
    commissionType: "FIXED",
    commissionRate: "",
    commissionLedgerAccountId: "",
    commissionFxRate: "0.75",
    commissionFxRateLoading: false,
    commissionFxEffectiveDate: null,
    dutyAmount: "",
    dutyAccountId: "",
    dutyPending: false,
    dutyNotes: "",
    additionalCharges: [],
    mixBatchAllocations: [],
    ...overrides,
  };
}

describe("offload same-currency FX consistency regression", () => {
  it("uses the resolved AUD offload rate for both material and AUD freight", () => {
    const value = computeEstimatedAvgCostKg({
      actualReceivedKg: "19550",
      selectedContainerId: "1",
      selectedContainer: audContainer(),
      costPerKg: "0.75",
      // Old/import snapshot that previously leaked into the material leg.
      fxRateToUsd: "0.78404194",
      freight: "9000",
      // Offload-date AUD/USD rate visible in the freight section.
      freightFxRate: "0.75",
      otherCharges: "0",
      otherChargesFxRate: "0.75",
      commissionPersonName: "",
      commissionRate: "",
      commissionFxRate: "0.75",
      commissionType: "FIXED",
      additionalCharges: [],
      dutyAmount: "",
      dutyPending: false,
    });

    // (19,550 kg × 0.75 AUD/kg + 9,000 AUD) × 0.75 USD/AUD ÷ 19,550 kg
    expect(value).toBeCloseTo(0.907768542, 9);
  });

  it("submits the same AUD rate used by the estimate so the server cannot post the stale snapshot", () => {
    const fields = audFields();
    expect(resolveOffloadMaterialFxRate(fields)).toBe("0.75");

    const payload = buildOffloadPayload(fields, "fx-regression-key");
    expect(payload.fxRateToUsd).toBe("0.75");
    expect(payload.freightFxRate).toBe("0.75");
  });

  it("does not let a different-currency freight rate replace the container material FX", () => {
    const fields = audFields({
      freightCurrencyCode: "EUR",
      freightFxRate: "1.2",
    });

    expect(resolveOffloadMaterialFxRate(fields)).toBe("0.78404194");
  });
});
