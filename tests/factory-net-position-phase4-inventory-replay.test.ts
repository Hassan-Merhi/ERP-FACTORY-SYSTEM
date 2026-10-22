/**
 * Phase 4 raw-material replay contract. Authored for Claude's later CI run;
 * no tests are executed as part of this branch implementation.
 */
import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import {
  replayHistoricalRawEvents,
  valueHistoricalRawStates,
} from "../server/services/factory/netPositionHistoricalInventory";

type Input = Parameters<typeof replayHistoricalRawEvents>[0][number];
const event = (overrides: Partial<Input>): Input => ({
  key: "s42",
  kind: "RECEIPT",
  day: "2026-10-19",
  recordedAt: "2026-10-19T10:00:00",
  stableId: 1,
  kg: "100",
  usdRate: "2",
  ...overrides,
});

describe("historical raw materials — cumulative recorded movement", () => {
  it("keeps a previous day untouched by future mixing, offloads and adjustments", () => {
    const receipt = event({});
    const later = [
      event({
        kind: "CONSUME",
        day: "2026-10-20",
        recordedAt: "2026-10-20T09:00:00",
        stableId: 2,
        kg: "25",
        usdRate: null,
      }),
      event({ day: "2026-10-21", recordedAt: "2026-10-21T08:00:00", stableId: 3, kg: "40", usdRate: "3" }),
      event({
        kind: "ADD",
        day: "2026-10-21",
        recordedAt: "2026-10-21T11:00:00",
        stableId: 4,
        kg: "10",
        usdRate: "1",
        basis: "VALUED_TRANSFER",
      }),
    ];
    expect(replayHistoricalRawEvents([receipt]).value).toBe(200);
    expect(replayHistoricalRawEvents([receipt, later[0]]).value).toBe(150);
    expect(replayHistoricalRawEvents([receipt, ...later]).value).toBe(280);
  });

  it("consumes exactly once for supplier-owned mix sources, not from mutable used_kg", () => {
    const inputs = [
      event({ kg: "10", usdRate: "0.35" }),
      event({
        kind: "CONSUME",
        day: "2026-10-19",
        recordedAt: "2026-10-19T14:00:00",
        stableId: 2,
        kg: "3.3",
        usdRate: null,
      }),
    ];
    const replay = replayHistoricalRawEvents(inputs);
    expect(replay).toMatchObject({ value: 2.35, warnings: [] });
    expect(replay.states.get("s42")?.kg.toString()).toBe("6.7");
  });

  it("keeps separate supplier and manual material buckets and rounds per displayed row", () => {
    const inputs = [
      event({ key: "s1", stableId: 1, kg: "1", usdRate: "1.005" }),
      event({ key: "s2", stableId: 2, kg: "1", usdRate: "1.005" }),
      event({ key: "mOther", stableId: 3, kind: "ADD", kg: "1", usdRate: "2", basis: "OPENING_BALANCE" }),
    ];
    expect(replayHistoricalRawEvents(inputs).value).toBe(4.02);
  });

  it("flags unpriced receipts, unclassified valued ADDs and missing consumption sources", () => {
    const outcome = replayHistoricalRawEvents([
      event({ usdRate: null }),
      event({ kind: "ADD", day: "2026-10-19", recordedAt: "2026-10-19T11:00:00", stableId: 2, usdRate: "1", kg: "2" }),
      event({
        kind: "CONSUME",
        day: "2026-10-19",
        recordedAt: "2026-10-19T12:00:00",
        stableId: 3,
        kg: "999",
        usdRate: null,
      }),
    ]);
    expect(outcome.warnings).toContain("HISTORICAL_RAW_UNPRICED_RECEIPT");
    expect(outcome.warnings).toContain("HISTORICAL_RAW_ADJUSTMENT_BASIS_MISSING");
    expect(outcome.warnings).toContain("HISTORICAL_RAW_CONSUMPTION_EXCEEDS_RECEIPTS");
    expect(outcome.value).toBe(0);
  });
});

describe("historical raw materials — today's locked-rate valuation", () => {
  const state = (kg: string, value: string) => ({ kg: new MoneyDecimal(kg), value: new MoneyDecimal(value) });

  it("values a supplier's replayed kg at its locked rate when no receipt was recorded after the cutoff", () => {
    const states = new Map([
      ["s1", state("9750", "4800")],
      ["u7", state("10", "3.333")],
    ]);
    expect(valueHistoricalRawStates(states, new Map([[1, 0.5]]), new Set())).toEqual({
      value: 4875 + 3.33,
      rateUnversioned: false,
    });
  });

  it("keeps the replayed moving-average value, flagged, when a later receipt moved the locked rate", () => {
    const states = new Map([["s1", state("9750", "4800")]]);
    expect(valueHistoricalRawStates(states, new Map([[1, 0.5]]), new Set([1]))).toEqual({
      value: 4800,
      rateUnversioned: true,
    });
  });
});
