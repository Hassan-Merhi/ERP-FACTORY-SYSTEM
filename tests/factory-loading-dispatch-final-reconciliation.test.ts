import { describe, expect, it } from "vitest";
import { compareFactoryLoadingDispatch } from "../server/routes/factory/customer-orders/loadingDispatchComparison";

const loaded = [1, 2, 3].map((baleId) => ({
  orderBaleId: 100 + baleId,
  baleId,
  baleReference: "BAL-" + baleId,
  articleCode: "A",
  productName: "Article A",
  weightKg: 40,
}));
const trips = [
  { id: "11", dispatchNumber: 1, status: "CLOSED", truckPlate: null },
  { id: "22", dispatchNumber: 2, status: "CLOSED", truckPlate: null },
];
const scans = [loaded[0], loaded[2]].map((bale, i) => ({
  ...bale,
  scanId: String(i + 1),
  dispatchId: trips[i].id,
  dispatchNumber: trips[i].dispatchNumber,
  scannedBy: "Scanner",
  scannedAt: "2026-11-09T10:00:00Z",
}));
describe("Final scan-only reconciliation against Pending Loading", () => {
  it("finds only bales not scanned on any trip and preserves loading link IDs", () => {
    const result = compareFactoryLoadingDispatch({
      loaded, scans, expectedBales: [], expectedArticles: [], trips,
    });
    expect(result.summary).toMatchObject({
      loadedBales: 3,
      verifiedBales: 2,
      missingBales: 1,
      matchedBales: 2,
    });
    expect(result.missingBales).toEqual([
      expect.objectContaining({ baleId: 2, orderBaleId: 102, baleReference: "BAL-2" }),
    ]);
  });
  it("does not invent per-truck expected quantities without allocations", () => {
    const result = compareFactoryLoadingDispatch({
      loaded, scans, expectedBales: [], expectedArticles: [], trips,
      selectedDispatchId: "11",
    });
    expect(result.hasTripPlan).toBe(false);
    expect(result.summary.expectedBales).toBeNull();
    expect(result.summary.missingBales).toBeNull();
    expect(result.summary.verifiedBales).toBe(1);
  });
});
