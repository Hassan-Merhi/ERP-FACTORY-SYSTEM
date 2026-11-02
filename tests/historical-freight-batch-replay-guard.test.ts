import { describe, expect, it } from "vitest";
import {
  assertHistoricalFreightBatchNotReapplied,
  assessPostOffloadDuplicateSource,
  type PostOffloadDuplicateSourceReview,
} from "../scripts/historical-freight-batch-replay-guard";

const original: PostOffloadDuplicateSourceReview = {
  companyId: 12,
  containerId: 83,
  chargeId: 64,
  activeVoucherCount: 2,
  activeVouchers: [
    {
      voucherId: 9309,
      voucherNumber: "FACTORY-POC-83-64-1781674089261",
      voucherDate: "2026-06-17",
      amountNative: "1692.96",
    },
    {
      voucherId: 9341,
      voucherNumber: "FACTORY-POC-BACKFILL-83-64",
      voucherDate: "2026-06-17",
      amountNative: "1692.00",
    },
  ],
  priorCorrection: {
    voucherId: 15976,
    voucherNumber: "FACTORY-CORRECTION-20261014-83",
    amountNative: "1692.96",
    deletedAt: "2026-10-19 12:37:16.345",
  },
};

describe("One-time factory freight correction replay safety", () => {
  it("allows the legacy snapshot's inspection path", () => {
    expect(() => assertHistoricalFreightBatchNotReapplied(false)).not.toThrow();
  });
  it("always blocks running the old 4-journal batch again", () => {
    expect(() => assertHistoricalFreightBatchNotReapplied(true))
      .toThrow(/HISTORICAL_FREIGHT_BATCH_REPLAY_DISABLED/);
  });
  it("finds multiple active vouchers despite only one stored voucher_id", () => {
    const result = assessPostOffloadDuplicateSource(original);
    expect(result.reviewFlags).toContain("MULTIPLE_ACTIVE_POC_VOUCHERS_FOR_ONE_CHARGE");
    expect(result.reviewFlags).toContain("HISTORICAL_CORRECTION_WAS_RETIRED");
    expect(result.verifiedDuplicateSourceIdentity).toBe(true);
    expect(result.safeToReplayLegacyBatch).toBe(false);
    expect(result.approvedForPosting).toBe(false);
    expect(result.candidateCorrectionUsd).toBeNull();
    expect(result.proposedJournal).toBeNull();
    expect(result.changesToSupplierAccounts).toBeNull();
  });
  it("never infers a correction from a duplicated source that has no reviewed offset", () => {
    const result = assessPostOffloadDuplicateSource({
      ...original, priorCorrection: null,
    });
    expect(result.reviewFlags).not.toContain("HISTORICAL_CORRECTION_WAS_RETIRED");
    expect(result.approvedForPosting).toBe(false);
    expect(result.proposedJournal).toBeNull();
  });
  it("flags differing business periods and broken source counts", () => {
    const result = assessPostOffloadDuplicateSource({
      ...original,
      activeVoucherCount: 3,
      activeVouchers: [
        original.activeVouchers[0],
        { ...original.activeVouchers[1], voucherDate: "2026-07-01" },
      ],
    });
    expect(result.reviewFlags).toContain("SOURCE_DOCUMENT_PERIODS_DIFFER");
    expect(result.reviewFlags).toContain("VOUCHER_ROW_COUNT_MISMATCH");
  });
});
