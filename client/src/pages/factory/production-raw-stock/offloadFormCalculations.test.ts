/**
 * Behavior tests for the OffloadDialog cost and payload math extracted from
 * OffloadDialog.tsx. These pin the accounting contracts: the estimated
 * landed cost per kg, partial-receipt math, the account reference parse,
 * duty conversion to USD, commission block assembly, and the exact payload
 * the server posts (including the idempotency key).
 */

import { describe, expect, it } from "vitest";
import type { OffloadContainer, OffloadFormFields } from "./offloadDialogTypes";
import {
  buildOffloadPayload,
  computeEstimatedAvgCostKg,
  computePartialReceiptInfo,
  computeReceiptValue,
  parseAccountValue,
} from "./offloadFormCalculations";

function container(overrides: Partial<OffloadContainer> = {}): OffloadContainer {
  return {
    id: 1,
    containerNumber: "CTN-1",
    supplierName: "Supplier A",
    status: "RECEIVED",
    totalKg: "1000",
    declaredKg: "1000",
    currencyCode: "USD",
    fxRateToUsd: "1",
    ratePerKg: "5",
    ...overrides,
  };
}

function fields(overrides: Partial<OffloadFormFields> = {}): OffloadFormFields {
  return {
    offloadDate: "2026-09-01",
    offloadDestination: "",
    selectedContainerId: "1",
    actualReceivedKg: "990",
    costPerKg: "5",
    currencyCode: "USD",
    fxRateToUsd: "1",
    freight: "0",
    freightAccountId: "",
    freightCurrencyCode: "USD",
    freightFxRate: "1",
    freightFxRateLoading: false,
    freightFromContainer: false,
    otherCharges: "0",
    otherChargesAccountId: "",
    otherChargesCurrencyCode: "USD",
    otherChargesFxRate: "1",
    otherChargesFxRateLoading: false,
    otherChargesFromContainer: false,
    commissionFromContainer: false,
    containerCommissionCcy: "USD",
    commissionPersonName: "",
    commissionType: "PER_KG",
    commissionRate: "",
    commissionLedgerAccountId: "",
    commissionFxRate: "1",
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

describe("parseAccountValue", () => {
  it("distinguishes supplier references from ledger account ids", () => {
    expect(parseAccountValue("")).toBeNull();
    expect(parseAccountValue("12")).toEqual({ type: "ledger", id: 12 });
    expect(parseAccountValue("SUP:42")).toEqual({ type: "supplier", id: 42 });
  });
});

describe("partial receipt math", () => {
  const partial = container({ status: "PARTIALLY_RECEIVED", totalKg: "1000", actualReceivedKg: "350.5" });

  it("computes declared/already/remaining for PARTIALLY_RECEIVED containers", () => {
    expect(computePartialReceiptInfo(partial)).toEqual({
      declared: 1000,
      alreadyReceived: 350.5,
      remaining: 649.5,
    });
  });

  it("never reports a negative remaining amount", () => {
    const over = container({ status: "PARTIALLY_RECEIVED", totalKg: "1000", actualReceivedKg: "1200" });
    expect(computePartialReceiptInfo(over)!.remaining).toBe(0);
  });

  it("is null for non-partial containers", () => {
    expect(computePartialReceiptInfo(container())).toBeNull();
  });

  it("computes the live receipt value as kg × fixed landed rate", () => {
    const withRate = { ...partial, fixedCostPerKgUsd: "7.25" };
    expect(computeReceiptValue(withRate, "100")).toBe(725);
    expect(computeReceiptValue(container(), "100")).toBeNull();
    expect(computeReceiptValue(withRate, "")).toBeNull();
  });
});

describe("computeEstimatedAvgCostKg", () => {
  const base = {
    actualReceivedKg: "990",
    selectedContainerId: "1",
    selectedContainer: container({ totalKg: "1000" }),
    costPerKg: "5",
    fxRateToUsd: "1",
    freight: "0",
    freightFxRate: "1",
    otherCharges: "0",
    otherChargesFxRate: "1",
    commissionPersonName: "",
    commissionRate: "",
    commissionFxRate: "1",
    commissionType: "PER_KG" as const,
    additionalCharges: [],
    dutyAmount: "",
    dutyPending: false,
  };

  it("divides the USD-converted total by the actual received weight", () => {
    // material: 5 × 1 × 1000 (valuation kg) = 5000 → /990 ≈ 5.0505
    expect(computeEstimatedAvgCostKg(base)).toBeCloseTo(5000 / 990, 6);
  });

  it("adds freight, other charges, and additional charges converted to USD", () => {
    const value = computeEstimatedAvgCostKg({
      ...base,
      freight: "100",
      freightFxRate: "1.1",
      otherCharges: "50",
      otherChargesFxRate: "2",
      additionalCharges: [
        {
          id: "a1",
          description: "insp",
          amount: "10",
          currencyCode: "EUR",
          fxRate: "1.2",
          fxRateLoading: false,
          ledgerAccountId: "3",
        },
      ],
    });
    // 5000 + 110 + 100 + 12 = 5222 → /990
    expect(value).toBeCloseTo(5222 / 990, 6);
  });

  it("includes per-kg commission over the valuation weight and fixed commission as a flat amount", () => {
    const perKg = computeEstimatedAvgCostKg({
      ...base,
      commissionPersonName: "Broker",
      commissionRate: "0.1",
      commissionType: "PER_KG",
      commissionFxRate: "1",
    });
    // 5000 + 0.1×1000 = 5100 → /990
    expect(perKg).toBeCloseTo(5100 / 990, 6);

    const fixed = computeEstimatedAvgCostKg({
      ...base,
      commissionPersonName: "Broker",
      commissionRate: "50",
      commissionType: "FIXED",
      commissionFxRate: "1",
    });
    // 5000 + 50 = 5050 → /990
    expect(fixed).toBeCloseTo(5050 / 990, 6);
  });

  it("drops pending duty from the total", () => {
    const withDuty = computeEstimatedAvgCostKg({ ...base, dutyAmount: "200" });
    expect(withDuty).toBeCloseTo(5200 / 990, 6);

    const pending = computeEstimatedAvgCostKg({ ...base, dutyAmount: "200", dutyPending: true });
    expect(pending).toBeCloseTo(5000 / 990, 6);
  });

  it("returns null without a container or without any received weight", () => {
    expect(computeEstimatedAvgCostKg({ ...base, selectedContainer: null, selectedContainerId: "" })).toBeNull();
    expect(computeEstimatedAvgCostKg({ ...base, actualReceivedKg: "" })).toBeNull();
    expect(computeEstimatedAvgCostKg({ ...base, actualReceivedKg: "0" })).toBeNull();
  });

  it("falls back to the received weight when the container has no agreed quantity", () => {
    // resolveFactoryOffloadValuationKg: totalKg → declaredKg → receivedKg.
    // material = 5 × 1 × 990 = 4950 → /990 = 5
    const value = computeEstimatedAvgCostKg({
      ...base,
      selectedContainer: container({ totalKg: "0", declaredKg: "0" }),
    });
    expect(value).toBeCloseTo(5, 6);
  });

  it("falls back from totalKg to declaredKg for the valuation quantity", () => {
    const value = computeEstimatedAvgCostKg({
      ...base,
      selectedContainer: container({ totalKg: "", declaredKg: "800" }),
    });
    // material: 5 × 1 × 800 = 4000 → /990
    expect(value).toBeCloseTo(4000 / 990, 6);
  });
});

describe("buildOffloadPayload", () => {
  it("builds the base payload with duty status NONE and no commission block", () => {
    const payload = buildOffloadPayload(fields(), "key-1");
    expect(payload.containerId).toBe("1");
    expect(payload.offloadDate).toBe("2026-09-01");
    expect(payload.destination).toBeNull();
    expect(payload.receivedKg).toBe("990");
    expect(payload.costPerKg).toBe("5");
    expect(payload.currencyCode).toBe("USD");
    expect(payload.dutyStatus).toBe("NONE");
    expect(payload.dutyAmount).toBe("0");
    expect(payload.dutyNotes).toBeNull();
    expect(payload.additionalCharges).toEqual([]);
    expect(payload.mixBatchAllocations).toEqual([]);
    expect(payload).not.toHaveProperty("commission");
    expect(payload.idempotencyKey).toBe("key-1");
    // No account selected → explicit null account id (no supplier branch).
    expect(payload.freightAccountId).toBeNull();
    expect(payload).not.toHaveProperty("freightSupplierId");
  });

  it("maps SUP: references to supplier ids and bare ids to account ids", () => {
    const payload = buildOffloadPayload(fields({ freightAccountId: "SUP:7", otherChargesAccountId: "12" }), "key-2");
    expect(payload).toMatchObject({ freightSupplierId: 7, otherChargesAccountId: 12 });
    expect(payload).not.toHaveProperty("freightAccountId");
  });

  it("converts non-USD duty amounts to USD at the container rate", () => {
    const payload = buildOffloadPayload(
      fields({
        currencyCode: "EUR",
        fxRateToUsd: "2",
        dutyAmount: "100",
        dutyPending: false,
      }),
      "key-3"
    );
    expect(payload.dutyAmount).toBe("50");
    expect(payload.dutyStatus).toBe("CONFIRMED");

    const pending = buildOffloadPayload(
      fields({ currencyCode: "EUR", fxRateToUsd: "2", dutyAmount: "100", dutyPending: true }),
      "key-4"
    );
    expect(pending.dutyStatus).toBe("PENDING");
  });

  it("keeps USD duty amounts unchanged", () => {
    const payload = buildOffloadPayload(fields({ dutyAmount: "75.5" }), "key-5");
    expect(payload.dutyAmount).toBe("75.5");
  });

  it("assembles the commission block with the commission-specific FX rate", () => {
    const payload = buildOffloadPayload(
      fields({
        commissionFromContainer: true,
        containerCommissionCcy: "eur",
        commissionPersonName: "  Broker  ",
        commissionType: "PER_KG",
        commissionRate: "0.25",
        commissionFxRate: "1.18",
        commissionFxEffectiveDate: "2026-08-30",
        commissionLedgerAccountId: "",
      }),
      "key-6"
    );
    expect(payload.commission).toEqual({
      personName: "Broker",
      commissionType: "PER_KG",
      commissionRate: "0.25",
      currencyCode: "EUR",
      fxRateToUsd: "1.18",
      fxRateDate: "2026-08-30",
      ledgerAccountId: null,
    });
  });

  it("omits the commission block when there is no broker or rate", () => {
    const noBroker = buildOffloadPayload(fields({ commissionRate: "0.25" }), "key-7");
    expect(noBroker).not.toHaveProperty("commission");

    const noRate = buildOffloadPayload(fields({ commissionPersonName: "Broker", commissionRate: "0" }), "key-8");
    expect(noRate).not.toHaveProperty("commission");
  });

  it("filters additional charges and mix batch allocations to valid rows only", () => {
    const payload = buildOffloadPayload(
      fields({
        additionalCharges: [
          {
            id: "a1",
            description: "insp",
            amount: "10",
            currencyCode: "USD",
            fxRate: "1",
            fxRateLoading: false,
            ledgerAccountId: "SUP:9",
          },
          {
            id: "a2",
            description: "",
            amount: "0",
            currencyCode: "USD",
            fxRate: "1",
            fxRateLoading: false,
            ledgerAccountId: "",
          },
        ],
        mixBatchAllocations: [
          { mixBatchId: "31", weightKg: "120" },
          { mixBatchId: "", weightKg: "50" },
          { mixBatchId: "32", weightKg: "0" },
        ],
      }),
      "key-9"
    );
    expect(payload.additionalCharges).toEqual([
      {
        description: "insp",
        amount: "10",
        currencyCode: "USD",
        fxRateToUsd: "1",
        ledgerAccountId: null,
        supplierId: 9,
      },
    ]);
    expect(payload.mixBatchAllocations).toEqual([{ mixBatchId: 31, weightKg: "120" }]);
  });

  it("passes containerId through unchanged — the dialog guards against an empty selection before calling", () => {
    // Matches the original behavior: handleSubmit returns early when no
    // container is selected; the builder itself stays pure and total.
    expect(buildOffloadPayload(fields({ selectedContainerId: "" }), "key-10").containerId).toBe("");
    expect(buildOffloadPayload(fields({ selectedContainerId: "42" }), "key-10").containerId).toBe("42");
  });
});
