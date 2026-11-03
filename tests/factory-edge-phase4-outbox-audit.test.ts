import { describe, expect, it } from "vitest";
import { evaluateVoucherOutboxAudit } from "../scripts/edge/audit-voucher-outbox.mjs";

describe("LAN outbox reconciliation evidence", () => {
  it("reports only local and cloud-STAGED evidence, never cloud postings", () => {
    expect(
      evaluateVoucherOutboxAudit({
        total: "5",
        staged: "3",
        pending: "2",
        lastSequence: "5",
        invalidReceipts: "0",
        gaps: "0",
      })
    ).toEqual({
      localVouchers: 5,
      stagedEvidence: 3,
      pendingEvidence: 2,
      cloudVouchersApplied: "not-verified",
    });
  });
  it("rejects missing records and inconsistent receipt counts", () => {
    for (const changed of [
      { lastSequence: "7" },
      { gaps: "1" },
      { invalidReceipts: "1" },
      { staged: "4" },
      { pending: "-1" },
    ]) {
      expect(() =>
        evaluateVoucherOutboxAudit({
          total: "5",
          staged: "3",
          pending: "2",
          lastSequence: "5",
          invalidReceipts: "0",
          gaps: "0",
          ...changed,
        })
      ).toThrow("EDGE_SYNC_OUTBOX_AUDIT_MISMATCH");
    }
  });
});
