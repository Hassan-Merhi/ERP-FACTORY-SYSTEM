import { describe, expect, it } from "vitest";
import { evenSplitBales, resolveUnlinkBaleAllocations } from "../shared/factoryProductionTargetSplit";

describe("unlinking shared factory production targets", () => {
  it("splits even targets without duplicating any bale", () => {
    expect([...resolveUnlinkBaleAllocations(14, [20, 10])]).toEqual([
      [10, 7],
      [20, 7],
    ]);
  });

  it("distributes odd leftovers in stable worker order", () => {
    expect(evenSplitBales(13, [20, 10])).toEqual([
      { workerId: 10, targetBales: 7 },
      { workerId: 20, targetBales: 6 },
    ]);
    expect(evenSplitBales(16, [3, 1, 2])).toEqual([
      { workerId: 1, targetBales: 6 },
      { workerId: 2, targetBales: 5 },
      { workerId: 3, targetBales: 5 },
    ]);
  });

  it("accepts a custom allocation if and only if the sum equals the group target", () => {
    expect([
      ...resolveUnlinkBaleAllocations(
        13,
        [10, 20],
        [
          { workerId: 10, targetBales: 5 },
          { workerId: 20, targetBales: 8 },
        ]
      ),
    ]).toEqual([
      [10, 5],
      [20, 8],
    ]);

    expect(() =>
      resolveUnlinkBaleAllocations(
        13,
        [10, 20],
        [
          { workerId: 10, targetBales: 7 },
          { workerId: 20, targetBales: 8 },
        ]
      )
    ).toThrow("must add up to 13");
    expect(() =>
      resolveUnlinkBaleAllocations(
        13,
        [10, 20],
        [
          { workerId: 10, targetBales: 7 },
          { workerId: 10, targetBales: 6 },
        ]
      )
    ).toThrow("unique workers");
    expect(() => resolveUnlinkBaleAllocations(13, [10, 20], [{ workerId: 10, targetBales: 13 }])).toThrow(
      "one allocation"
    );
    expect(() =>
      resolveUnlinkBaleAllocations(
        13,
        [10, 20],
        [
          { workerId: 10, targetBales: -1 },
          { workerId: 20, targetBales: 14 },
        ]
      )
    ).toThrow("non-negative");
  });

  it("keeps missing targets missing and handles zero targets", () => {
    expect([...resolveUnlinkBaleAllocations(null, [1, 2])]).toEqual([
      [1, null],
      [2, null],
    ]);
    expect([...resolveUnlinkBaleAllocations(0, [1, 2])]).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(() =>
      resolveUnlinkBaleAllocations(
        null,
        [1, 2],
        [
          { workerId: 1, targetBales: 0 },
          { workerId: 2, targetBales: 0 },
        ]
      )
    ).toThrow("blank fixed target");
  });
});
