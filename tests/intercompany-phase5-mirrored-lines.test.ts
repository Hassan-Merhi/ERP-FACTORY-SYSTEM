import { describe, expect, it } from "vitest";
import { assertPhase5MirroredLines } from "../server/services/intercompany/phase5LinkedLineGuard";

describe("Phase 5 source/destination goods parity", () => {
  const originals = [
    { id: 10, quantity: "2.000", rate: "3.25", lineTotal: "6.50" },
    { id: 11, quantity: "4.000", rate: "9.00", lineTotal: "36.00" },
  ];
  const incoming = [
    { id: 20, quantity: "2.000", rate: "3.25", lineTotal: "6.50" },
    { id: 21, quantity: "4.000", rate: "9.00", lineTotal: "36.00" },
  ];
  const links = [
    { sourceLineId: 10, destinationLineId: 20 },
    { sourceLineId: 11, destinationLineId: 21 },
  ];
  it("accepts exactly matched quantities, rates, values and link coverage", () => {
    expect(() => assertPhase5MirroredLines(originals, incoming, links)).not.toThrow();
  });
  it("refuses mismatched quantities even with the same overall PO value", () => {
    expect(() => assertPhase5MirroredLines(originals, [
      { ...incoming[0], quantity: "1.000" },
      { ...incoming[1], quantity: "5.000" },
    ], links)).toThrow(/quantity/);
  });
  it("refuses offsetting item price changes despite unchanged overall goods cost", () => {
    expect(() => assertPhase5MirroredLines(originals, [
      { ...incoming[0], lineTotal: "7.50" },
      { ...incoming[1], lineTotal: "35.00" },
    ], links)).toThrow(/lineTotal/);
  });
  it("refuses an altered rate even when extended values are unchanged", () => {
    expect(() => assertPhase5MirroredLines(originals, [
      { ...incoming[0], rate: "3.26" }, incoming[1],
    ], links)).toThrow(/rate/);
  });
  it("refuses swapped, duplicate and incomplete linked rows", () => {
    expect(() => assertPhase5MirroredLines(originals, incoming, [
      { sourceLineId: 10, destinationLineId: 21 },
      { sourceLineId: 11, destinationLineId: 20 },
    ])).toThrow();
    expect(() => assertPhase5MirroredLines(originals, incoming, [
      { sourceLineId: 10, destinationLineId: 20 },
      { sourceLineId: 10, destinationLineId: 21 },
    ])).toThrow(/exactly once/);
    expect(() => assertPhase5MirroredLines(originals, incoming, links.slice(0, 1))).toThrow(/incomplete/);
  });
});
