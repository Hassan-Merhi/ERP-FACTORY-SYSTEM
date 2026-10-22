import { describe, expect, it } from "vitest";
import {
  FactoryNetPositionDateError,
  isValidNetPositionDate,
  isValidNetPositionTimezone,
  netPositionBusinessDay,
  resolveFactoryNetPositionDay,
} from "../shared/factoryNetPositionAsOf";

describe("Factory Net Position business-day contract", () => {
  it("validates REAL ISO calendar dates instead of accepting only a regex", () => {
    expect(isValidNetPositionDate("2026-10-19")).toBe(true);
    expect(isValidNetPositionDate("2026-02-29")).toBe(false);
    expect(isValidNetPositionDate("2024-02-29")).toBe(true);
    expect(isValidNetPositionDate("2026-13-01")).toBe(false);
    expect(isValidNetPositionDate("2026-10-1")).toBe(false);
    expect(isValidNetPositionDate(["2026-10-19"])).toBe(false);
    expect(isValidNetPositionDate("2026-10-19T00:00:00Z")).toBe(false);
  });

  it("uses the configured company's local date rather than the viewer's UTC date", () => {
    const instant = new Date("2026-10-21T00:30:00Z");
    expect(netPositionBusinessDay(instant, "Africa/Lubumbashi")).toBe("2026-10-21");
    expect(netPositionBusinessDay(instant, "America/New_York")).toBe("2026-10-20");
    expect(netPositionBusinessDay(instant, "UTC")).toBe("2026-10-21");
    expect(netPositionBusinessDay(new Date("2026-10-20T22:30:00Z"), "Asia/Beirut")).toBe("2026-10-21");
  });

  it("only accepts configured IANA time zones, never browser as a shared business timezone", () => {
    expect(isValidNetPositionTimezone("Asia/Beirut")).toBe(true);
    expect(isValidNetPositionTimezone("Africa/Lubumbashi")).toBe(true);
    expect(isValidNetPositionTimezone("browser")).toBe(false);
    expect(isValidNetPositionTimezone("Not/AZone")).toBe(false);
    expect(isValidNetPositionTimezone(null)).toBe(false);
  });

  it("includes the full chosen day and refuses future or impossible dates", () => {
    const today = "2026-10-21";
    expect(resolveFactoryNetPositionDay(undefined, today)).toBe(today);
    expect(resolveFactoryNetPositionDay("2026-10-19", today)).toBe("2026-10-19");
    expect(resolveFactoryNetPositionDay("2026-10-21", today)).toBe(today);
    expect(() => resolveFactoryNetPositionDay("2026-10-22", today)).toThrow(FactoryNetPositionDateError);
    expect(() => resolveFactoryNetPositionDay("2026-02-30", today)).toThrow(FactoryNetPositionDateError);
    expect(() => resolveFactoryNetPositionDay("", today)).toThrow(FactoryNetPositionDateError);
  });

  it("keeps a consistent day around the New York DST transition", () => {
    // On 2026-03-08, clocks spring forward; a day need not be 24 hours long.
    expect(netPositionBusinessDay(new Date("2026-03-08T04:30:00Z"), "America/New_York")).toBe("2026-03-07");
    expect(netPositionBusinessDay(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe("2026-03-08");
  });
});
