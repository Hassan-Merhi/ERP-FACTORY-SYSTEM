import { describe, expect, it } from "vitest";
import { rankPressingWorkers, type PressingWorkerTotal } from "../client/src/pages/factory/pressingWorkerRanking";

const workers: PressingWorkerTotal[] = [
  { userId: "p3", name: "ISSA", totalBales: 28, totalKg: "1140" },
  { userId: "p2", name: "KASSEM", totalBales: 84, totalKg: "3415" },
  { userId: "p1", name: "ALI BOUSTANI", totalBales: 84, totalKg: "3690" },
];

describe("pressing scoreboard KG ranking", () => {
  it("sorts by total confirmed KG, not bale count or user ID", () => {
    const result = rankPressingWorkers(workers);
    expect(result.map(row => row.name)).toEqual(["ALI BOUSTANI", "KASSEM", "ISSA"]);
    expect(result.map(row => row.standing)).toEqual(["leading", "middle", "lowest"]);
    expect(result.map(row => row.percentOfLeader)).toEqual([100, 93, 31]);
    expect(workers[0].name).toBe("ISSA"); // no in-place mutation
  });

  it("preserves shared standing when workers tie", () => {
    const result = rankPressingWorkers([
      { ...workers[0], totalKg: "400" },
      { ...workers[1], totalKg: "800" },
      { ...workers[2], totalKg: "800" },
    ]);
    expect(result.map(row => row.standing)).toEqual(["leading", "leading", "lowest"]);
    expect(result.map(row => row.percentOfLeader)).toEqual([100, 100, 50]);
  });

  it("does not label anyone a winner or loser without production", () => {
    const result = rankPressingWorkers(workers.map(worker => ({ ...worker, totalKg: "0" })));
    expect(result.every(row => row.standing === "unranked" && row.percentOfLeader === 0)).toBe(true);
  });

  it("handles missing workers and a single worker", () => {
    expect(rankPressingWorkers([])).toEqual([]);
    expect(rankPressingWorkers([workers[0]])[0]).toMatchObject({ standing: "leading", percentOfLeader: 100 });
  });
});
