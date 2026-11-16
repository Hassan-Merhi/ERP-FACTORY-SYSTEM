import { describe, expect, it } from "vitest";
import {
  factorySupplierReportDefaultDates,
  isValidFactoryReportDateRange,
  shiftFactoryCalendarDate,
} from "../shared/factoryReportDateRange";
import {
  netPositionBusinessDay,
  resolveFactoryNetPositionDay,
  FactoryNetPositionDateError,
} from "../shared/factoryNetPositionAsOf";

describe("Factory Phase 7 historical reporting contracts", () => {
  it("builds deterministic Beirut supplier report filters through a UTC date boundary", () => {
    expect(factorySupplierReportDefaultDates(new Date("2026-07-01T21:30:00Z"))).toEqual({
      startDate: "2026-06-02",
      endDate: "2026-07-02",
    });
    expect(factorySupplierReportDefaultDates(new Date("2026-01-01T22:30:00Z"))).toEqual({
      startDate: "2025-12-03",
      endDate: "2026-01-02",
    });
  });
  it("shifts calendar dates without locale-dependent parsing or loss at month boundaries", () => {
    expect(shiftFactoryCalendarDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftFactoryCalendarDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => shiftFactoryCalendarDate("2026-02-30", 1)).toThrow();
    expect(isValidFactoryReportDateRange("2026-11-03", "2026-11-09")).toBe(true);
    expect(isValidFactoryReportDateRange("2026-11-10", "2026-11-09")).toBe(false);
  });
  it("retains canonical company-zone as-of resolution without client fallback rewrites", () => {
    const companyToday = netPositionBusinessDay(new Date("2026-11-09T23:30:00Z"), "Asia/Beirut");
    expect(companyToday).toBe("2026-11-10");
    expect(resolveFactoryNetPositionDay(undefined, companyToday)).toBe(companyToday);
    expect(resolveFactoryNetPositionDay("2026-11-09", companyToday)).toBe("2026-11-09");
    expect(() => resolveFactoryNetPositionDay("2026-11-11", companyToday)).toThrow(FactoryNetPositionDateError);
  });
});
