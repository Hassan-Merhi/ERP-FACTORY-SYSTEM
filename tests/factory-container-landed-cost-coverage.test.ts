/**
 * Authoritative container landed cost (computeContainerLandedCost): the FX
 * and zero-weight short-circuits, and every currency rule for freight, other
 * charges (rows and legacy column), commission (record and container
 * snapshot), duty and post-offload charges, including which foreign amounts
 * without a confirmed rate mark the result unresolved.
 */
import { describe, expect, it } from "vitest";

import { computeContainerLandedCost } from "../server/services/factory/containerLandedCost";

type Container = Parameters<typeof computeContainerLandedCost>[0];
type Charge = Parameters<typeof computeContainerLandedCost>[1][number];

/** A CFA container (0.002 USD per CFA, confirmed) of 100 kg with no material value and no charges. */
const cfa = (patch: Record<string, unknown> = {}) =>
  ({
    currencyCode: "CFA",
    fxRateToUsd: "0.002",
    fxRateToUsdOffload: null,
    fxRateConfirmed: true,
    totalKg: "100",
    declaredKg: null,
    actualReceivedKg: "0",
    ratePerKg: "0",
    freight: "0",
    freightCurrencyCode: null,
    freightFxRateToUsd: null,
    freightFxRateConfirmed: false,
    otherCharges: "0",
    otherChargesCurrencyCode: null,
    commissionAmount: "0",
    commissionCurrencyCode: null,
    commissionFxRateToUsd: null,
    commissionFxRateConfirmed: false,
    dutyStatus: "NONE",
    dutyAmount: "0",
    ...patch,
  }) as unknown as Container;

const charge = (
  amount: string,
  currencyCode: string | null,
  fxRateToUsd: string | null = null,
  fxRateConfirmed = false
) => ({ amount, currencyCode, fxRateToUsd, fxRateConfirmed }) as Charge;

const cost = (
  container: Container,
  extra: { additional?: Charge[]; commission?: Record<string, unknown> | null; other?: Charge[] } = {}
) =>
  computeContainerLandedCost(
    container,
    extra.additional ?? [],
    (extra.commission ?? null) as Parameters<typeof computeContainerLandedCost>[2],
    extra.other
  );

describe("short-circuits", () => {
  it("refuses to value a foreign container without a confirmed rate", () => {
    expect(cost(cfa({ fxRateConfirmed: false }))).toEqual({
      valuationKg: 0,
      allocationKg: 0,
      fullCost: 0,
      fullCostUsd: 0,
      costPerKg: 0,
      costPerKgUsd: 0,
      fxUnresolved: true,
    });
  });

  it("returns zero cost without any weight", () => {
    expect(cost(cfa({ currencyCode: null, totalKg: "0" }))).toMatchObject({
      valuationKg: 0,
      fullCost: 0,
      fxUnresolved: false,
    });
  });
});

describe("USD container", () => {
  it("adds every charge once and divides by the agreed weight when nothing was received", () => {
    const result = cost(
      cfa({
        currencyCode: "USD",
        fxRateToUsd: null,
        ratePerKg: "1",
        freight: "10",
        otherCharges: "5",
        commissionAmount: "3",
        dutyStatus: "CONFIRMED",
        dutyAmount: "2",
      }),
      { additional: [charge("4", "USD")] }
    );
    expect(result).toMatchObject({
      valuationKg: 100,
      allocationKg: 100,
      fullCost: 124,
      fullCostUsd: 124,
      costPerKg: 1.24,
    });
    expect(result.fxUnresolved).toBe(false);
  });
});

