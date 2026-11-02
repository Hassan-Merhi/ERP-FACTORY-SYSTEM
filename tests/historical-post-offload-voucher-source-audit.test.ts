import { describe, expect, it } from "vitest";
import {
  inspectHistoricalPostOffloadLink,
  type HistoricalPostOffloadLink,
} from "../scripts/historical-post-offload-voucher-source-audit";

const linked: HistoricalPostOffloadLink = {
  voucherId: 8910,
  voucherNumber: "FACTORY-POC-86-43-1781008503936",
  voucherContainerId: 86,
  parsedSourceChargeId: 43,
  voucherNativeAmount: "1210.00",
  voucherCurrency: "USD",
  sourceChargeId: 43,
  sourceVoucherId: 8910,
  sourceContainerId: 86,
  sourceNativeAmount: "1210.00",
  sourceCurrency: "USD",
  sourceDeletedAt: null,
  sourceInventoryValueDeltaUsd: null,
};
describe("Historical POC source lineage is evidence only", () => {
  it("matches source charge ID, original voucher and native amount", () => {
    const result = inspectHistoricalPostOffloadLink(linked);
    expect(result.status).toBe("SOURCE_IDENTITY_MATCHED");
    expect(result.flags).toEqual([]);
    expect(result.proposedGLCorrection).toBeNull();
  });
  it("flags the real source charge 64 link mismatch without claiming duplicate expense", () => {
    const result = inspectHistoricalPostOffloadLink({
      ...linked,
      voucherId: 9309,
      voucherNumber: "FACTORY-POC-83-64-1781674089261",
      voucherContainerId: 83,
      parsedSourceChargeId: 64,
      voucherNativeAmount: "1692.96",
      sourceChargeId: 64,
      sourceVoucherId: 9341,
      sourceContainerId: 83,
      sourceNativeAmount: "1692.00",
    });
    expect(result.flags).toContain("SOURCE_POINTS_TO_DIFFERENT_OR_MISSING_VOUCHER");
    expect(result.flags).toContain("VOUCHER_SOURCE_NATIVE_AMOUNT_MISMATCH");
    expect(result.isDuplicateProven).toBe(false);
    expect(result.isExpenseOverstatementProven).toBe(false);
    expect(result.proposedSourceMutation).toBeNull();
  });
  it("does not interpret inventory cost updates as posted GL assets", () => {
    const result = inspectHistoricalPostOffloadLink({
      ...linked,
      sourceInventoryValueDeltaUsd: "240.50",
    });
    expect(result.recordedInventoryDeltaUsd).toBe("240.50");
    expect(result.proposedGLCorrection).toBeNull();
  });
  it("refuses mismatched container, retired source or currency", () => {
    const result = inspectHistoricalPostOffloadLink({
      ...linked, sourceContainerId: 100,
      sourceCurrency: "EUR", sourceDeletedAt: "2026-10-02",
    });
    expect(result.flags).toContain("SOURCE_IDENTITY_MISMATCH");
    expect(result.flags).toContain("VOUCHER_SOURCE_CURRENCY_MISMATCH");
    expect(result.flags).toContain("SOURCE_CHARGE_RETIRED");
  });
  it("marks absent source records without synthesizing them", () => {
    const result = inspectHistoricalPostOffloadLink({
      ...linked, sourceChargeId: null, sourceNativeAmount: null,
    });
    expect(result.flags).toContain("SOURCE_CHARGE_RECORD_MISSING");
    expect(result.proposedSourceMutation).toBeNull();
  });
});
