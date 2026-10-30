import { describe, expect, it } from "vitest";
import {
  calculateProductionTargetBonusDay,
  resolveProductionTargetBonusRate,
  summarizeProductionTargetBonusDays,
  type ProductionTargetBonusDayInput,
  type ProductionTargetBonusRate,
} from "../shared/factoryProductionTargetBonusCore";

const companyRate: ProductionTargetBonusRate = {
  id: 1, scope: "company", workerId: null,
  enabled: true, effectiveFrom: "2026-10-01", ratePerExtraBale: "0.5000",
};

const worker = (id: number, target: number | null, produced: number | null, status: "Present" | "Absent" | "New" = "Present") => ({
  workerId: id, workerName: "Worker " + id, employeeCode: "W" + id,
  category: "RAGS", targetBales: target, producedBales: produced, status,
});

function preview(
  date: string,
  workers: ProductionTargetBonusDayInput["workers"],
  links: ProductionTargetBonusDayInput["links"] = [],
  finalized = true,
  rates: ProductionTargetBonusRate[] = [companyRate],
) {
  return calculateProductionTargetBonusDay({ date, workers, links, finalized }, rates);
}

describe("Production Targets bonus core: worker-linked production", () => {
  it("splits linked production once and bonuses only each person's extra bales", () => {
    const result = preview("2026-10-29", [worker(1, 7, 20), worker(2, 7, 20)], [{ id: 50, workerIds: [1, 2] }]);
    expect(result.totalProducedBales).toBe(20);
    expect(result.extraBales).toBe(6);
    expect(result.proposedBonusUsd).toBe("3.00");
    expect(result.payoutReady).toBe(true);
    expect(result.workers.map((row) => [row.creditedBales, row.extraBales, row.bonusUsd]))
      .toEqual([[10, 3, "1.50"], [10, 3, "1.50"]]);
  });

  it("calculates linked workers against their own 10- and 12-bale targets", () => {
    const result = preview("2026-10-29", [
      worker(1, 10, 22),
      worker(2, 12, 22),
    ], [{ id: 50, workerIds: [1, 2] }]);
    expect(result.totalProducedBales).toBe(22);
    expect(result.workers.map((w) => [w.targetBales, w.creditedBales, w.extraBales, w.bonusUsd]))
      .toEqual([[10, 11, 1, "0.50"], [12, 11, 0, "0.00"]]);
    expect(result.proposedBonusUsd).toBe("0.50");
  });

  it("does not create a bonus for hitting but not exceeding a target", () => {
    const result = preview("2026-10-29", [worker(1, 7, 7), worker(2, 7, 6), worker(3, 0, 12)]);
    expect(result.proposedBonusUsd).toBe("0.00");
    expect(result.workers[2].issues).toContain("NO_TARGET");
  });

  it("allocates odd linked bale counts without creating fractional or extra bales", () => {
    const result = preview("2026-10-29", [worker(9, 7, 15), worker(4, 7, 15)], [{ id: 3, workerIds: [9, 4] }]);
    const ordered = [...result.workers].sort((a, b) => a.workerId - b.workerId);
    expect(ordered.map((w) => w.creditedBales)).toEqual([8, 7]);
    expect(result.totalProducedBales).toBe(15);
    expect(result.proposedBonusUsd).toBe("0.50");
    expect(result.warnings).toContain("ODD_LINKED_BALES");
    expect(ordered[0].requiresReview).toBe(true);
  });

  it("keeps absent workers from earning a linked team's production", () => {
    const result = preview("2026-10-29", [worker(1, 7, 14, "Absent"), worker(2, 7, 14)], [{ id: 3, workerIds: [1, 2] }]);
    const absent = result.workers.find((w) => w.workerId === 1)!;
    const present = result.workers.find((w) => w.workerId === 2)!;
    expect(absent.creditedBales).toBe(0);
    expect(absent.bonusUsd).toBe("0.00");
    expect(present.creditedBales).toBe(14);
    expect(present.bonusUsd).toBe("3.50");
  });

  it("blocks apparently finalized days that have no saved worker evidence", () => {
    const day = preview("2026-10-29", []);
    expect(day.finalized).toBe(true);
    expect(day.payoutReady).toBe(false);
    expect(day.warnings).toContain("EMPTY_FINALIZED_DAY");
  });

  it("does not make a finalized-looking cash bonus from an open day", () => {
    const result = preview("2026-10-29", [worker(1, 7, 18)], [], false);
    expect(result.finalized).toBe(false);
    expect(result.payoutReady).toBe(false);
    expect(result.proposedBonusUsd).toBe("0.00");
    expect(result.workers[0].issues).toContain("NOT_FINALIZED");
  });

  it("blocks malformed and inconsistent team evidence instead of guessing", () => {
    const mismatched = preview("2026-10-29", [worker(1, 7, 14), worker(2, 7, 15)], [{ id: 3, workerIds: [1, 2] }]);
    expect(mismatched.payoutReady).toBe(false);
    expect(mismatched.proposedBonusUsd).toBe("0.00");
    expect(mismatched.warnings).toContain("LINKED_OUTPUT_CONFLICT");

    const missing = preview("2026-10-29", [worker(1, 7, 14)], [{ id: 3, workerIds: [1, 2] }]);
    expect(missing.payoutReady).toBe(false);
    expect(missing.warnings).toContain("LINK_MEMBER_MISSING");

    const overlapping = preview("2026-10-29", [
      worker(1, 7, 14), worker(2, 7, 14), worker(3, 7, 14),
    ], [{ id: 3, workerIds: [1, 2] }, { id: 4, workerIds: [2, 3] }]);
    expect(overlapping.payoutReady).toBe(false);
    expect(overlapping.warnings).toContain("OVERLAPPING_LINKS");
  });

  it("retains each day's link and adds only day-level extra-bale bonuses", () => {
    const monday = preview("2026-10-26", [
      worker(1, 7, 14), worker(2, 7, 14), worker(3, 5, 8),
    ], [{ id: 9, workerIds: [1, 2] }]);
    const tuesday = preview("2026-10-27", [
      worker(1, 7, 20), worker(2, 7, 8), worker(3, 7, 20),
    ], [{ id: 10, workerIds: [1, 3] }]);
    const totals = summarizeProductionTargetBonusDays([monday, tuesday]);
    expect(totals.find((row) => row.workerId === 1)?.proposedBonusUsd).toBe("1.50");
    expect(totals.find((row) => row.workerId === 2)?.proposedBonusUsd).toBe("0.50");
    expect(totals.find((row) => row.workerId === 3)?.proposedBonusUsd).toBe("3.00");
    expect(monday.totalProducedBales + tuesday.totalProducedBales).toBe(50);
  });
});

