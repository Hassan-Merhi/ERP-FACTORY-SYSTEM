import { describe, expect, it } from "vitest";
import { factoryBusinessDateInBeirut, futureDatedSupplierGoods } from "../scripts/historical-supplier-date-safety";

describe("historical supplier reconciliation safety", () => {
  const goods = [
    { container_number: "MSNU8402330", arrival_date: "2026-11-11", created_on: "2026-05-30" },
    { container_number: "MSBU7553572", arrival_date: "2026-12-11", created_on: "2026-05-30" },
    { container_number: "ALREADY-RECEIVED", arrival_date: "2026-06-19", created_on: "2026-05-30" },
  ];

  it("identifies the two future-dated historical imports without changing the input", () => {
    const snapshot = JSON.stringify(goods);
    expect(futureDatedSupplierGoods(goods, "2026-11-02").map((row) => row.container_number)).toEqual([
      "MSNU8402330",
      "MSBU7553572",
    ]);
    expect(JSON.stringify(goods)).toBe(snapshot);
  });

  it("uses the created date only when arrival date is absent", () => {
    const rows = [
      { container_number: "OLD", arrival_date: null, created_on: "2026-10-14" },
      { container_number: "FUTURE", arrival_date: null, created_on: "2026-11-03" },
    ];
    expect(futureDatedSupplierGoods(rows, "2026-11-02").map((row) => row.container_number)).toEqual(["FUTURE"]);
  });

  it("treats today's date as valid and uses the Beirut business day at midnight", () => {
    expect(futureDatedSupplierGoods(goods, "2026-11-11").map((row) => row.container_number)).toEqual([
      "MSBU7553572",
    ]);
    expect(factoryBusinessDateInBeirut(new Date("2026-11-01T23:30:00Z"))).toBe("2026-11-02");
    expect(factoryBusinessDateInBeirut(new Date("2026-11-02T08:00:00Z"))).toBe("2026-11-02");
  });
});
