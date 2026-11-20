import { describe, expect, it } from "vitest";
import { reconcileGroundScan, type GroundExpectedBale } from "../client/src/pages/factory/groundscan/reconciliation";
import type { ScannedBale } from "../client/src/pages/factory/groundscan/types";

const stock = (referenceNumber: string, articleCode = "HMD101", weightKg = "40"): GroundExpectedBale => ({
  referenceNumber,
  articleCode,
  productName: "Test Product",
  weightKg,
});

const scanned = (refCode: string, articleCode = "HMD101", weightKg = 40, status = "IN_STOCK"): ScannedBale => ({
  refCode,
  articleCode,
  productName: "Test Product",
  weightKg,
  status,
  scannedAt: new Date("2026-11-20T08:00:00.000Z"),
  dateBaleProduced: null,
  workerName: null,
});

describe("Ground Scan Excel barcode reconciliation", () => {
  it("does not count container-loaded/finalized stock absent from the eligible stock snapshot as missing", () => {
    // Ground Scan stock API intentionally returns eligible in-stock bales only:
    // a loaded bale can still appear in historical scans, never in system stock.
    const result = reconcileGroundScan(
      [stock("AVAILABLE-1"), stock("AVAILABLE-2")],
      [scanned("AVAILABLE-1"), scanned("LOADED-1", "HMD101", 40, "LOADING")],
    );

    expect(result.systemBales).toHaveLength(2);
    expect(result.missingBales.map((row) => row.referenceNumber)).toEqual(["AVAILABLE-2"]);
    expect(result.extraBales.map((row) => row.refCode)).toEqual(["LOADED-1"]);
    expect(result.summaryArticles[0]).toMatchObject({
      systemQty: 2, scannedQty: 2, missingQty: 1, missingWt: 40,
    });
  });

  it("matches barcodes case-insensitively and ignores surrounding whitespace", () => {
    const result = reconcileGroundScan([stock("  Ref-012  ")], [scanned("ref-012")]);
    expect(result.missingBales).toHaveLength(0);
    expect(result.extraBales).toHaveLength(0);
  });

  it("never subtracts a nonmatching scanned bale of the same article from missing", () => {
    const result = reconcileGroundScan(
      [stock("A-001", "HMD101", "25"), stock("A-002", "HMD101", "40")],
      [scanned("A-001", "HMD101", 25), scanned("DIFFERENT-REF", "HMD101", 40)],
    );
    expect(result.summaryArticles[0]).toMatchObject({
      systemQty: 2,
      scannedQty: 2,
      missingQty: 1,
      missingWt: 40,
    });
    expect(result.missingBales.map((row) => row.referenceNumber)).toEqual(["A-002"]);
    expect(result.extraBales.map((row) => row.refCode)).toEqual(["DIFFERENT-REF"]);
    expect(result.totalMissingWt).toBe(40);
  });

  it("deduplicates repeated scans and stock references so totals remain consistent", () => {
    const result = reconcileGroundScan(
      [stock("DUPLICATE"), stock("duplicate"), stock("UNSCANNED")],
      [scanned("DUPLICATE"), scanned(" duplicate ")],
    );
    expect(result.systemBales).toHaveLength(2);
    expect(result.scannedBales).toHaveLength(1);
    expect(result.missingBales).toHaveLength(1);
    expect(result.summaryArticles[0]).toMatchObject({
      systemQty: 2, scannedQty: 1, missingQty: 1,
    });
  });

  it("keeps different article missing weights and quantities consistent with the detail sheet", () => {
    const result = reconcileGroundScan(
      [stock("A", "HMD101", "25"), stock("B", "HMD101", "40"), stock("C", "HMD102", "35")],
      [scanned("A", "HMD101", 25), scanned("X", "HMD103", 50)],
    );
    expect(result.missingBales).toHaveLength(2);
    expect(result.totalMissingWt).toBe(75);
    expect(result.summaryArticles.reduce((sum, row) => sum + row.missingQty, 0)).toBe(2);
    expect(result.summaryArticles.reduce((sum, row) => sum + row.missingWt, 0)).toBe(75);
  });
});