describe("foreign container", () => {
  it("values material on agreed weight, converts each charge and divides by received weight", () => {
    const result = cost(
      cfa({
        ratePerKg: "500",
        actualReceivedKg: "50",
        freight: "10",
        freightCurrencyCode: "EUR",
        freightFxRateToUsd: "1.1",
        freightFxRateConfirmed: true,
        dutyStatus: "CONFIRMED",
        dutyAmount: "1000",
      }),
      {
        other: [charge("4", "USD"), charge("1000", null), charge("5", "EUR"), charge("0", "EUR")],
        commission: { commissionTotal: "10", currencyCode: "EUR", fxRateToUsd: "1.2", fxRateConfirmed: true },
        additional: [charge("500", "CFA"), charge("2", "EUR", "1.5", true), charge("3", "EUR"), charge("0", "GBP")],
      }
    );
    expect(result.valuationKg).toBe(100);
    expect(result.allocationKg).toBe(50);
    expect(result.fullCost).toBeCloseTo(67500, 6);
    expect(result.fullCostUsd).toBeCloseTo(135, 6);
    expect(result.costPerKg).toBeCloseTo(1350, 6);
    expect(result.costPerKgUsd).toBeCloseTo(2.7, 6);
    expect(result.fxUnresolved).toBe(true);
  });

  it.each([
    ["container-currency freight", { freight: "1000", freightCurrencyCode: "CFA" }, 2, false],
    ["USD freight", { freight: "3", freightCurrencyCode: "USD" }, 3, false],
    ["unconfirmed foreign freight", { freight: "3", freightCurrencyCode: "EUR", freightFxRateToUsd: "1.1" }, 0, true],
    ["zero foreign freight", { freight: "0", freightCurrencyCode: "EUR" }, 0, false],
    ["legacy USD other charges", { otherCharges: "6", otherChargesCurrencyCode: "USD" }, 6, false],
    ["legacy container-currency other charges", { otherCharges: "500", otherChargesCurrencyCode: "CFA" }, 1, false],
    ["legacy foreign other charges", { otherCharges: "5", otherChargesCurrencyCode: "EUR" }, 0, true],
    ["legacy zero foreign other charges", { otherCharges: "0", otherChargesCurrencyCode: "EUR" }, 0, false],
    ["USD commission column", { commissionAmount: "7", commissionCurrencyCode: "USD" }, 7, false],
    ["container-currency commission column", { commissionAmount: "1500" }, 3, false],
    [
      "foreign commission with confirmed snapshot",
      {
        commissionAmount: "2",
        commissionCurrencyCode: "EUR",
        commissionFxRateToUsd: "1.5",
        commissionFxRateConfirmed: true,
      },
      3,
      false,
    ],
    ["foreign commission without snapshot", { commissionAmount: "2", commissionCurrencyCode: "EUR" }, 0, true],
    ["zero foreign commission without snapshot", { commissionAmount: "0", commissionCurrencyCode: "EUR" }, 0, false],
    ["unconfirmed duty", { dutyStatus: "ESTIMATED", dutyAmount: "9000" }, 0, false],
  ])("%s", (_label, patch, usd, unresolved) => {
    const result = cost(cfa(patch));
    expect(result.fullCostUsd).toBeCloseTo(usd as number, 6);
    expect(result.fullCost).toBeCloseTo((usd as number) / 0.002, 4);
    expect(result.fxUnresolved).toBe(unresolved);
  });

  it.each([
    ["USD commission record", { commissionTotal: "5", currencyCode: "USD" }, 5, false],
    ["container-currency commission record", { commissionTotal: "500", currencyCode: null }, 1, false],
    [
      "unconfirmed record falls back to the snapshot",
      { commissionTotal: "2", currencyCode: "EUR", fxRateToUsd: "9" },
      3,
      false,
    ],
    [
      "record without any confirmed rate",
      { commissionTotal: "2", currencyCode: "GBP", fxRateConfirmed: false },
      0,
      true,
    ],
    ["record without a total", { commissionTotal: null, currencyCode: "USD" }, 0, false],
  ])("%s", (label, record, usd, unresolved) => {
    const snapshot =
      label === "record without any confirmed rate"
        ? {}
        : { commissionFxRateToUsd: "1.5", commissionFxRateConfirmed: true };
    const result = cost(cfa(snapshot), { commission: record });
    expect(result.fullCostUsd).toBeCloseTo(usd as number, 6);
    expect(result.fxUnresolved).toBe(unresolved);
  });

  it("uses the offload rate when one was recorded", () => {
    const result = cost(cfa({ fxRateToUsdOffload: "0.004", ratePerKg: "10" }));
    expect(result.fullCostUsd).toBeCloseTo(4, 6);
  });
});
