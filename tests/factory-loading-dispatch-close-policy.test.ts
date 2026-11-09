import { describe, expect, it } from "vitest";
import { assessFactoryLoadingDispatchClose } from "../server/routes/factory/customer-orders/loadingDispatchClosePolicy";
import {
  compareFactoryLoadingDispatch,
  type ComparisonBale,
  type ComparisonScan,
} from "../server/routes/factory/customer-orders/loadingDispatchComparison";

const loaded: ComparisonBale[] = [
  { baleId: 101, baleReference: "A-101", articleCode: "A", productName: "Article A", weightKg: 40 },
  { baleId: 102, baleReference: "A-102", articleCode: "A", productName: "Article A", weightKg: 40 },
];
function scan(baleId: number, dispatchId = "1"): ComparisonScan {
  return {
    ...loaded.find((b) => b.baleId === baleId)!,
    scanId: "scan-" + baleId, dispatchId,
    dispatchNumber: Number(dispatchId), scannedBy: "Floor operator",
    scannedAt: "2026-11-09T09:00:00Z",
  };
}
function compare(scans: ComparisonScan[] = [], plan = false) {
  return compareFactoryLoadingDispatch({
    loaded, scans,
    expectedBales: plan ? loaded.map((b) => ({ ...b, dispatchId: "1" })) : [],
    expectedArticles: [],
    trips: [
      { id: "1", dispatchNumber: 1, status: "OPEN", truckPlate: null },
      { id: "2", dispatchNumber: 2, status: "OPEN", truckPlate: null },
    ],
    selectedDispatchId: "1",
  });
}
describe("Scan-only Factory dispatch close policy", () => {
  it("allows a physically scanned trip with no expected allocation", () => {
    expect(assessFactoryLoadingDispatchClose(compare([scan(101)]))).toMatchObject({
      issues: [], hasAnyScans: true, needsApproval: false, canCloseClean: true,
    });
  });
  it("allows close even if not all Pending Loading bales were scanned on that trip", () => {
    expect(assessFactoryLoadingDispatchClose(compare([scan(101), scan(102)], true))).toMatchObject({
      needsApproval: false, canCloseClean: true,
    });
  });
  it("requires at least one verified bale before closing a trip", () => {
    expect(assessFactoryLoadingDispatchClose(compare())).toMatchObject({
      hasAnyScans: false, canCloseClean: false,
    });
  });
  it("ignores old truck allocation mismatches because trips are scan-only", () => {
    const p = assessFactoryLoadingDispatchClose(compare([scan(101)], true));
    expect(p.issues.every((issue) => issue.code !== "NO_EXPECTED_PLAN")).toBe(true);
  });
  it("flags a scanned bale no longer in Pending Loading for supervisor review", () => {
    const staleScan = { ...scan(101), baleId: 999, baleReference: "REMOVED-999" };
    const p = assessFactoryLoadingDispatchClose(compare([staleScan]));
    expect(p.issues.map((i) => i.code)).toContain("UNEXPECTED_SCANS");
    expect(p.needsApproval).toBe(true);
  });
});
