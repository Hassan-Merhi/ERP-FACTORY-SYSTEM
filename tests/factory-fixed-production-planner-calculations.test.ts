import { describe, expect, it } from "vitest";
import {
  calculateFixedProductionRows,
  sumFixedProductionRows,
  visibleFixedProductionRows,
} from "../client/src/pages/factory/production-raw-stock/fixedProductionPlannerCalculations";

describe("Fixed Production Planner — original 05 Oct 2026 workbook formulas", () => {
  const suppliers = [
    { id: 1, name: "UK basma" },
    { id: 2, name: "UK ziad" },
    { id: 3, name: "PORTUGAL" },
    { id: 4, name: "CYPRUS" },
  ];
  const stock = [
    { supplierId: 1, freeKg: "22251", remainingKg: "22251" },
    { supplierId: 2, freeKg: "24020", remainingKg: "24020" },
    { supplierId: 3, freeKg: "365487", remainingKg: "365487" },
    { supplierId: 4, freeKg: "263479", remainingKg: "263479" },
  ];
  const containers = [
    { supplierId: 3, totalKg: "20520", status: "IN_TRANSIT" },
    { supplierId: 4, totalKg: "104800", status: "PENDING" },
    { supplierId: 1, totalKg: "100", status: "OFFLOADED" },
    { supplierId: 1, totalKg: "200", status: "PARTIALLY_RECEIVED" },
    { supplierId: 2, totalKg: "1000", status: "ARRIVED" },
  ];

  it("calculates 15t, 17.5t, coverage days and fractional containers per row", () => {
    const rows = calculateFixedProductionRows(suppliers, stock, containers, {
      "1": 1000, "2": 0, "3": 3000, "4": 10000,
    });
    const uk = rows.find((r) => r.id === "1")!;
    expect(uk.allocation15).toBe(750);
    expect(uk.allocation175).toBe(875);
    expect(uk.allocation20).toBe(1000);
    expect(uk.otw).toBe(0);
    expect(uk.withOtwDays).toBeCloseTo(22251 / 875, 10);
    expect(uk.withoutOtwDays).toBeCloseTo(22251 / 875, 10);
    expect(uk.containersToOrder).toBeCloseTo(875 * 26 / 20000, 10);

    const portugal = rows.find((r) => r.id === "3")!;
    expect(portugal.total).toBe(386007);
    expect(portugal.withOtwDays).toBeCloseTo(386007 / 2625, 10);
    expect(portugal.withoutOtwDays).toBeCloseTo(365487 / 2625, 10);
    expect(portugal.containersToOrder).toBeCloseTo(2625 * 26 / 20000, 10);
  });

  it("returns zero instead of Infinity or NaN when daily allocation is empty or zero", () => {
    const rows = calculateFixedProductionRows(suppliers, stock, containers, {});
    for (const row of rows) {
      expect(row.withOtwDays).toBe(0);
      expect(row.withoutOtwDays).toBe(0);
      expect(row.containersToOrder).toBe(0);
    }
    expect(rows.find((r) => r.id === "2")?.otw).toBe(1000);
  });

  it("sums supplier coverage and container estimates as in the Excel total row", () => {
    const rows = calculateFixedProductionRows(
      Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: "Supplier " + i })),
      [],
      [],
      Object.fromEntries([1000, 0, 500, 3000, 10000, 3675, 750, 500, 575].map((kg, i) => [String(i + 1), kg])),
    );
    const totals = sumFixedProductionRows(rows);
    expect(totals.allocation20).toBe(20000);
    expect(totals.allocation15).toBe(15000);
    expect(totals.allocation175).toBe(17500);
    expect(totals.containersToOrder).toBeCloseTo(22.75, 10);
  });

  it("hides suppliers with no In Hand or OTW even if they have a saved production allocation", () => {
    const suppliers = [
      { id: 11, name: "ABO JABER" },
      { id: 12, name: "CYPRUS MODA" },
      { id: 13, name: "Australia Ahmad" },
      { id: 14, name: "Only Empty" },
    ];
    const stock = [
      { supplierId: 11, remainingKg: "0", freeKg: "0" },
      { supplierId: 12, remainingKg: "0", freeKg: "0" },
      { supplierId: 13, remainingKg: "190140", freeKg: "190140" },
    ];
    const containers = [
      { supplierId: 12, totalKg: "38770", status: "PENDING" },
      { supplierId: 14, totalKg: "10000", status: "OFFLOADED" },
    ];
    const allocations = { "11": 1000, "12": 700, "13": 300, "14": 1500 };
    const allRows = calculateFixedProductionRows(suppliers, stock, containers, allocations);
    const visible = visibleFixedProductionRows(allRows);
    expect(visible.map(row => row.name)).toEqual(["Australia Ahmad", "CYPRUS MODA"]);
    expect(visible.find(row => row.name === "CYPRUS MODA")?.otw).toBe(38770);
    expect(visible.find(row => row.name === "CYPRUS MODA")?.inHand).toBe(0);
    expect(visible.find(row => row.name === "CYPRUS MODA")?.withOtwDays).toBeGreaterThan(0);
    expect(sumFixedProductionRows(visible).allocation20).toBe(1000);
    // Filtering the view must never erase past saved allocations.
    expect(allocations["11"]).toBe(1000);
  });

  it("filters at displayed three-decimal kg precision while keeping negative balances visible", () => {
    const rows = calculateFixedProductionRows(
      [{ id: 1, name: "Zero" }, { id: 2, name: "Tiny balance" }, { id: 3, name: "Negative balance" }],
      [{ supplierId: 2, freeKg: "0.0004", remainingKg: "0.0004" },
       { supplierId: 3, freeKg: "-5", remainingKg: "-5" }],
      [],
      { "1": 100, "2": 150, "3": 200 },
    );
    expect(visibleFixedProductionRows(rows).map(r => r.name)).toEqual(["Negative balance"]);
  });

  it("does not restrict summed allocations to 20,000 kg", () => {
    const rows = calculateFixedProductionRows([{ id: 8, name: "Sample" }], [], [], { "8": 45000 });
    expect(rows[0].allocation20).toBe(45000);
    expect(sumFixedProductionRows(rows).allocation20).toBe(45000);
  });
});
