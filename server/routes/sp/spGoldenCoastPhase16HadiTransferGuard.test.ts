import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
  GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
  goldenCoastPhase16LegacyHadiRetiredPayload,
} from "./spGoldenCoastHadiTransferGuard";

describe("Golden Coast Phase 16 legacy manual HADI guard", () => {
  it("keeps the compatibility path stable while explicitly retiring its mutation semantics", () => {
    expect(GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH).toBe("/api/sp/golden-coast/phase7/sales-cash-transfer");
    expect(goldenCoastPhase16LegacyHadiRetiredPayload()).toMatchObject({
      code: GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
    });
    expect(goldenCoastPhase16LegacyHadiRetiredPayload().message).toMatch(/Pay Fresh Start from HADI/i);
  });
});
