import { describe, expect, it } from "vitest";
import { calculateWeeklyFlatBonus } from "@shared/productionTargetBonusWeeklyCalculation";
import { weeklyBonusReviewSnapshot, weeklyBonusReviewToken } from "./weeklyBonusReviewSnapshot";

function proposal(extra = 1, amount = "15.00") {
  return calculateWeeklyFlatBonus({
    weekStart: "2026-10-26", todayBeirut: "2026-11-02",
    method: "weekly_flat", methodVersionId: 7, flatBonusUsd: amount,
    days: [{
      date: "2026-10-26", finalized: true, captured: true, verified: true,
      issues: [], sourceBales: 56 + extra, creditedBales: 56 + extra,
      workers: [{
        workerId: 42, workerName: "Test Worker", status: "Present",
        targetBales: 56, creditedBales: 56 + extra,
        categories: [{
          categoryKey: "bags", categoryLabel: "Bags", creditedBales: 56 + extra,
        }],
      }],
    }], unfinalizedDates: [],
  });
}
function fingerprint(companyId = 11, extras = 1, rate = "15.00") {
  const p = proposal(extras, rate);
  const payload = weeklyBonusReviewSnapshot(companyId, p, p.workers[0]);
  return { payload, token: weeklyBonusReviewToken(payload) };
}
describe("Phase 14 immutable weekly review fingerprint", () => {
  it("locks the exact week, worker, method version, source, target and amount", () => {
    const { payload, token } = fingerprint();
    expect(payload).toMatchObject({
      companyId: 11, weekStart: "2026-10-26", weekEnd: "2026-11-01",
      method: "weekly_flat", methodVersionId: 7, targetBales: "56.00",
      creditedBales: 57, extraBales: "1.00", amount: "15.00",
      currency: "USD", workerId: 42,
    });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint().token).toBe(token);
  });

  it("rejects changed company, credited bales or flat fee by changing the fingerprint", () => {
    const first = fingerprint().token;
    expect(fingerprint(12).token).not.toBe(first);
    expect(fingerprint(11, 34).token).not.toBe(first);
    expect(fingerprint(11, 1, "20.00").token).not.toBe(first);
  });

  it("captures category changes, daily source dates and method version", () => {
    const p = proposal();
    const original = weeklyBonusReviewSnapshot(11, p, p.workers[0]);
    const hash = weeklyBonusReviewToken(original);
    const moved = { ...original, categories: [
      { categoryKey: "shoes", categoryLabel: "Shoes", creditedBales: 57 },
    ] };
    expect(weeklyBonusReviewToken(moved)).not.toBe(hash);
    const editedVersion = { ...original, methodVersionId: 8 };
    expect(weeklyBonusReviewToken(editedVersion)).not.toBe(hash);
    const movedDate = { ...original, days: original.days.map(d => ({ ...d, date: "2026-10-27" })) };
    expect(weeklyBonusReviewToken(movedDate)).not.toBe(hash);
    expect(weeklyBonusReviewToken({
      ...original, days: original.days.map(d => ({ ...d, targetBales: "55.00" })),
    })).not.toBe(hash);
  });

  it("sorts canonical frozen category and day lines deterministically", () => {
    const p = proposal();
    const source = p.workers[0];
    source.categories = [
      { categoryKey: "shoes", categoryLabel: "Shoes", creditedBales: 10 },
      { categoryKey: "bags", categoryLabel: "Bags", creditedBales: 47 },
    ];
    const original = weeklyBonusReviewSnapshot(11, p, source);
    source.categories = [...source.categories].reverse();
    expect(weeklyBonusReviewSnapshot(11, p, source)).toEqual(original);
  });
});
