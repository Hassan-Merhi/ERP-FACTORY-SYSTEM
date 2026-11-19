import { describe, expect, it } from "vitest";
import {
  normalizeImmutableRevisionItems,
  type ImmutableRevisionItemInput,
} from "../server/services/immutableStockTransferRevisionInput";

const item = (overrides: Partial<ImmutableRevisionItemInput> = {}): ImmutableRevisionItemInput => ({
  stockItemId: 10,
  stockItemName: "Test Bale",
  sourceLocationId: 20,
  sourceLocationName: "Source",
  originalQuantity: 5,
  newQuantity: 8,
  ...overrides,
});

describe("Group A Phase 3 immutable transfer revisions", () => {
  it("normalizes quantities and computes an exact delta", () => {
    expect(normalizeImmutableRevisionItems([item()])).toEqual([
      expect.objectContaining({
        stockItemId: 10,
        sourceLocationId: 20,
        originalQuantity: 5,
        newQuantity: 8,
        delta: 3,
      }),
    ]);
  });

  it("sorts the canonical payload for deterministic duplicate detection", () => {
    const normalized = normalizeImmutableRevisionItems([
      item({ stockItemId: 30, sourceLocationId: 40 }),
      item({ stockItemId: 11, sourceLocationId: 20 }),
      item({ stockItemId: 10, sourceLocationId: 20 }),
    ]);
    expect(normalized.map((entry) => `${entry.sourceLocationId}:${entry.stockItemId}`)).toEqual([
      "20:10",
      "20:11",
      "40:30",
    ]);
  });

  it("rejects duplicate item/location pairs instead of silently overriding history", () => {
    expect(() => normalizeImmutableRevisionItems([item(), item({ newQuantity: 9 })])).toThrow(/duplicate item/i);
  });

  it("rejects empty and no-op revisions", () => {
    expect(() => normalizeImmutableRevisionItems([])).toThrow(/at least one/i);
    expect(() => normalizeImmutableRevisionItems([item({ newQuantity: 5 })])).toThrow(/no effective/i);
  });

  it("rejects negative and non-finite quantities", () => {
    expect(() => normalizeImmutableRevisionItems([item({ newQuantity: -1 })])).toThrow(/non-negative/i);
    expect(() => normalizeImmutableRevisionItems([item({ newQuantity: Number.NaN })])).toThrow(/non-negative/i);
  });
});
