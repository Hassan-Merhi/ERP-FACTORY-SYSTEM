/**
 * Contracts for the append-only Factory row-history replay.
 * Authored for Claude's test run; no CI or database tests are executed here.
 */
import { describe, expect, it } from "vitest";
import { replayFactoryRowChanges, type HistoricalChange } from "../server/services/factory/netPositionRowHistoryReader";

function change(record_id: number, op: HistoricalChange["op"], old_values: Record<string, unknown> | null,
  new_values: Record<string, unknown> | null): HistoricalChange {
  return { record_id, op, old_values, new_values };
}

describe("historical Factory row-state replay", () => {
  it("replays a baseline, changed-column patches, then deletion without inventing unchanged fields", () => {
    const data = replayFactoryRowChanges([
      change(1, "S", null, { id: 1, company_id: 12, production_price: "5.00", selling_price: "8.00", name: "Shoes" }),
      change(1, "U", { selling_price: "8.00" }, { selling_price: "9.50" }),
      change(2, "I", null, { id: 2, company_id: 12, production_price: "2.00", selling_price: null }),
    ]);
    expect(data.get(1)).toEqual({
      id: 1, company_id: 12, production_price: "5.00", selling_price: "9.50", name: "Shoes",
    });
    expect(data.get(2)?.selling_price).toBeNull();
    const removed = replayFactoryRowChanges([
      change(1, "S", null, { id: 1, name: "Before" }),
      change(1, "U", { name: "Before" }, { name: "After" }),
      change(1, "D", { id: 1, name: "After" }, null),
    ]);
    expect(removed.has(1)).toBe(false);
  });

  it("refuses to reconstruct when the baseline, prior row or full image is missing", () => {
    expect(() => replayFactoryRowChanges([change(5, "U", { name: "Old" }, { name: "New" })]))
      .toThrow("HISTORICAL_ROW_HISTORY_UPDATE_WITHOUT_BASE");
    expect(() => replayFactoryRowChanges([change(5, "D", { id: 5 }, null)]))
      .toThrow("HISTORICAL_ROW_HISTORY_DELETE_WITHOUT_BASE");
    expect(() => replayFactoryRowChanges([change(5, "S", null, null)]))
      .toThrow("HISTORICAL_ROW_HISTORY_FULL_RECORD_MISSING");
    expect(() => replayFactoryRowChanges([
      change(5, "S", null, { id: 5 }),
      change(5, "I", null, { id: 5 }),
    ])).toThrow("HISTORICAL_ROW_HISTORY_DUPLICATE_CREATION");
    expect(() => replayFactoryRowChanges([change(0, "I", null, { id: 0 })]))
      .toThrow("HISTORICAL_ROW_HISTORY_INVALID_ID");
  });
});