describe("Production Targets bonus core: settings and money", () => {
  it("prefers an individual worker rate even when the company default changes later", () => {
    const workerRule: ProductionTargetBonusRate = {
      id: 2, scope: "worker", workerId: 1,
      enabled: true, effectiveFrom: "2026-10-15", ratePerExtraBale: "1.0000",
    };
    const newerCompanyRate = { ...companyRate, id: 3, effectiveFrom: "2026-10-20", ratePerExtraBale: "2.0000" };
    const rates = [companyRate, workerRule, newerCompanyRate];
    expect(resolveProductionTargetBonusRate(1, "2026-10-29", rates)?.id).toBe(2);
    expect(resolveProductionTargetBonusRate(2, "2026-10-29", rates)?.id).toBe(3);
    const day = preview("2026-10-29", [worker(1, 7, 10), worker(2, 7, 10)], [], true, rates);
    expect(day.proposedBonusUsd).toBe("9.00");
    expect(day.workers.map((w) => w.rateScope)).toEqual(["worker", "company"]);
  });

  it("handles disabled worker overrides and no configured rates", () => {
    const disabled: ProductionTargetBonusRate = {
      id: 4, scope: "worker", workerId: 1,
      enabled: false, effectiveFrom: "2026-10-02", ratePerExtraBale: "10.0000",
    };
    expect(preview("2026-10-29", [worker(1, 7, 10)], [], true, [companyRate, disabled]).proposedBonusUsd).toBe("0.00");
    expect(preview("2026-10-29", [worker(1, 7, 10)], [], true, []).proposedBonusUsd).toBe("0.00");
  });

  it("rounds currency to cents only after exact four-decimal per-bale multiplication", () => {
    const rate = { ...companyRate, ratePerExtraBale: "0.3333" };
    const day = preview("2026-10-29", [worker(1, 7, 10)], [], true, [rate]);
    expect(day.proposedBonusUsd).toBe("1.00");
  });
});
