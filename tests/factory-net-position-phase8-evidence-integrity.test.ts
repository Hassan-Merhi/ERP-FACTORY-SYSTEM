/**
 * Factory Net Position Phase 8 contracts. Authored but intentionally NOT run;
 * Claude performs CI, runtime validation, and DB reconciliation in Phase 9.
 */
import { describe, expect, it } from "vitest";
import { summarizeHistoricalEvidence } from "../server/services/factory/netPositionHistoryCoverage";
import { assertHistoricalReportIntegrity } from "../server/services/factory/netPositionHistoricalIntegrity";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";

const scope: FactoryNetPositionAsOf = {
  asOf: "2026-10-19",
  businessToday: "2026-10-21",
  timeZone: "Asia/Beirut",
  historyBasis: "known-at-cutoff",
  isHistorical: true,
};

const emptyEvidence = () => ({
  legacy_raw: "0",
  missing_receipt_rate: "0",
  missing_scan_time: "0",
  ambiguous_restoration: "0",
  missing_bale_finalization: "0",
  edited_container_master: "0",
  backdated_fx: "0",
  missing_rent_posted_at: "0",
  mutable_ledger_opening: "0",
  unowned_mix_sources: "0",
  rewritten_vouchers: "0",
  rewritten_mix_batches: "0",
});

const row = (code: string, value: number, category = "Asset") => ({
  name: code,
  code,
  category,
  value,
});

const validReport = () => ({
  forUs: {
    total: 125,
    breakdown: [{ name: "Asset", value: 125 }],
    accounts: [
      row("INVENTORY", 50),
      row("RAW_MATERIAL", 20),
      row("STOCK_OTW", 30),
      row("BALANCE_ON_TABLE", 10),
      row("VERIFIED_ORDERS", 10),
      row("LOADING_ORDERS", 5),
    ],
  },
  onUs: {
    total: 45,
    breakdown: [{ name: "Supplier", value: 45 }],
    accounts: [row("SUPPLIER", 20, "Supplier"), row("EMPLOYEE_PAYROLL_PAYABLE", 25, "Supplier")],
  },
  forUsTotal: 125,
  onUsTotal: 45,
  netPosition: 80,
  netPositionLabel: "We have more than we owe",
  inventoryValue: 50,
  rawMaterialValue: 20,
  stockOtwValue: 30,
  balanceOnTableValue: 10,
  supplierLiabilities: 20,
  supplierOverpayments: 0,
  payrollPayable: 25,
  pendingOrders: [{ grandTotal: 2 }],
  verifiedOrders: [{ grandTotal: 10 }],
  loadingOrders: [{ grandTotal: 5 }],
  pendingTotal: 2,
  verifiedTotal: 10,
  loadingTotal: 5,
});

describe("Phase 8 historical source completeness", () => {
  it("never declares an empty diagnostic query to be independent historical certification", () => {
    const result = summarizeHistoricalEvidence(scope, emptyEvidence());
    expect(result.gaps).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.certified).toBe(false);
  });

  it("reports counted gaps without returning customer identities or guessed historical values", () => {
    const result = summarizeHistoricalEvidence(scope, {
      ...emptyEvidence(),
      legacy_raw: "3",
      missing_scan_time: "8",
      backdated_fx: "1",
    });
    expect(result.gaps.map((g) => [g.code, g.records])).toEqual([
      ["HISTORICAL_COVERAGE_LEGACY_RAW", 3],
      ["HISTORICAL_COVERAGE_UNDATED_SCANS", 8],
      ["HISTORICAL_COVERAGE_BACKDATED_FX", 1],
    ]);
    expect(result.certified).toBe(false);
  });

  it("fails closed for a negative, null, or invalid count, never hiding them as zero", () => {
    expect(() =>
      summarizeHistoricalEvidence(scope, {
        ...emptyEvidence(),
        legacy_raw: -1,
      })
    ).toThrow("HISTORICAL_COVERAGE_COUNT_INVALID");
    expect(() =>
      summarizeHistoricalEvidence(scope, {
        ...emptyEvidence(),
        missing_scan_time: "not-a-number",
      })
    ).toThrow("HISTORICAL_COVERAGE_COUNT_INVALID");
    expect(() =>
      summarizeHistoricalEvidence(scope, {
        ...emptyEvidence(),
        backdated_fx: null,
      } as never)
    ).toThrow("HISTORICAL_COVERAGE_COUNT_INVALID");
  });
});

describe("Phase 8 read-only historical report integrity", () => {
  it("accepts a signed, fully reconciled report with supplier/payroll/OTW/order categories", () => {
    expect(() => assertHistoricalReportIntegrity(validReport())).not.toThrow();
  });

  it("does not report a false October 19 OTW amount even when the headers add up", () => {
    const report = validReport();
    report.stockOtwValue = 40;
    expect(() => assertHistoricalReportIntegrity(report)).toThrow("HISTORICAL_INTEGRITY_MISMATCH:otw");
  });

  it("requires the verified order account and independently scoped order detail to match", () => {
    const report = validReport();
    report.verifiedOrders = [{ grandTotal: 12 }];
    expect(() => assertHistoricalReportIntegrity(report)).toThrow("HISTORICAL_INTEGRITY_MISMATCH:verifiedOrderDetails");
  });

  it("rejects silent historical supplier and payroll understatements", () => {
    const supplier = validReport();
    supplier.supplierLiabilities = 19;
    expect(() => assertHistoricalReportIntegrity(supplier)).toThrow("HISTORICAL_INTEGRITY_MISMATCH:supplierPayables");

    const payroll = validReport();
    payroll.payrollPayable = 24;
    expect(() => assertHistoricalReportIntegrity(payroll)).toThrow("HISTORICAL_INTEGRITY_MISMATCH:payroll");
  });

  it("rejects category rows that do not reconcile to the top What We Have card", () => {
    const report = validReport();
    report.forUs.breakdown[0].value = 124;
    expect(() => assertHistoricalReportIntegrity(report)).toThrow("HISTORICAL_INTEGRITY_MISMATCH:assetCategories");
  });
});
