import { describe, expect, it } from "vitest";
import { calculateProductionBonusPreview } from "../server/services/factory/productionBonusPreview";

const members = [
  { workerId: 30, workerName: "Worker C" },
  { workerId: 10, workerName: "Worker A" },
  { workerId: 20, workerName: "Worker B" },
];

describe("factory production bonus preview", () => {
  it("does not create a bonus at or below target", () => {
    expect(
      calculateProductionBonusPreview({
        targetBales: 144,
        actualBales: 144,
        bonusPerExtraBale: 1,
        bonusEnabled: true,
        members,
      })
    ).toMatchObject({ extraBales: 0, bonusPool: 0, distributable: true });

    expect(
      calculateProductionBonusPreview({
        targetBales: 144,
        actualBales: 120,
        bonusPerExtraBale: 1,
        bonusEnabled: true,
        members,
      })
    ).toMatchObject({ extraBales: 0, bonusPool: 0 });
  });

  it("calculates the extra-bale pool and divides it across the team", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 144,
      actualBales: 160,
      bonusPerExtraBale: 1,
      bonusEnabled: true,
      members: [
        { workerId: 1, workerName: "A" },
        { workerId: 2, workerName: "B" },
        { workerId: 3, workerName: "C" },
        { workerId: 4, workerName: "D" },
      ],
    });

    expect(result.extraBales).toBe(16);
    expect(result.bonusPool).toBe(16);
    expect(result.allocations.map((row) => row.amount)).toEqual([4, 4, 4, 4]);
  });

  it("uses deterministic cents and preserves the exact pool", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 110,
      bonusPerExtraBale: 1,
      bonusEnabled: true,
      members,
    });

    expect(result.bonusPool).toBe(10);
    expect(result.allocations).toEqual([
      { workerId: 10, workerName: "Worker A", amount: 3.33 },
      { workerId: 20, workerName: "Worker B", amount: 3.33 },
      { workerId: 30, workerName: "Worker C", amount: 3.34 },
    ]);
    expect(Number(result.allocations.reduce((sum, row) => sum + row.amount, 0).toFixed(2))).toBe(10);
    expect(result.perWorkerMin).toBe(3.33);
    expect(result.perWorkerMax).toBe(3.34);
  });

  it("rounds fractional per-bale rates once before splitting the pool", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 107,
      bonusPerExtraBale: 0.335,
      bonusEnabled: true,
      members: [
        { workerId: 1, workerName: "A" },
        { workerId: 2, workerName: "B" },
      ],
    });

    expect(result.extraBales).toBe(7);
    expect(result.bonusPool).toBe(2.35);
    expect(result.allocations).toEqual([
      { workerId: 1, workerName: "A", amount: 1.17 },
      { workerId: 2, workerName: "B", amount: 1.18 },
    ]);
    expect(Number(result.allocations.reduce((sum, row) => sum + row.amount, 0).toFixed(2))).toBe(2.35);
  });

  it("deduplicates repeated worker memberships before splitting the pool", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 103,
      bonusPerExtraBale: 1,
      bonusEnabled: true,
      members: [
        { workerId: 1, workerName: "A" },
        { workerId: 1, workerName: "A duplicate" },
        { workerId: 2, workerName: "B" },
      ],
    });

    expect(result.bonusPool).toBe(3);
    expect(result.allocations).toEqual([
      { workerId: 1, workerName: "A", amount: 1.5 },
      { workerId: 2, workerName: "B", amount: 1.5 },
    ]);
    expect(Number(result.allocations.reduce((sum, row) => sum + row.amount, 0).toFixed(2))).toBe(3);
  });

  it("treats linked workers as one bonus unit and splits their unit share 50/50", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 112,
      bonusPerExtraBale: 1,
      bonusEnabled: true,
      members: [
        { workerId: 1, workerName: "A" },
        { workerId: 2, workerName: "B" },
        { workerId: 3, workerName: "C" },
      ],
      linkedWorkerGroups: [[1, 2]],
    });

    expect(result.bonusPool).toBe(12);
    expect(result.allocations).toEqual([
      { workerId: 1, workerName: "A", amount: 3 },
      { workerId: 2, workerName: "B", amount: 3 },
      { workerId: 3, workerName: "C", amount: 6 },
    ]);
    expect(Number(result.allocations.reduce((sum, row) => sum + row.amount, 0).toFixed(2))).toBe(12);
  });

  it("keeps the pool at zero when bonuses are disabled or target is zero", () => {
    const disabled = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 150,
      bonusPerExtraBale: 2,
      bonusEnabled: false,
      members,
    });
    expect(disabled).toMatchObject({ extraBales: 50, bonusPool: 0, distributable: true });

    const noTarget = calculateProductionBonusPreview({
      targetBales: 0,
      actualBales: 150,
      bonusPerExtraBale: 2,
      bonusEnabled: true,
      members,
    });
    expect(noTarget).toMatchObject({ extraBales: 0, bonusPool: 0, distributable: true });
  });

  it("marks a positive pool with no valid members as non-distributable", () => {
    const result = calculateProductionBonusPreview({
      targetBales: 100,
      actualBales: 105,
      bonusPerExtraBale: 1,
      bonusEnabled: true,
      members: [
        { workerId: 0, workerName: "Invalid" },
        { workerId: -1, workerName: "Invalid 2" },
      ],
    });

    expect(result.extraBales).toBe(5);
    expect(result.bonusPool).toBe(5);
    expect(result.allocations).toEqual([]);
    expect(result.distributable).toBe(false);
  });
});
