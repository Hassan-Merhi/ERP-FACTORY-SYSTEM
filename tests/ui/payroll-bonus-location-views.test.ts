import { describe, expect, it } from "vitest";
import { buildPayrollLocationViews } from "@/pages/payroll/usePayrollData";
import { decodeLocationOption, encodeLocationOption } from "@/pages/payroll/payrollUtils";

const bonusLocations = [
  { id: 21, name: "Hadi 2", companyId: 4, companyName: "Golden Coast", hasSales: true },
  { id: 22, name: "Hadi 3", companyId: 4, companyName: "Golden Coast", hasSales: true },
  { id: 21, name: "Hadi 2", companyId: 10, companyName: "GC Lshi", hasSales: true },
];

describe("buildPayrollLocationViews", () => {
  it("keeps the shared location of a company that owns no location rows", () => {
    const { locations } = buildPayrollLocationViews(bonusLocations, 10, []);
    expect(locations).toEqual([{ id: 21, name: "Hadi 2", companyId: 10 }]);
  });

  it("lists the other accessible companies with their own company id", () => {
    const { allCompanyLocations } = buildPayrollLocationViews(bonusLocations, 10, [{ id: 4, name: "Golden Coast" }]);
    expect(allCompanyLocations).toEqual([
      { id: 21, name: "Hadi 2", companyId: 4, companyName: "Golden Coast" },
      { id: 22, name: "Hadi 3", companyId: 4, companyName: "Golden Coast" },
    ]);
  });

  it("falls back to every known location for a company the server listed nothing for", () => {
    const { locations } = buildPayrollLocationViews(bonusLocations, 77, []);
    expect(locations.map((location) => location.id)).toEqual([21, 22]);
  });
});

describe("location option values", () => {
  it("round-trips the location and its source company", () => {
    expect(decodeLocationOption(encodeLocationOption(21, 10))).toEqual({ locationId: "21", sourceCompanyId: "10" });
  });

  it("keeps a bare location id readable so older saved values still resolve", () => {
    expect(decodeLocationOption("21")).toEqual({ locationId: "21", sourceCompanyId: "" });
  });

  it("separates the same location offered under two companies", () => {
    expect(encodeLocationOption(21, 4)).not.toBe(encodeLocationOption(21, 10));
  });
});
