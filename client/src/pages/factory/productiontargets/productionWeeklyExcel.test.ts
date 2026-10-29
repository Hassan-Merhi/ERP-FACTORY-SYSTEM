import { describe, expect, it } from "vitest";
import { buildWeeklyProductionData } from "./productionWeeklyExcel";
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
    expect(bob.map((row) => row.soloProduced)).toEqual([null, null]);
    expect(bob.map((row) => row.sharedTeamProduced)).toEqual([12, 14]);
    expect(data.workers.find((row) => row.name === "Bob")).toMatchObject({
      target: 14, expected: 14, soloProduced: 0, linkedDays: 2,
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
