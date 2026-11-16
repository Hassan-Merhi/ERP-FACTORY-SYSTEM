/**
 * Phase 8 evidence diagnostics contracts.
 * Saved for Claude; do not run as part of branch implementation.
 */
import { describe, it, expect } from "vitest";
import { summarizeHistoricalEvidence } from "../server/services/factory/netPositionHistoryCoverage";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";

const scope: FactoryNetPositionAsOf = {
  asOf: "2026-10-19",
  businessToday: "2026-10-21",
  timeZone: "Asia/Beirut",
  historyBasis: "known-at-cutoff",
  isHistorical: true,
};
const empty = {
  legacy_raw: 0,
  missing_receipt_rate: 0,
  missing_scan_time: 0,
  ambiguous_restoration: 0,
  missing_bale_finalization: 0,
  edited_container_master: 0,
  backdated_fx: 0,
  missing_rent_posted_at: 0,
  mutable_ledger_opening: 0,
  unowned_mix_sources: 0,
  rewritten_vouchers: 0,
  rewritten_mix_batches: 0,
};

describe("Factory historical Phase 8 evidence coverage", () => {
  it("never certifies historical accuracy just because no gap was detected", () => {
    const result = summarizeHistoricalEvidence(scope, empty);
    expect(result).toEqual({
      asOf: "2026-10-19",
      basis: "known-at-cutoff",
      certified: false,
      status: "partial",
      gaps: [],
    });
  });

  it("reports missing scan events and backdated FX as explicit company/date counts", () => {
    const result = summarizeHistoricalEvidence(scope, {
      ...empty,
      missing_scan_time: "12",
      legacy_raw: "5",
      backdated_fx: "1",
    });
    expect(result.gaps).toEqual([
      expect.objectContaining({ code: "HISTORICAL_COVERAGE_LEGACY_RAW", records: 5, category: "Raw Materials / OTW" }),
      expect.objectContaining({
        code: "HISTORICAL_COVERAGE_UNDATED_SCANS",
        records: 12,
        category: "Stock in Hand / Uninvoiced Orders",
      }),
      expect.objectContaining({ code: "HISTORICAL_COVERAGE_BACKDATED_FX", records: 1 }),
    ]);
    expect(result.certified).toBe(false);
  });

  it("counts distinct restored scans and flags unversioned openings", () => {
    const result = summarizeHistoricalEvidence(scope, {
      ...empty,
      ambiguous_restoration: 2,
      mutable_ledger_opening: 18,
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "HISTORICAL_COVERAGE_SCAN_RESTORATION",
        records: 2,
      })
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "HISTORICAL_COVERAGE_LEDGER_OPENING_UNVERSIONED",
        records: 18,
      })
    );
  });

  it("fails on unsafe counts instead of returning a misleading evidence result", () => {
    expect(() =>
      summarizeHistoricalEvidence(scope, {
        ...empty,
        legacy_raw: "-1",
      })
    ).toThrow("HISTORICAL_COVERAGE_COUNT_INVALID");
  });
});
