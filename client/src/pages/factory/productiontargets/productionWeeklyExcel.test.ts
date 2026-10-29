import { describe, expect, it } from "vitest";
import { buildWeeklyProductionData, getProductionRangeDates, ProductionDateRangeError, splitTeamBales } from "./productionWeeklyExcel";
import type { ProductionResponse, ProductionRow } from "../factoryProductionTargetsModel";

function worker(
  personId: number, name: string, linkGroupId: number | null,
  targetBales: number, producedBales: number, status: "Present" | "Absent" = "Present",
): ProductionRow {
  return {
    personType: "worker", personId, name, code: "W" + personId,
    category: "RAGS & TOYS", targetBales, producedBales, status,
    notes: "", active: true, linkGroupId,
  };
}

function day(date: string, rows: ProductionRow[], finalized = true) {
  const snapshot: ProductionResponse = {
    page: "production", periodType: "daily", periodStart: date, periodEnd: date,
    finalized, rows,
  };
  return { date, snapshot };
}

describe("weekly production Excel historical grouping", () => {
  it("uses each day's links, never the most recently configured pairing", () => {
    const data = buildWeeklyProductionData([
      day("2026-10-27", [
        worker(1, "Alice", null, 7, 3),
        worker(2, "Bob", 20, 7, 14),
        worker(3, "Charlie", 20, 7, 14),
      ]),
      day("2026-10-26", [
        worker(1, "Alice", 10, 7, 12),
        worker(2, "Bob", 10, 7, 12),
        worker(3, "Charlie", null, 5, 4),
      ]),
    ]);
    expect(data.summary.map((row) => row.date)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(data.summary.map((row) => row.produced)).toEqual([16, 17]); // 12+4, then 14+3
    expect(data.summary.reduce((sum, row) => sum + row.produced, 0)).toBe(33);
    expect(data.teams).toHaveLength(4); // ONE row per linked team, not two
    expect(data.teams.filter((row) => row.team.startsWith("Linked")).map((row) => row.people))
      .toEqual(["Alice + Bob", "Bob + Charlie"]);

    const bob = data.history.filter((row) => row.name === "Bob");
    expect(bob.map((row) => row.linkedWith)).toEqual(["Alice", "Charlie"]);
    expect(bob.map((row) => row.soloProduced)).toEqual([0, 0]);
    expect(bob.map((row) => row.linkedProduced)).toEqual([6, 7]);
    expect(bob.map((row) => row.totalProduced)).toEqual([6, 7]);
    expect(bob.map((row) => row.sharedTeamProduced)).toEqual([12, 14]);
    expect(data.workers.find((row) => row.name === "Bob")).toMatchObject({
      target: 14, expected: 14, soloProduced: 0, linkedProduced: 13, totalProduced: 13, linkedDays: 2,
    });
  });

  it("subtracts only an absent member's target from the linked team's expected output", () => {
    const data = buildWeeklyProductionData([
      day("2026-10-26", [
        worker(1, "Alice", 10, 7, 11),
        worker(2, "Bob", 10, 7, 11, "Absent"),
      ]),
    ]);
    expect(data.summary[0]).toMatchObject({
      target: 14, absentTarget: 7, expected: 7, produced: 11, difference: 4,
    });
    expect(data.teams[0]).toMatchObject({
      target: 14, absentTarget: 7, expected: 7, produced: 11, difference: 4,
    });
    expect(data.workers.find((row) => row.name === "Bob")).toMatchObject({
      target: 7, absentTarget: 7, expected: 0, absent: 1,
    });
  });
});

describe("production Excel calendar range validation", () => {
  const today = "2026-10-29";

  it("allows one day, arbitrary days, and ranges spanning several calendar weeks", () => {
    expect(getProductionRangeDates("2026-10-29", "2026-10-29", today)).toEqual(["2026-10-29"]);
    expect(getProductionRangeDates("2026-10-30", "2026-11-02", "2026-11-02")).toEqual([
      "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02",
    ]);
    const result = getProductionRangeDates("2026-09-01", "2026-10-29", today);
    expect(result[0]).toBe("2026-09-01");
    expect(result.at(-1)).toBe(today);
    expect(result).toHaveLength(59);
  });

  it("rejects reversed dates, impossible dates and future dates", () => {
    expect(() => getProductionRangeDates("2026-10-30", "2026-10-29", today))
      .toThrow(ProductionDateRangeError);
    expect(() => getProductionRangeDates("2026-02-30", "2026-03-01", today))
      .toThrow(ProductionDateRangeError);
    expect(() => getProductionRangeDates("2026-10-29", "2026-10-30", today))
      .toThrow(ProductionDateRangeError);
  });

  it("caps exports at twelve weeks to protect daily factory API calls", () => {
    expect(getProductionRangeDates("2026-08-07", "2026-10-29", today)).toHaveLength(84);
    expect(() => getProductionRangeDates("2026-08-06", "2026-10-29", today))
      .toThrow(ProductionDateRangeError);
  });
});

describe("individual bale credits and integer Excel totals", () => {
  it("adds the linked team's equal credit to each worker's individually recorded unlinked production", () => {
    const result = buildWeeklyProductionData([
      day("2026-10-27", [
        worker(2, "Mohammad", null, 7, 15),
        worker(1, "Ahmed", null, 7, 20),
      ]),
      day("2026-10-26", [
        worker(1, "Ahmed", 11, 7, 14),
        worker(2, "Mohammad", 11, 7, 14),
      ]),
    ]);
    expect(result.workers.find((w) => w.name === "Ahmed")).toMatchObject({
      linkedProduced: 7, soloProduced: 20, totalProduced: 27,
    });
    expect(result.workers.find((w) => w.name === "Mohammad")).toMatchObject({
      linkedProduced: 7, soloProduced: 15, totalProduced: 22,
    });
    expect(result.summary.reduce((s, day) => s + day.produced, 0)).toBe(49);
    expect(result.workers.reduce((s, w) => s + w.totalProduced, 0)).toBe(49);
    expect(result.history.filter((r) => r.date === "2026-10-26").map((r) => r.linkedProduced)).toEqual([7, 7]);
    expect(result.teams.find((t) => t.date === "2026-10-26")?.creditedBreakdown).toBe("Ahmed: 7; Mohammad: 7");
  });

  it("allocates an odd linked-team total as whole bales with a deterministic remainder", () => {
    const shares = splitTeamBales(15, [
      { personId: 9, status: "Present" },
      { personId: 4, status: "Present" },
    ]);
    expect(shares.get(4)).toBe(8);
    expect(shares.get(9)).toBe(7);
    expect([...shares.values()].reduce((s, v) => s + v, 0)).toBe(15);
    expect([...shares.values()].every(Number.isInteger)).toBe(true);
  });

  it("does not credit an absent linked member when a present member produced the bales", () => {
    const shares = splitTeamBales(14, [
      { personId: 1, status: "Absent" },
      { personId: 2, status: "Present" },
    ]);
    expect(shares.get(1)).toBe(0);
    expect(shares.get(2)).toBe(14);
  });

  it("preserves historical partnership changes and reconciles individual credits without duplication", () => {
    const result = buildWeeklyProductionData([
      day("2026-10-26", [
        worker(1, "Ahmed", 44, 7, 14),
        worker(2, "Mohammad", 44, 7, 14),
        worker(3, "Ali", null, 4, 4),
      ]),
      day("2026-10-27", [
        worker(1, "Ahmed", 55, 7, 9),
        worker(2, "Mohammad", null, 5, 5),
        worker(3, "Ali", 55, 7, 9),
      ]),
    ]);
    expect(result.workers.find((w) => w.name === "Ahmed")).toMatchObject({ linkedProduced: 12, totalProduced: 12 });
    expect(result.workers.find((w) => w.name === "Mohammad")).toMatchObject({ linkedProduced: 7, soloProduced: 5, totalProduced: 12 });
    expect(result.workers.find((w) => w.name === "Ali")).toMatchObject({ linkedProduced: 4, soloProduced: 4, totalProduced: 8 });
    expect(result.workers.reduce((sum, w) => sum + w.totalProduced, 0))
      .toBe(result.summary.reduce((sum, day) => sum + day.produced, 0));
  });
});
