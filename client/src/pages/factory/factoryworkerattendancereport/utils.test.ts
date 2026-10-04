import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

import {isoMonthEnd, isoMonthStart, isoToday, isoYesterday} from "./utils";

const originalTz = process.env.TZ;

describe("attendance report local calendar date helpers", () => {
  beforeAll(() => {
    process.env.TZ = "Asia/Beirut";
    vi.useFakeTimers();
  });

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-09-29T05:00:00.000Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("keeps the full local month instead of dropping the last day in positive UTC offsets", () => {
    expect(isoMonthStart()).toBe("2026-09-01");
    expect(isoMonthEnd()).toBe("2026-09-30");
  });

  it("uses the browser's local calendar day for today and yesterday", () => {
    vi.setSystemTime(new Date("2026-09-28T21:30:00.000Z"));

    expect(isoToday()).toBe("2026-09-29");
    expect(isoYesterday()).toBe("2026-09-28");
  });
});
