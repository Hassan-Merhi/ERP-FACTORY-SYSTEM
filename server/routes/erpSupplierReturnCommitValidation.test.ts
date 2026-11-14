import { describe, expect, it } from "vitest";
import { validateReturnCommitRows } from "./erpSupplierReturnCommitValidation";

const allocation = (offloadItemId: number, quantity: string) => ({ offloadItemId, quantity });
const request = (code: string, quantity: string, allocations: ReturnType<typeof allocation>[]) => ({ code, quantity, allocations });

describe("Supplier return commit source/quantity integrity", () => {
  it("allows a 17+1 split of one article and validates the posting lines", () => {
    const result = validateReturnCommitRows(
      [request("HMD12034", "18", [allocation(101, "17"), allocation(102, "1")])],
      [allocation(101, "17.000"), allocation(102, "1.000")]
    );
    expect(result.totalQty).toBe("18.000");
    expect(result.allocatedBySource.get(101)?.toFixed(3)).toBe("17.000");
    expect(result.allocatedBySource.get(102)?.toFixed(3)).toBe("1.000");
  });

  it("adds repeated sources across distinct uploaded article rows", () => {
    const result = validateReturnCommitRows(
      [
        request("A", "2.500", [allocation(7, "2.500")]),
        request("A", "1.500", [allocation(7, "1.500")]),
      ],
      [allocation(7, "4")]
    );
    expect(result.totalQty).toBe("4.000");
  });

  it("rejects under- and over-allocated requests before posting", () => {
    for (const qty of ["17", "19"]) {
      expect(() => validateReturnCommitRows(
        [request("A", "18", [allocation(1, qty)])], [allocation(1, qty)]
      )).toThrow(/does not match/);
    }
  });

  it("rejects posting lines that differ from requested source allocations", () => {
    expect(() => validateReturnCommitRows(
      [request("A", "18", [allocation(1, "17"), allocation(2, "1")])],
      [allocation(1, "18")]
    )).toThrow(/differ/);
  });

  it("rejects duplicate source IDs within the same row or commit payload", () => {
    expect(() => validateReturnCommitRows(
      [request("A", "2", [allocation(1, "1"), allocation(1, "1")])],
      [allocation(1, "2")]
    )).toThrow(/Duplicate/);
    expect(() => validateReturnCommitRows(
      [request("A", "2", [allocation(1, "2")])],
      [allocation(1, "1"), allocation(1, "1")]
    )).toThrow(/Duplicate/);
  });

  it("rejects invalid IDs, zero quantities, negative values and fractional precision violations", () => {
    for (const quantity of ["0", "-2", "1.2345", "NaN", "1e2"]) {
      expect(() => validateReturnCommitRows(
        [request("A", "2", [allocation(1, quantity)])],
        [allocation(1, "2")]
      )).toThrow();
    }
    expect(() => validateReturnCommitRows(
      [request("A", "2", [allocation(0, "2")])],
      [allocation(0, "2")]
    )).toThrow();
  });

  it("rejects absent allocations and invalid row/article shape", () => {
    expect(() => validateReturnCommitRows([request("A", "1", [])], [allocation(1, "1")])).toThrow();
    expect(() => validateReturnCommitRows(
      [request("", "1", [allocation(1, "1")])], [allocation(1, "1")]
    )).toThrow();
    expect(() => validateReturnCommitRows([], [allocation(1, "1")])).toThrow();
  });

  it("does not mutate input row quantities or commit lines", () => {
    const rows = [request("A", "1", [allocation(1, "1")])];
    const lines = [allocation(1, "1")];
    validateReturnCommitRows(rows, lines);
    expect(rows[0].quantity).toBe("1");
    expect(lines[0].quantity).toBe("1");
  });
});
