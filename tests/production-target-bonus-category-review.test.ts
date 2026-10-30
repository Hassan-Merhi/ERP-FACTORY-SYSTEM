import { describe, expect, it } from "vitest";
import type { CategoryBonusWorkerProposal } from "../shared/productionTargetBonusCategoryCalculation";
import {
  categoryReviewSnapshotPayload, categoryReviewSnapshotToken,
} from "../server/services/factory/categoryBonusReviewSnapshot";

function worker(): CategoryBonusWorkerProposal {
  return {
    date: "2026-10-30", workerId: 17, workerName: "Worker A",
    targetBales: "7.00", creditedBales: 11, extraBales: "4.00",
    proposedBonusUsd: "3.25", blocked: false, reasons: [],
    legacyReviewStatus: null,
    lines: [
      { categoryKey: "toys", categoryLabel: "Toys", creditedBales: 5,
        targetBales: "3.00", extraBales: "2.00", enabled: true,
        rateVersionId: 4, rateEffectiveFrom: "2026-10-01",
        ratePerExtraBaleUsd: "0.5000", unroundedBonusUsd: "1.000000", issue: null },
      { categoryKey: "bags", categoryLabel: "Bags", creditedBales: 6,
        targetBales: "4.00", extraBales: "2.00", enabled: true,
        rateVersionId: 5, rateEffectiveFrom: "2026-10-05",
        ratePerExtraBaleUsd: "1.1250", unroundedBonusUsd: "2.250000", issue: null },
    ],
  };
}
const hash=(entry: CategoryBonusWorkerProposal)=>categoryReviewSnapshotToken(
  categoryReviewSnapshotPayload("production-target-category-v1",entry),
);

describe("Phase 11 immutable category review snapshots",()=>{
  it("freezes category credits, targets, rate versions and the total exactly",()=>{
    const entry=worker();
    const snapshot=categoryReviewSnapshotPayload("production-target-category-v1",entry);
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.date).toBe("2026-10-30");
    expect(snapshot.bonusUsd).toBe("3.25");
    expect(snapshot.categoryLines).toHaveLength(2);
    expect(snapshot.categoryLines.map(row=>row.categoryKey)).toEqual(["bags","toys"]);
    expect(snapshot.categoryLines[0].rateVersionId).toBe(5);
    expect(snapshot.categoryLines[0].unroundedBonusUsd).toBe("2.250000");
    expect(hash(entry)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("produces the same token regardless of UI line ordering",()=>{
    const a=worker(),b=worker();
    b.lines.reverse();
    expect(hash(a)).toBe(hash(b));
  });
  it("invalidates confirmation when a future/historical rate or source changes",()=>{
    const original=worker(),current=hash(original);
    const changedRate=worker();
    changedRate.lines[0].rateVersionId=8;
    expect(hash(changedRate)).not.toBe(current);
    const changedTarget=worker();
    changedTarget.lines[1].targetBales="3.00";
    expect(hash(changedTarget)).not.toBe(current);
    const changedCredit=worker();
    changedCredit.creditedBales=12;
    expect(hash(changedCredit)).not.toBe(current);
    const changedMoney=worker();
    changedMoney.proposedBonusUsd="3.26";
    expect(hash(changedMoney)).not.toBe(current);
    const changedWorker=worker();
    changedWorker.workerId=21;
    expect(hash(changedWorker)).not.toBe(current);
    const changedDate=worker();
    changedDate.date="2026-10-31";
    expect(hash(changedDate)).not.toBe(current);
  });
  it("does not contain any payment account, voucher or posting state",()=>{
    const json=JSON.stringify(categoryReviewSnapshotPayload("production-target-category-v1",worker()));
    expect(json).not.toContain("cashAccountId");
    expect(json).not.toContain("voucherId");
    expect(json).not.toContain("paymentDate");
  });
});
