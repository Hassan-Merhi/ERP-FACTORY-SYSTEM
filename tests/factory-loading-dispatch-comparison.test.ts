import { describe, expect, it } from "vitest";
import {
  compareFactoryLoadingDispatch,
  type ComparisonBale,
  type ComparisonExpectedArticle,
  type ComparisonExpectedBale,
  type ComparisonScan,
  type ComparisonTrip,
} from "../server/routes/factory/customer-orders/loadingDispatchComparison";

const trucks: ComparisonTrip[] = [
  { id: "1", dispatchNumber: 1, status: "OPEN", truckPlate: "Truck A" },
  { id: "2", dispatchNumber: 2, status: "OPEN", truckPlate: "Truck B" },
];

function bale(id: number, code = "A"): ComparisonBale {
  return {
    baleId: id, baleReference: code + "-" + String(id).padStart(3, "0"),
    articleCode: code, productName: "Article " + code, weightKg: code === "B" ? 25 : 40,
  };
}
function scan(id: number, dispatch = 1, code = "A"): ComparisonScan {
  return {
    ...bale(id, code), scanId: String(id) + "-" + dispatch,
    dispatchId: String(dispatch), dispatchNumber: dispatch,
    scannedBy: "Floor operator", scannedAt: "2026-11-09T08:00:00.000Z",
  };
}
function planned(id: number, dispatch = 1, code = "A"): ComparisonExpectedBale {
  return { ...bale(id, code), dispatchId: String(dispatch) };
}
function target(code: string, qty: number, dispatch = 1): ComparisonExpectedArticle {
  return { dispatchId: String(dispatch), articleCode: code,
    productName: "Article " + code, expectedQty: qty, priorityRank: 1 };
}
function compare(args: {
  loaded?: ComparisonBale[];
  scans?: ComparisonScan[];
  expectedBales?: ComparisonExpectedBale[];
  expectedArticles?: ComparisonExpectedArticle[];
  selectedDispatchId?: string;
}) {
  return compareFactoryLoadingDispatch({
    loaded: args.loaded ?? [bale(1), bale(2), bale(3, "B")],
    scans: args.scans ?? [],
    expectedBales: args.expectedBales ?? [],
    expectedArticles: args.expectedArticles ?? [],
    trips: trucks,
    ...(args.selectedDispatchId ? { selectedDispatchId: args.selectedDispatchId } : {}),
  });
}

describe("loading dispatch Phase 4 comparisons", () => {
  it("compares all currently loaded bale IDs across separate trips", () => {
    const result = compare({ scans: [scan(1)] });
    expect(result.scope).toBe("overall");
    expect(result.planSource).toBe("loading");
    expect(result.summary).toMatchObject({
      loadedBales: 3, expectedBales: 3, verifiedBales: 1,
      matchedBales: 1, missingBales: 2, unexpectedBales: 0,
      exactMissingBales: 2, progressPercent: 33,
    });
    expect(result.missingBales.map((row) => row.baleReference)).toEqual(["A-002", "B-003"]);
    expect(result.articles.find((row) => row.articleCode === "A")).toMatchObject({
      expectedQty: 2, scannedQty: 1, missingQty: 1, status: "MISSING",
    });
    expect(result.summary.weightDifferenceKg).toBe(65);
  });

  it("retains unexpectedly scanned references after they disappear from the loading", () => {
    const result = compare({ scans: [scan(9)] });
    expect(result.summary.matchedBales).toBe(0);
    expect(result.summary.missingBales).toBe(3);
    expect(result.summary.unexpectedBales).toBe(1);
    expect(result.unexpectedBales[0]).toMatchObject({
      baleReference: "A-009", reason: "NO_LONGER_IN_LOADING", dispatchNumber: 1,
    });
    expect(result.articles.find((row) => row.articleCode === "A")?.status).toBe("BOTH");
  });

  it("does not invent an expected quantity or missing references for an unplanned truck", () => {
    const result = compare({ selectedDispatchId: "1", scans: [scan(1)] });
    expect(result.hasTripPlan).toBe(false);
    expect(result.planSource).toBe("none");
    expect(result.summary.expectedBales).toBeNull();
    expect(result.summary.missingBales).toBeNull();
    expect(result.summary.progressPercent).toBeNull();
    expect(result.missingBales).toEqual([]);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].expectedQty).toBeNull();
    expect(result.articles[0].status).toBe("UNPLANNED");
  });

  it("detects wrong exact barcodes even when article quantities appear equal", () => {
    const result = compare({
      loaded: [bale(1), bale(2), bale(3)],
      selectedDispatchId: "1",
      expectedBales: [planned(1), planned(2)],
      scans: [scan(1), scan(3)],
    });
    expect(result.hasTripPlan).toBe(true);
    expect(result.summary).toMatchObject({
      expectedBales: 2, verifiedBales: 2, matchedBales: 1,
      missingBales: 1, exactMissingBales: 1, unexpectedBales: 1,
      progressPercent: 50,
    });
    expect(result.missingBales[0].baleReference).toBe("A-002");
    expect(result.unexpectedBales[0].reason).toBe("NOT_IN_TRIP_PLAN");
    expect(result.articles[0].status).toBe("BOTH");
  });

  it("links a bale expected on one truck but scanned on a different truck", () => {
    const common = { expectedBales: [planned(2, 1)], scans: [scan(2, 2)] };
    const first = compare({ ...common, selectedDispatchId: "1" });
    expect(first.crossTripBales).toMatchObject([{
      baleId: 2, reason: "PLANNED_HERE_SCANNED_ELSEWHERE",
      dispatchNumber: 2, scannedBy: "Floor operator",
    }]);
    const second = compare({ ...common, selectedDispatchId: "2" });
    expect(second.hasTripPlan).toBe(false);
    expect(second.unexpectedBales).toMatchObject([{
      baleId: 2, reason: "ASSIGNED_TO_ANOTHER_TRIP", expectedDispatchNumber: 1,
    }]);
  });

  it("compares article-only trip targets without fabricating specific missing refs", () => {
    const result = compare({
      selectedDispatchId: "1",
      expectedArticles: [target("A", 2)],
      scans: [scan(1)],
    });
    expect(result.summary.expectedBales).toBe(2);
    expect(result.summary.missingBales).toBe(1);
    expect(result.summary.exactMissingBales).toBe(0);
    expect(result.missingBales).toEqual([]);
    expect(result.articles.find((row) => row.articleCode === "A")).toMatchObject({
      expectedQty: 2, scannedQty: 1, missingQty: 1,
    });
  });

  it("reports unexpected article scans when the trip has a different article target", () => {
    const result = compare({
      selectedDispatchId: "1",
      expectedArticles: [target("A", 1)],
      scans: [scan(3, 1, "B")],
    });
    expect(result.articles.find((row) => row.articleCode === "B")).toMatchObject({
      expectedQty: 0, scannedQty: 1, extraQty: 1, status: "EXTRA",
    });
    expect(result.unexpectedBales[0].reason).toBe("NOT_IN_TRIP_PLAN");
  });

  it("surfaces anomalous double-verified active bale IDs instead of counting twice", () => {
    const result = compare({ scans: [scan(1, 1), scan(1, 2)] });
    expect(result.summary.verifiedBales).toBe(1);
    expect(result.summary.duplicateBales).toBe(1);
    expect(result.duplicateBales[0].dispatchNumber).toBe(2);
  });
});
