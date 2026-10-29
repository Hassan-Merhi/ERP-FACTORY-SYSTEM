import { describe, expect, it } from "vitest";
import {
  bonusMoneyToCents, bonusCentsToMoney, buildProductionTargetBonusReport,
  type ProductionTargetBonusHistoryRow,
} from "../shared/productionTargetBonusReporting";

const row = (overrides: Partial<ProductionTargetBonusHistoryRow> = {}): ProductionTargetBonusHistoryRow => ({
  id: 1, workerId: 10, workerNameSnapshot: "Worker A", workerCodeSnapshot: "W10",
  productionDate: "2026-10-29", currency: "USD", targetBales: 7,
  creditedBales: 10, excessBales: 3, bonusPerExtraBale: "0.1250",
  amount: "0.38", status: "PENDING", approvedAt: null, postedAt: null,
  paymentVoucherId: null, paymentVoucherNumber: null,
  paymentAccountNameSnapshot: null, productionSnapshotId: "date:2026-10-29:worker:10",
  ...overrides,
});
const report = (rows: ProductionTargetBonusHistoryRow[]) =>
  buildProductionTargetBonusReport("2026-10-01", "2026-10-31", rows, "2026-10-30T00:00:00.000Z");

describe("phase 7 production target bonus reports", () => {
  it("uses exact cents instead of floating additions", () => {
    expect(bonusMoneyToCents("0.10")).toBe(10);
    expect(bonusMoneyToCents("0.20")).toBe(20);
    expect(bonusCentsToMoney(bonusMoneyToCents("0.10") + bonusMoneyToCents("0.20"))).toBe("0.30");
    expect(() => bonusMoneyToCents("0.001")).toThrow("Invalid bonus amount");
    expect(() => bonusMoneyToCents("NaN")).toThrow();
    expect(() => bonusMoneyToCents("-1.00")).toThrow();
  });

  it("distinguishes proposals, approved unpaid, posted paid, rejection and voiding", () => {
    const r = report([
      row({ id: 1, amount: "0.10" }),
      row({ id: 2, status: "APPROVED", amount: "0.20", approvedAt: "2026-10-29T09:00:00Z" }),
      row({ id: 3, status: "POSTED", amount: "0.30", paymentVoucherId: 90,
        paymentVoucherNumber: "DEP-00090", paymentAccountNameSnapshot: "Main Cash",
        postedAt: "2026-10-30T12:00:00Z" }),
      row({ id: 4, status: "REJECTED", amount: "0.40" }),
      row({ id: 5, status: "VOIDED", amount: "0.50" }),
      row({ id: 6, status: "DRAFT", amount: "0.60" }),
    ]);
    expect(r.currencies).toEqual([{
      currency: "USD", pendingProposed: "0.10", approvedUnpaid: "0.20",
      paid: "0.30", accepted: "0.50", rejected: "0.40", draft: "0.60",
      totalRows: 6, paidCount: 1, approvedCount: 1, pendingCount: 1,
    }]);
    expect(r.workers[0].accepted).toBe("0.50");
  });

  it("never combines distinct company currencies", () => {
    const r = report([row({ id: 1, amount: "10.00", currency: "USD", status: "APPROVED" }),
      row({ id: 2, amount: "2500.00", currency: "CDF", status: "APPROVED" })]);
    expect(r.currencies.map(v => [v.currency, v.approvedUnpaid])).toEqual([
      ["CDF", "2500.00"], ["USD", "10.00"],
    ]);
    expect(r.workers).toHaveLength(2);
  });

  it("requires voucher evidence before counting a payment and rejects duplicate awards", () => {
    expect(() => report([row({ status: "POSTED", postedAt: "2026-10-30T00:00:00Z" })])).toThrow("voucher");
    expect(() => report([row({ status: "APPROVED", paymentVoucherId: 11 })])).toThrow("Unposted");
    expect(() => report([row(), row({ amount: "99.00" })])).toThrow("Duplicate");
  });

  it("checks dates, worker snapshot, historical rate and range", () => {
    expect(() => report([row({ productionDate: "2026-11-01" })])).toThrow("outside");
    expect(() => report([row({ productionDate: "2026-02-30" })])).toThrow("outside");
    expect(() => report([row({ bonusPerExtraBale: "0.12345" })])).toThrow("rate");
    expect(() => report([row({ workerNameSnapshot: " " })])).toThrow("worker");
    expect(() => buildProductionTargetBonusReport("2026-10-31", "2026-10-01", [])).toThrow("period");
  });

  it("reports a linked team as one saved award per worker, never multiplying by team size", () => {
    const r = report([row({ id: 11, workerId: 11, workerNameSnapshot: "A", creditedBales: 7,
      targetBales: 7, excessBales: 0, amount: "0.00", status: "APPROVED" }),
      row({ id: 12, workerId: 12, workerNameSnapshot: "B", creditedBales: 7,
        targetBales: 7, excessBales: 0, amount: "0.00", status: "APPROVED" })]);
    expect(r.rows.reduce((sum, entry) => sum + entry.creditedBales, 0)).toBe(14);
    expect(r.currencies[0].accepted).toBe("0.00");
  });
});
