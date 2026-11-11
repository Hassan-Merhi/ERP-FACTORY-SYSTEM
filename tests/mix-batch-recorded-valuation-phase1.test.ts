import { describe, expect, it } from "vitest";
import {
  recordedMixBatchCost,
  summarizeRecordedMixBatches,
  summarizeRecordedMixSources,
} from "../client/src/lib/recordedMixBatchCost";

describe("Factory mix batch historical valuations (Phase 1)", () => {
  it("keeps FMB-2026-0231's recorded valuation separate from today's supplier rate", () => {
    const recorded = recordedMixBatchCost({
      totalWeightKg: "15353.000",
      totalCost: "8824.7659100",
      costPerKg: "0.5747910",
    });
    expect(recorded.totalCost).toBe(8824.76591);
    expect(recorded.costPerKg.toFixed(4)).toBe("0.5748");

    // A prospective reprice of the same materials is NOT the historical batch.
    const currentRateEstimate = 8698.5852 / 15353;
    expect(currentRateEstimate.toFixed(4)).toBe("0.5666");
    expect(recorded.costPerKg).not.toBeCloseTo(currentRateEstimate, 4);
  });

  it("aggregates saved source costs rather than rounding each rate first", () => {
    const sources = [
      { weightKg: "305", totalCost: "169.7291450" },
      { weightKg: "8147", totalCost: "4661.5260190" },
      { weightKg: "536", totalCost: "533.9556960" },
      { weightKg: "3505", totalCost: "1758.8440500" },
      { weightKg: "1280", totalCost: "834.7161600" },
      { weightKg: "1580", totalCost: "865.9948400" },
    ];
    const sourceSummary = summarizeRecordedMixSources(sources);
    expect(sourceSummary.totalWeightKg).toBe(15353);
    expect(sourceSummary.totalCost).toBeCloseTo(8824.76591, 5);
    expect(sourceSummary.costPerKg.toFixed(4)).toBe("0.5748");
  });

  it("uses the persisted total cost in batch-list summary, not rounded unit costs", () => {
    const batches = [
      { totalWeightKg: "0.3", totalCost: "2.0000025", costPerKg: "6.6667" },
      { totalWeightKg: "1.7", totalCost: "1.1234567", costPerKg: "0.6609" },
    ];
    const total = summarizeRecordedMixBatches(batches);
    expect(total.totalWeightKg).toBe(2);
    expect(total.totalCost).toBeCloseTo(3.1234592, 7);
    expect(total.costPerKg).toBeCloseTo(3.1234592 / 2, 7);
  });

  it("preserves zero-valued historical batches rather than injecting today's costs", () => {
    expect(recordedMixBatchCost({ totalWeightKg: "10725", totalCost: "0", costPerKg: "0" }).costPerKg).toBe(0);
    expect(summarizeRecordedMixSources([{ weightKg: "10725", totalCost: "0" }]).totalCost).toBe(0);
  });
});
