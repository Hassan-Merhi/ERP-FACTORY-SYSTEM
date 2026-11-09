import { describe, expect, it } from "vitest";
import {
  buildFactoryLoadingDispatchWorkbook,
} from "../server/routes/factory/customer-orders/loadingDispatchReportWorkbook";
import type {
  DispatchReport,
} from "../server/routes/factory/customer-orders/loadingDispatchReportData";
import type {
  LoadingDispatchComparison,
} from "../server/routes/factory/customer-orders/loadingDispatchComparison";

/**
 * Deferred Phase 7 regression cases. This file is committed but is
 * intentionally NOT executed until the owner elects to run CI later.
 */
function sampleReport(options: {
  historical?: boolean;
  includeScans?: boolean;
  formulaText?: string;
} = {}): DispatchReport {
  const scanned = options.includeScans !== false;
  const comparison = {
    scope: "trip",
    dispatch: { id: "55", dispatchNumber: 3, status: "CLOSED", truckPlate: "TRK-15" },
    planSource: "mixed", hasTripPlan: true,
    summary: {
      loadedBales: 3, loadedWeightKg: 120,
      expectedBales: 2, expectedWeightKg: 80, weightDifferenceKg: scanned ? 40 : 80,
      verifiedBales: scanned ? 1 : 0, verifiedWeightKg: scanned ? 40 : 0,
      matchedBales: scanned ? 1 : 0, missingBales: scanned ? 1 : 2,
      unexpectedBales: 0, exactMissingBales: scanned ? 1 : 2,
      crossTripMisplacedBales: 0, duplicateBales: 0,
      progressPercent: scanned ? 50 : 0,
    },
    articles: [{
      articleCode: "A", productName: "Cotton", priorityRank: 1,
      expectedQty: 2, scannedQty: scanned ? 1 : 0, matchedQty: scanned ? 1 : 0,
      missingQty: scanned ? 1 : 2, extraQty: 0,
      expectedWeightKg: 80, scannedWeightKg: scanned ? 40 : 0, status: "MISSING",
    }],
    missingBales: [{
      baleId: 102, baleReference: "A-102", articleCode: "A",
      productName: "Cotton", weightKg: 40, reason: "EXPECTED_NOT_SCANNED",
    }],
    unexpectedBales: [], crossTripBales: [], duplicateBales: [],
    trips: [
      { id: "55", dispatchNumber: 3, status: "CLOSED",
        truckPlate: "TRK-15", scannedBales: 1, scannedWeightKg: 40 },
      { id: "56", dispatchNumber: 4, status: "OPEN",
        truckPlate: "TRK-16", scannedBales: 0, scannedWeightKg: 0 },
    ],
  } as LoadingDispatchComparison;
  const historical = options.historical ?? false;
  return {
    source: historical ? "CLOSURE" : "LIVE",
    generatedAt: "2026-11-09T11:30:00.000Z",
    loading: {
      orderId: 250, companyName: "Factory Company",
      customerName: "Customer Test", proformaName: "Proforma 5 Nov",
      containerNumber: "CNT-100", status: "LOADING",
    },
    trip: {
      id: "55", dispatchNumber: 3, status: historical ? "CLOSED" : "OPEN",
      truckPlate: "TRK-15", driverName: options.formulaText || "Driver Test",
      destination: "Port", notes: "Truck notes",
      containerNumberSnapshot: "CNT-100",
      createdByUsername: "operator", createdAt: "2026-11-09T09:30:00.000Z",
      closedAt: historical ? "2026-11-09T11:00:00.000Z" : null,
      closedByUsername: historical ? "supervisor" : null,
    },
    closure: historical ? {
      id: "8", revision: 1, fingerprint: "a".repeat(64),
      closedByUsername: "supervisor", closedAt: "2026-11-09T11:00:00.000Z",
      approvedWithDiscrepancies: true, discrepancyReason: "One bale scheduled for the next truck",
      reopenedAt: null, reopenedByUsername: null, reopenReason: null,
    } : null,
    comparison, scans: scanned ? [{
      scanId: "77", baleId: 101, baleReference: "A-101", articleCode: "A",
      productName: "Cotton", weightKg: 40, scannedBy: "operator",
      scannedAt: "2026-11-09T10:30:00.000Z",
      dispatchId: "55", dispatchNumber: 3,
    }] : [],
    manifestAvailable: true,
    notices: [], audit: [{
      id: "11", dispatchId: "55", eventType: "BALE_SCANNED",
      actorUsername: "operator", createdAt: "2026-11-09T10:30:00.000Z",
      details: { baleId: 101, ref: "A-101" },
    }],
    auditTruncated: false,
  };
}

describe("Factory loading dispatch Phase 7 report workbook (not run)", () => {
  it("exports a multi-sheet trip manifest with separate missing/reference evidence", () => {
    const workbook = buildFactoryLoadingDispatchWorkbook(sampleReport());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary", "Article Comparison", "Verified Bales", "Missing Bales",
      "Unexpected Bales", "Wrong Truck", "Audit Trail",
    ]);
    expect(workbook.getWorksheet("Verified Bales")!.getCell("B2").value).toBe("A-101");
    expect(workbook.getWorksheet("Verified Bales")!.getCell("E2").value).toBe(40);
    expect(workbook.getWorksheet("Missing Bales")!.getCell("A2").value).toBe("A-102");
    expect(workbook.getWorksheet("Article Comparison")!.getCell("D2").value).toBe(2);
  });

  it("exports all truck trips for a loading-wide reconciliation", () => {
    const report = sampleReport();
    report.trip = null;
    report.closure = null;
    report.comparison.scope = "overall";
    const workbook = buildFactoryLoadingDispatchWorkbook(report);
    const trips = workbook.getWorksheet("Truck Trips")!;
    expect(trips.getCell("A2").value).toBe(3);
    expect(trips.getCell("A3").value).toBe(4);
  });

  it("preserves closure revision and supervisor approval reason in Summary", () => {
    const report = sampleReport({ historical: true });
    const workbook = buildFactoryLoadingDispatchWorkbook(report);
    const summary = workbook.getWorksheet("Summary")!;
    const rows = summary.getSheetValues() as Array<unknown>;
    expect(JSON.stringify(rows)).toContain("Historical closure (frozen)");
    expect(JSON.stringify(rows)).toContain("One bale scheduled for the next truck");
    expect(JSON.stringify(rows)).toContain("Closure Revision");
  });

  it("treats untrusted Excel formula-like text as literal cell content", () => {
    const report = sampleReport({ formulaText: "=HYPERLINK(\"https://bad.example\",\"Click\")" });
    const workbook = buildFactoryLoadingDispatchWorkbook(report);
    const summary = workbook.getWorksheet("Summary")!;
    const row = summary.getSheetValues().find((r) => Array.isArray(r) && r[1] === "Driver");
    expect(row).toBeDefined();
    expect((row as Array<unknown>)[2]).toBe("'=HYPERLINK(\"https://bad.example\",\"Click\")");
  });

  it("does not fabricate missing historical manifest rows when no saved scan snapshot exists", () => {
    const report = sampleReport({ historical: true, includeScans: false });
    report.manifestAvailable = false;
    report.notices = ["Earlier closure did not archive a bale-level manifest"];
    report.comparison.summary.verifiedBales = 1;
    const wb = buildFactoryLoadingDispatchWorkbook(report);
    expect(wb.getWorksheet("Verified Bales")!.rowCount).toBe(1);
    const sheet = wb.getWorksheet("Summary")!;
    expect(JSON.stringify(sheet.getSheetValues())).toContain("Earlier closure did not archive");
  });
});
