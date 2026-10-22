/**
 * Phase 4 replaced the old current-raw-balance +/- future transaction
 * correction with a replay of original dated movements.
 * Keep this regression assertion on the exact half-cent money boundary.
 * This test is authored, not executed, per owner request.
 */
import { describe, expect, it } from "vitest";
import { replayHistoricalRawEvents } from "../server/services/factory/netPositionHistoricalInventory";

describe("historical Net Position exact-money correction", () => {
  it("rounds 10 kg @ $0.35 less 3.3 consumed kg to $2.35, not $2.34", () => {
    expect(
      replayHistoricalRawEvents([
        {
          key: "s1",
          kind: "RECEIPT",
          day: "2026-09-01",
          recordedAt: "2026-09-01T08:00:00",
          stableId: 1,
          kg: "10",
          usdRate: "0.35",
        },
        {
          key: "s1",
          kind: "CONSUME",
          day: "2026-09-01",
          recordedAt: "2026-09-01T10:00:00",
          stableId: 2,
          kg: "3.3",
          usdRate: null,
        },
      ]).value
    ).toBe(2.35);
  });
});
