import { describe, expect, it } from "vitest";
import {
  calculateWeeklyFlatBonus, type WeeklyFlatBonusInput, type WeeklyFlatDayEvidence,
} from "./productionTargetBonusWeeklyCalculation";

function day(
  date: string, firstCount: number, category: "Bags" | "Shoes",
  secondStatus: "Present" | "Absent" = "Absent",
): WeeklyFlatDayEvidence {
  const secondCount = secondStatus === "Present" ? 28 : 0;
  return {
    date, finalized: true, captured: true, verified: true, issues: [],
    sourceBales: firstCount + secondCount,
    creditedBales: firstCount + secondCount,
    workers: [
      { workerId: 10, workerName: "Worker A", status: "Present",
        targetBales: 28, creditedBales: firstCount,
        categories: [{ categoryKey: category.toLowerCase(), categoryLabel: category, creditedBales: firstCount }] },
      { workerId: 11, workerName: "Worker B", status: secondStatus,
        targetBales: 28, creditedBales: secondCount,
        categories: secondCount
          ? [{ categoryKey: "bags", categoryLabel: "Bags", creditedBales: secondCount }]
          : [] },
    ],
  };
}
function fixture(secondDayCount = 29): WeeklyFlatBonusInput {
  return {
    weekStart: "2026-10-26", todayBeirut: "2026-11-02",
    method: "weekly_flat", methodVersionId: 14, flatBonusUsd: "15.00",
    // Monday represents frozen split of a linked group of 56 physical bales:
    // 28 credited to each. Tuesday they have unlinked; A moves to Shoes.
    days: [day("2026-10-26", 28, "Bags", "Present"),
      day("2026-10-27", secondDayCount, "Shoes")],
    unfinalizedDates: [],
  };
}
describe("Phase 13 weekly flat eligibility (read-only)", () => {
  it("pays one flat proposal per worker/week after historically linked + unlinked days and a category switch", () => {
    const calculated = calculateWeeklyFlatBonus(fixture());
    expect(calculated).toMatchObject({
      calculationVersion: "production-target-weekly-flat-v1",
      weekStart: "2026-10-26", weekEnd: "2026-11-01",
      proposalOnly: true, canApprove: false, canPost: false,
      totalCreditedBales: 85, totalProposedBonusUsd: "15.00",
    });
    const a = calculated.workers.find(worker => worker.workerId === 10)!;
    const b = calculated.workers.find(worker => worker.workerId === 11)!;
    expect(a).toMatchObject({
      workedDays: 2, absentDays: 0, targetBales: "56.00",
      creditedBales: 57, extraBales: "1.00", proposedBonusUsd: "15.00",
      exceedsTarget: true, eligible: true,
    });
    expect(a.categories.map(cat => [cat.categoryKey, cat.creditedBales])).toEqual([
      ["bags", 28], ["shoes", 29],
    ]);
    expect(b).toMatchObject({
      workedDays: 1, absentDays: 1, targetBales: "28.00",
      creditedBales: 28, proposedBonusUsd: "0.00", eligible: false,
    });
  });
  it("does not multiply the flat fee by extra bales or categories", () => {
    const oneExtra = calculateWeeklyFlatBonus(fixture(29)).workers[0];
    const thirtyFourExtra = calculateWeeklyFlatBonus(fixture(62)).workers[0];
    expect(oneExtra.proposedBonusUsd).toBe("15.00");
    expect(thirtyFourExtra.creditedBales).toBe(90);
    expect(thirtyFourExtra.proposedBonusUsd).toBe("15.00");
    expect(calculateWeeklyFlatBonus(fixture(28)).workers[0].proposedBonusUsd).toBe("0.00");
    expect(calculateWeeklyFlatBonus(fixture(27)).workers[0].proposedBonusUsd).toBe("0.00");
  });
  it("combines a same-day Bags/Toys switch with Shoes later in the week without adding a second fee", () => {
    const input = fixture();
    const monday = input.days[0];
    const workers = monday.workers.map(worker => worker.workerId === 10 ? {
      ...worker, categories: [
        { categoryKey: "bags", categoryLabel: "Bags", creditedBales: 14 },
        { categoryKey: "toys", categoryLabel: "Toys", creditedBales: 14 },
      ],
    } : worker);
    input.days[0] = { ...monday, workers };
    const proposal = calculateWeeklyFlatBonus(input);
    expect(proposal.workers[0].categories.map(cat => cat.categoryKey)).toEqual([
      "bags", "shoes", "toys",
    ]);
    expect(proposal.workers[0].creditedBales).toBe(57);
    expect(proposal.totalProposedBonusUsd).toBe("15.00");
  });
  it("excludes Sunday physical bales, target and missing capture from flat weekly eligibility", () => {
    const input = fixture(29);
    const sunday = {
      ...day("2026-11-01", 100, "Bags"),
      finalized: false, captured: false, verified: false,
    };
    input.days.push(sunday);
    input.unfinalizedDates.push("2026-11-01");
    const actual = calculateWeeklyFlatBonus(input);
    expect(actual.globalIssues).not.toContain("UNFINALIZED_DAY");
    expect(actual.globalIssues).not.toContain("MISSING_FROZEN_EVIDENCE");
    expect(actual.totalCreditedBales).toBe(85);
    expect(actual.workers.find(worker => worker.workerId === 10)?.targetBales).toBe("56.00");
    expect(actual.workers.find(worker => worker.workerId === 10)?.creditedBales).toBe(57);
    expect(actual.totalProposedBonusUsd).toBe("15.00");
  });
  it("blocks the current week, unset method, unfinalized days and missing frozen evidence", () => {
    const pending = calculateWeeklyFlatBonus({ ...fixture(), todayBeirut: "2026-10-30" });
    expect(pending.workers[0].eligible).toBe(false);
    expect(pending.globalIssues).toContain("WEEK_NOT_FINISHED");
    const unset = calculateWeeklyFlatBonus({ ...fixture(), method: "per_extra_bale", methodVersionId: null });
    expect(unset.totalProposedBonusUsd).toBe("0.00");
    expect(unset.globalIssues).toContain("NO_FLAT_BONUS_METHOD");
    const unfinalized = calculateWeeklyFlatBonus({ ...fixture(), unfinalizedDates: ["2026-10-28"] });
    expect(unfinalized.globalIssues).toContain("UNFINALIZED_DAY");
    const missing = fixture();
    missing.days[0] = { ...missing.days[0], captured: false, verified: false };
    expect(calculateWeeklyFlatBonus(missing).globalIssues).toContain("MISSING_FROZEN_EVIDENCE");
  });
  it("blocks incorrect credits, invalid daily targets and absent workers with production", () => {
    const invalid = fixture();
    invalid.days[1] = { ...invalid.days[1], workers: invalid.days[1].workers.map(worker =>
      worker.workerId === 10 ? { ...worker, targetBales: null } : worker) };
    expect(calculateWeeklyFlatBonus(invalid).workers[0].reasons).toContain("NO_DAILY_TARGET");
    const credit = fixture();
    credit.days[0] = { ...credit.days[0], sourceBales: 999 };
    expect(calculateWeeklyFlatBonus(credit).globalIssues).toContain("AMBIGUOUS_FROZEN_EVIDENCE");
    const absent = fixture();
    absent.days[1] = { ...absent.days[1], workers: absent.days[1].workers.map(worker =>
      worker.workerId === 10 ? { ...worker, status: "Absent" as const } : worker) };
    expect(calculateWeeklyFlatBonus(absent).workers[0].reasons).toContain("ABSENT_WITH_PRODUCTION");
  });
  it("blocks existing daily reviews or previously claimed payroll bonuses instead of double-paying", () => {
    const alreadyReviewed = calculateWeeklyFlatBonus({
      ...fixture(), previouslyReviewedWorkerDays: new Set(["2026-10-27:10"]),
    });
    expect(alreadyReviewed.workers[0].reasons).toContain("EXISTING_DAILY_BONUS_REVIEW");
    expect(alreadyReviewed.totalProposedBonusUsd).toBe("0.00");
    const paid = calculateWeeklyFlatBonus({
      ...fixture(), payrollClaimedWorkerDays: new Set(["2026-10-26:10"]),
    });
    expect(paid.workers[0].reasons).toContain("EXISTING_PAYROLL_BONUS_CLAIM");
    expect(paid.workers[0].eligible).toBe(false);
  });
  it("blocks a physical bale captured twice in one week", () => {
    const proposal = calculateWeeklyFlatBonus({ ...fixture(), repeatedBaleInWeek: true });
    expect(proposal.globalIssues).toContain("DUPLICATE_SOURCE_BALE");
    expect(proposal.totalProposedBonusUsd).toBe("0.00");
    expect(proposal.workers.every(worker => !worker.eligible)).toBe(true);
  });
  it("rejects duplicated source dates or a non-Monday week start", () => {
    expect(() => calculateWeeklyFlatBonus({ ...fixture(), weekStart: "2026-10-27" })).toThrow();
    const original = fixture();
    expect(() => calculateWeeklyFlatBonus({ ...original, days: [original.days[0], original.days[0]] })).toThrow();
  });
});
