import { describe, expect, it, vi } from "vitest";
import { dismissIntercompanyRequestsInBatches } from "../client/src/lib/bulkDismissIntercompanyRequests";

describe("bulk intercompany dismissal", () => {
  it("skips duplicate ids and does not make calls for an empty list", async () => {
    const dismiss = vi.fn(async (_id: number) => undefined);
    expect(await dismissIntercompanyRequestsInBatches([], dismiss)).toEqual({ dismissed: 0, failed: 0 });
    expect(await dismissIntercompanyRequestsInBatches([1, 1, 2, 0, -1, NaN], dismiss))
      .toEqual({ dismissed: 2, failed: 0 });
    expect(dismiss.mock.calls).toEqual([[1], [2]]);
  });

  it("continues after an API rejection and reports partial results", async () => {
    const dismiss = vi.fn(async (id: number) => {
      if (id === 3) throw new Error("Already approved by another recipient");
    });
    expect(await dismissIntercompanyRequestsInBatches([1, 2, 3, 4, 5], dismiss))
      .toEqual({ dismissed: 4, failed: 1 });
    expect(dismiss.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("limits concurrent dismissal calls to four", async () => {
    let running = 0;
    let maxRunning = 0;
    const dismiss = vi.fn(async (_id: number) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running -= 1;
    });
    expect(await dismissIntercompanyRequestsInBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], dismiss))
      .toEqual({ dismissed: 9, failed: 0 });
    expect(maxRunning).toBe(4);
  });
});
