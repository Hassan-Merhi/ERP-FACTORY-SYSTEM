import { describe, expect, it } from "vitest";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import { factoryLocalDate } from "./pressingShiftTime";

function wallTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: PRESSING_TIME_ZONE, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(iso));
}

describe("pressing timestamps use Asia/Beirut (not a fixed UTC offset)", () => {
  it("uses UTC+2 on 28 October 2026", () => {
    expect(PRESSING_TIME_ZONE).toBe("Asia/Beirut");
    expect(wallTime("2026-10-28T08:20:13.000Z")).toBe("10:20:13");
  });
  it("uses UTC+3 in summer", () => {
    expect(wallTime("2026-07-28T08:20:13.000Z")).toBe("11:20:13");
  });
  it("assigns near-midnight UTC scans to Beirut's next calendar day", () => {
    expect(factoryLocalDate(new Date("2026-10-27T22:30:00.000Z"), PRESSING_TIME_ZONE))
      .toBe("2026-10-28");
    expect(wallTime("2026-10-27T22:30:00.000Z")).toBe("00:30:00");
  });
});
