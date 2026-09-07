import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_HADI_CASH_CONFIGURATION_CODE,
  classifyGoldenCoastPosConfigurationError,
} from "../server/services/pos/goldenCoastPosConfigurationError";

describe("Golden Coast POS configuration errors", () => {
  it("classifies a missing matching HADI cash account as an actionable 422", () => {
    const result = classifyGoldenCoastPosConfigurationError(
      new Error('HADI has no active Cash/Bank account named "C2 CASH" to receive Golden Coast POS cash')
    );

    expect(result).toEqual({
      status: 422,
      body: {
        code: GOLDEN_COAST_HADI_CASH_CONFIGURATION_CODE,
        message:
          'HADI has no active Cash/Bank account named "C2 CASH" to receive Golden Coast POS cash. Create or activate the matching Cash/Bank account in HADI, then retry the sale.',
      },
    });
  });

  it("does not reclassify unrelated server failures", () => {
    expect(classifyGoldenCoastPosConfigurationError(new Error("database unavailable"))).toBeNull();
    expect(classifyGoldenCoastPosConfigurationError("Insufficient stock")).toBeNull();
  });
});
