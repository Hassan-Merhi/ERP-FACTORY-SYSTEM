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
function scan(baleId: number, dispatchId = "1", scannedWeight = 40): ComparisonScan {
  return {
    ...loaded.find((b) => b.baleId === baleId)!,
    scanId: "scan-" + baleId, dispatchId,
    dispatchNumber: Number(dispatchId), weightKg: scannedWeight,
    scannedBy: "Floor operator", scannedAt: "2026-11-09T09:00:00Z",
  };
}
function compare(config: {
  scans?: ComparisonScan[];
  withPlan?: boolean;
  expectedBaleIds?: number[];
  quantity?: number;
} = {}) {
  const withPlan = config.withPlan !== false;
  return compareFactoryLoadingDispatch({
    loaded,
    scans: config.scans ?? [],
    expectedBales: withPlan ? (config.expectedBaleIds ?? [101, 102]).map((id) => ({
      ...loaded.find((b) => b.baleId === id)!, dispatchId: "1",
    })) : [],
    expectedArticles: withPlan
      ? [{ dispatchId: "1", articleCode: "A", productName: "Article A",
        expectedQty: config.quantity ?? 2, priorityRank: 1 }]
      : [],
    trips: [
      { id: "1", dispatchNumber: 1, status: "OPEN", truckPlate: "TRK-1" },
      { id: "2", dispatchNumber: 2, status: "OPEN", truckPlate: "TRK-2" },
    ],
    selectedDispatchId: "1",
  });
}

describe("Factory loading dispatch End Dispatch policy (tests intentionally deferred)", () => {
  it("allows clean planned and fully scanned truck without approval", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({ scans: [scan(101), scan(102)] }));
    expect(policy).toMatchObject({
      issues: [], hasAnyScans: true, needsApproval: false, canCloseClean: true,
    });
  });

  it("requires supervisor approval for missing expected scans", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({ scans: [scan(101)] }));
    expect(policy.canCloseClean).toBe(false);
    expect(policy.needsApproval).toBe(true);
    expect(policy.issues.map((i) => i.code)).toContain("MISSING_BALES");
  });

  it("does not silently treat an unplanned truck as clean", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({
      withPlan: false, scans: [scan(101)],
    }));
    expect(policy.issues.map((i) => i.code)).toContain("NO_EXPECTED_PLAN");
    expect(policy.needsApproval).toBe(true);
  });

  it("prevents an empty trip from clean close, even if its plan matches zero", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({
      scans: [], withPlan: false,
    }));
    expect(policy.hasAnyScans).toBe(false);
    expect(policy.canCloseClean).toBe(false);
  });

  it("requires discrepancy approval for bales allocated to another truck", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({
      scans: [scan(101, "2"), scan(102)],
    }));
    expect(policy.canCloseClean).toBe(false);
    expect(policy.issues.map((i) => i.code)).toContain("CROSS_TRIP_MISMATCH");
  });

  it("requires approval for weight discrepancies even when refs match", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({
      scans: [scan(101, "1", 41), scan(102)],
    }));
    expect(policy.issues.map((i) => i.code)).toContain("WEIGHT_MISMATCH");
  });

  it("requires approval for off-plan exact barcodes despite equal total qty", () => {
    const policy = assessFactoryLoadingDispatchClose(compare({
      expectedBaleIds: [101], quantity: 1,
      scans: [scan(102)],
    }));
    expect(policy.issues.map((i) => i.code)).toContain("UNEXPECTED_SCANS");
    expect(policy.canCloseClean).toBe(false);
  });
});
