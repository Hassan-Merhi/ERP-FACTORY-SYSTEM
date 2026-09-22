import { describe, expect, it } from "vitest";
import {
  groupProductionRows,
  summarizeProductionRows,
  type ProductionRow,
} from "../client/src/pages/factory/factoryProductionTargetsModel";

function row(personId: number, name: string, category: string, groupName = "Pressing workers"): ProductionRow {
  return {
    personType: "worker",
    personId,
    name,
    code: `HMD${String(personId).padStart(3, "0")}`,
    groupName,
    category,
    targetBales: 10,
    producedBales: 0,
    status: "Present",
    notes: "",
    active: true,
  };
}

describe("Production Targets category grouping", () => {
  it("groups workers by category even when they share the same worker group", () => {
    const groups = groupProductionRows([
      row(1, "Worker A", "JEANS PANT"),
      row(2, "Worker B", "BLOUSE"),
      row(3, "Worker C", "JEANS PANT"),
      row(4, "Worker D", "TSHIRT"),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["BLOUSE", "JEANS PANT", "TSHIRT"]);
    expect(groups.find((group) => group.label === "JEANS PANT")?.rows.map((item) => item.personId)).toEqual([1, 3]);
    expect(groups.some((group) => group.label === "Pressing workers")).toBe(false);
  });

  it("falls back to the worker group only when category is blank", () => {
    const groups = groupProductionRows([row(5, "Worker E", "", "Pressing workers")]);
    expect(groups[0]?.label).toBe("Pressing workers");
  });

  it("counts a linked team's shared target and production once in factory totals", () => {
    const linkedA = {
      ...row(1, "Worker A", "BLOUSE"),
      linkGroupId: 77,
      linkedWorkerIds: [1, 2],
      targetBales: 10,
      producedBales: 12,
    };
    const linkedB = {
      ...row(2, "Worker B", "BLOUSE"),
      linkGroupId: 77,
      linkedWorkerIds: [1, 2],
      targetBales: 10,
      producedBales: 12,
    };
    const solo = { ...row(3, "Worker C", "TSHIRT"), targetBales: 6, producedBales: 5 };

    expect(summarizeProductionRows([linkedA, linkedB, solo])).toEqual({
      target: 16,
      produced: 17,
      difference: 1,
    });
  });
});
