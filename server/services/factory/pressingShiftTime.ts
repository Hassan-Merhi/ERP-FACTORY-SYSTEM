/**
 * Factory-local shift resolution. A shift covers [start,end), including when
 * start > end (overnight). Never infer downtime from gaps between scans.
 */
export interface PressingShiftDefinition {
  id: number;
  name: string;
  shiftCode: string;
  startLocal: string;
  endLocal: string;
  timezoneName: string;
  active: boolean;
}
export function isValidTimezone(timezone: string): boolean {
  if (timezone.length > 100 || !timezone.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; }
  catch { return false; }
}
export function minutesOfDay(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time);
  if (!match) throw new Error("Invalid HH:mm time");
  return Number(match[1]) * 60 + Number(match[2]);
}
export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  function spans(start: string, end: string): Array<[number, number]> {
    const a = minutesOfDay(start), b = minutesOfDay(end);
    if (a === b) throw new Error("Shift must have a duration");
    return a < b ? [[a,b]] : [[a,1440],[0,b]];
  }
  return spans(aStart,aEnd).some(([a,b]) =>
    spans(bStart,bEnd).some(([c,d]) => a < d && c < b));
}
export function wallTimeParts(instant: Date, timezone: string): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const field = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
  return {
    date: [field("year"),field("month"),field("day")].join("-"),
    minute: Number(field("hour")) * 60 + Number(field("minute")),
  };
}
export function shiftContains(shift: PressingShiftDefinition, instant: Date): boolean {
  if (!shift.active || !isValidTimezone(shift.timezoneName)) return false;
  const minute = wallTimeParts(instant, shift.timezoneName).minute;
  const start = minutesOfDay(shift.startLocal), end = minutesOfDay(shift.endLocal);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
export function shiftProductionDate(shift: PressingShiftDefinition, instant: Date): string {
  const { date, minute } = wallTimeParts(instant, shift.timezoneName);
  const start = minutesOfDay(shift.startLocal), end = minutesOfDay(shift.endLocal);
  if (start <= end || minute >= start) return date;
  // Morning of an overnight shift belongs to its previous local shift date.
  const yesterday = new Date(date + "T12:00:00Z");
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}
export function matchingShift(
  shifts: PressingShiftDefinition[], instant: Date,
): PressingShiftDefinition | null {
  const matches = shifts.filter(s => shiftContains(s, instant));
  if (matches.length > 1) throw new Error("More than one configured shift applies at this time");
  return matches[0] ?? null;
}
