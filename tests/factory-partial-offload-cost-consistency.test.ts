import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { resolveFactoryOffloadValuationKg } from "../shared/factoryOffloadValuation";
import { computeContainerLandedCost } from "../server/services/factory/containerLandedCost";
import { calculateMovingAverageRate } from "../server/services/factory/factoryCostingEngine";

const repoFile = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

const buildContainer = (actualReceivedKg: string) => ({
  id: 1,
  companyId: 1,
  containerNumber: "CMAU7353468",
  currencyCode: "USD",
  fxRateToUsd: "1",
  fxRateToUsdOffload: "1",
  fxRateConfirmed: true,
  totalKg: "24000",
  declaredKg: "24000",
  actualReceivedKg,
  ratePerKg: "0.500000",
  freight: "648",
  freightCurrencyCode: "USD",
  otherCharges: "0",
  commissionAmount: "0",
  dutyStatus: "NONE",
  dutyAmount: "0",
}) as any;

describe("partial offload cost consistency", () => {
  it("keeps the full container value fixed and divides it by actual received weight", () => {
    expect(
      resolveFactoryOffloadValuationKg({
        totalKg: "24000",
        declaredKg: "24000",
        receivedKg: "21340",
      })
    ).toBe(24000);

    const shortReceipt = computeContainerLandedCost(buildContainer("21340"), [], null, []);
    const fullReceipt = computeContainerLandedCost(buildContainer("24000"), [], null, []);

    expect(shortReceipt.valuationKg).toBe(24000);
    expect(shortReceipt.allocationKg).toBe(21340);
    expect(shortReceipt.fullCostUsd).toBeCloseTo(12648, 6);
    expect(fullReceipt.fullCostUsd).toBeCloseTo(12648, 6);
    expect(shortReceipt.costPerKgUsd).toBeCloseTo(12648 / 21340, 6);
    expect(fullReceipt.costPerKgUsd).toBeCloseTo(12648 / 24000, 6);
    expect(shortReceipt.costPerKgUsd).toBeGreaterThan(fullReceipt.costPerKgUsd);
  });

  it("keeps the supplier row as a true moving average using actual incoming kg and the canonical new rate", () => {
    const oldRemainingKg = new Decimal("122880");
    const oldLockedRate = new Decimal("0.630000");
    const incomingKg = new Decimal("21340");
    const canonicalIncomingRate = new Decimal(12648).div(incomingKg);

    const expected = oldRemainingKg
      .times(oldLockedRate)
      .plus(incomingKg.times(canonicalIncomingRate))
      .div(oldRemainingKg.plus(incomingKg));

    const actual = calculateMovingAverageRate({
      existingQuantityKg: oldRemainingKg,
      existingRatePerKg: oldLockedRate,
      incomingQuantityKg: incomingKg,
      incomingRatePerKg: canonicalIncomingRate,
    });

    expect(actual.toFixed(8)).toBe(expected.toFixed(8));
    expect(actual.toNumber()).not.toBe(canonicalIncomingRate.toNumber());
  });

  it("pins the UI preview, server offload, receipt history, and post-offload refresh to the same sources", () => {
    // The UI-preview cost math was extracted from OffloadDialog.tsx into the
    // pure module below during the P1 god-file split; the contract being
    // pinned (valuation basis vs actual received divisor) is unchanged.
    const dialog = repoFile(
      "client",
      "src",
      "pages",
      "factory",
      "production-raw-stock",
      "offloadFormCalculations.ts"
    );
    const landedCost = repoFile(
      "server",
      "services",
      "factory",
      "containerLandedCost.ts"
    );
    const offloadRoute = repoFile(
      "server",
      "routes",
      "factory",
      "raw-stock",
      "rawStockOffloadRoutes.ts"
    );
    const historyRoute = repoFile(
      "server",
      "routes",
      "factory",
      "raw-stock",
      "rawStockAdjRoutes.ts"
    );
    const invalidation = repoFile(
      "client",
      "src",
      "pages",
      "factory",
      "factory-containers",
      "postoffloaddialog",
      "utils.ts"
    );

    expect(dialog).toContain("resolveFactoryOffloadValuationKg");
    expect(dialog).toContain("return totalUsd / receivedKg;");
    expect(dialog).not.toContain("return totalUsd / valuationKg;");
    expect(landedCost).toContain("const allocationKg = receivedKg.gt(0) ? receivedKg : originalCostBasisKg;");

    expect(offloadRoute).toContain("newReceivedKg: dReceivedKg.toNumber()");
    expect(offloadRoute).toContain("newContainerLandedCostPerKgUsd: dCostPerKgUsd.toNumber()");

    expect(historyRoute).toContain("costPerKg: parseFloat(r.costPerKgUsd as string)");
    expect(invalidation).toContain('key.startsWith("/api/factory/raw-stock/history/")');
  });
});
