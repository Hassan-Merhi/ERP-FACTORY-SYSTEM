import { describe, expect, it } from "vitest";
import { getNetProfitFuturePnlPolicy } from "../server/routes/stats/netProfitFuturePnlPolicy";

describe("Current net-profit reports exclude future P&L but never change supplier balances", () => {
  it("uses the user's report business date only for future P&L exclusion", () => {
    const p = getNetProfitFuturePnlPolicy(12, null, "2026-11-02");
    expect(p.params).toEqual([12, "2026-11-02"]);
    expect(p.ledgerDateFilter).toBe("");
    expect(p.futurePnlFilter).toBe("AND COALESCE(v.effective_date, v.voucher_date) > $2");
    expect(p.appliedLivePnlCutoff).toBe("2026-11-02");
  });
  it("leaves explicit historical report date semantics unchanged", () => {
    const p = getNetProfitFuturePnlPolicy(12, "2026-10-31", "2026-11-02");
    expect(p.params).toEqual([12, "2026-10-31"]);
    expect(p.ledgerDateFilter).toBe("AND COALESCE(v.effective_date, v.voucher_date) <= $2");
    expect(p.futurePnlFilter).toBe("AND FALSE");
    expect(p.appliedLivePnlCutoff).toBeNull();
  });
  it("preserves legacy two-argument report data loader callers", () => {
    const p = getNetProfitFuturePnlPolicy(8, null, undefined);
    expect(p.params).toEqual([8]);
    expect(p.ledgerDateFilter).toBe("");
    expect(p.futurePnlFilter).toBe("AND FALSE");
  });
  it("rejects malformed dates instead of guessing the reporting cutoff", () => {
    expect(() => getNetProfitFuturePnlPolicy(12, null, "tomorrow")).toThrow();
  });
});
