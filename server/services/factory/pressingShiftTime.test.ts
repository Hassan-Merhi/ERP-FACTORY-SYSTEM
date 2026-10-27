import { describe, expect, it } from "vitest";
import {
  intervalsOverlap, isValidTimezone, matchingShift, minutesOfDay,
  shiftContains, shiftProductionDate, wallTimeParts,
  type PressingShiftDefinition,
} from "./pressingShiftTime";

const day: PressingShiftDefinition = {
  id: 1, shiftCode: "DAY", name: "Day", startLocal: "07:00",
  endLocal: "15:00", timezoneName: "Africa/Lubumbashi", active: true,
};
const night: PressingShiftDefinition = {
  id: 2, shiftCode: "NIGHT", name: "Night", startLocal: "22:00",
  endLocal: "06:00", timezoneName: "Africa/Lubumbashi", active: true,
};
describe("Pressing Shift Phase 7 time resolution", () => {
  it("parses HH:mm and HH:mm:ss and rejects bad wall clock", () => {
    expect(minutesOfDay("07:30")).toBe(450);
    expect(minutesOfDay("23:59:59")).toBe(1439);
    expect(() => minutesOfDay("24:00")).toThrow();
    expect(() => minutesOfDay("07:60")).toThrow();
  });
  it("rejects overlapping daily and overnight shifts, permits touching boundaries", () => {
    expect(intervalsOverlap("22:00","06:00","05:00","12:00")).toBe(true);
    expect(intervalsOverlap("22:00","06:00","06:00","14:00")).toBe(false);
    expect(intervalsOverlap("07:00","15:00","15:00","22:00")).toBe(false);
    expect(intervalsOverlap("09:00","13:00","10:00","11:00")).toBe(true);
    expect(() => intervalsOverlap("08:00","08:00","09:00","17:00")).toThrow();
  });
  it("uses factory timezone and server timestamps for shift matching", () => {
    expect(wallTimeParts(new Date("2026-10-27T06:30:00Z"),"Africa/Lubumbashi").minute).toBe(510);
    expect(shiftContains(day,new Date("2026-10-27T06:30:00Z"))).toBe(true);
    expect(shiftContains(day,new Date("2026-10-27T13:00:00Z"))).toBe(false);
    expect(matchingShift([day,night],new Date("2026-10-27T21:30:00Z"))?.id).toBe(2);
  });
  it("allocates early-morning overnight scans to the previous shift date", () => {
    expect(shiftProductionDate(night,new Date("2026-10-27T01:00:00Z"))).toBe("2026-10-26");
    expect(shiftProductionDate(night,new Date("2026-10-27T21:00:00Z"))).toBe("2026-10-27");
  });
  it("supports DST-aware IANA zones without trusting phone timezone", () => {
    expect(isValidTimezone("Europe/Paris")).toBe(true);
    expect(isValidTimezone("Fake/Nowhere")).toBe(false);
    const paris = { ...day, timezoneName:"Europe/Paris", startLocal:"02:00", endLocal:"04:00" };
    expect(shiftContains(paris,new Date("2026-10-25T02:15:00Z"))).toBe(true);
  });
  it("refuses ambiguous shift configuration rather than selecting one arbitrarily", () => {
    const overlap = { ...day, id:7, startLocal:"08:00", endLocal:"14:00" };
    expect(() => matchingShift([day,overlap],new Date("2026-10-27T09:00:00Z"))).toThrow();
  });
});
