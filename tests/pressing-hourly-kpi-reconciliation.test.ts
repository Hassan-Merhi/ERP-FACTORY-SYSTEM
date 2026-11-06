import { describe, expect, it } from "vitest";
import { pressingHourlyKpiTotals, type PressingHourlySnapshot } from "../client/src/pages/factory/pressing-scanner/pressingHourlyKpi";

const snapshot: PressingHourlySnapshot = {
  day: "2026-11-05", serverNow: "2026-11-05T10:45:00.000Z",
  canEdit: true, hourlyTargetsKg: {},
  workers: [
    { userId: "one", slot: "P1", name: "P1 worker", targetKgPerHour: 800 },
    { userId: "two", slot: "P2", name: "P2 worker", targetKgPerHour: 800 },
    { userId: "three", slot: "P3", name: "P3 worker", targetKgPerHour: 800 },
  ],
  hours: [
    // Beirut is UTC+2 in November: 07:00 and 12:00 production.
    { hourStart: "2026-11-05T05:00:00.000Z", userId: "one", kg: "435.000", bales: 11 },
    { hourStart: "2026-11-05T10:00:00.000Z", userId: "one", kg: "240.000", bales: 6 },
    { hourStart: "2026-11-05T05:00:00.000Z", userId: "two", kg: "400.000", bales: 10 },
    { hourStart: "2026-11-05T10:00:00.000Z", userId: "two", kg: "490.000", bales: 12 },
    // These scans are outside the displayed 07:00–17:00 hours.
    { hourStart: "2026-11-05T04:00:00.000Z", userId: "one", kg: "900.000", bales: 20 },
    { hourStart: "2026-11-05T15:00:00.000Z", userId: "two", kg: "900.000", bales: 20 },
    { hourStart: "2026-11-05T06:00:00.000Z", userId: "other", kg: "999.000", bales: 20 },
  ],
};

describe("pressing daily KPI reconciles to the displayed hourly table", () => {
  it("adds only P1/P2/P3 confirmed scan hours from 07:00 to 17:00 Beirut", () => {
    expect(pressingHourlyKpiTotals(snapshot)).toEqual([
      { userId: "one", name: "P1 worker", totalBales: 17, totalKg: "675.000" },
      { userId: "two", name: "P2 worker", totalBales: 22, totalKg: "890.000" },
      { userId: "three", name: "P3 worker", totalBales: 0, totalKg: "0.000" },
    ]);
  });
  it("does not invent totals while another day's hourly snapshot loads", () => {
    expect(pressingHourlyKpiTotals(undefined)).toEqual([]);
  });
});
