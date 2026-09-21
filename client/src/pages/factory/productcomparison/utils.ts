export type ProductComparisonPeriod = "day" | "month" | "year" | "custom";
export type ComparisonDirection = "previous" | "next";

export interface ComparisonRange {
  from: string;
  to: string;
}

export interface AutomaticComparisonAnchors {
  day: string;
  month: string;
  year: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function currentDayValue(now = new Date()): string {
  return toLocalIsoDate(now);
}

export function currentMonthValue(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

export function currentYearValue(now = new Date()): string {
  return String(now.getFullYear());
}

export function isValidLocalIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;

  const date = new Date(year, month - 1, day);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function isValidComparisonRange(range: ComparisonRange): boolean {
  return isValidLocalIsoDate(range.from) && isValidLocalIsoDate(range.to) && range.from <= range.to;
}

function parseDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function parseMonth(value: string): { year: number; monthIndex: number } {
  const [year, month] = value.split("-").map(Number);
  return { year, monthIndex: month - 1 };
}

export function rangeForDay(day: string): ComparisonRange {
  return { from: day, to: day };
}

export function rangeForMonth(month: string): ComparisonRange {
  const { year, monthIndex } = parseMonth(month);
  return {
    from: `${year}-${pad(monthIndex + 1)}-01`,
    to: toLocalIsoDate(new Date(year, monthIndex + 1, 0)),
  };
}

export function rangeForYear(yearValue: string): ComparisonRange {
  const year = Number(yearValue);
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

export function shiftDay(day: string, direction: ComparisonDirection): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + (direction === "next" ? 1 : -1));
  return toLocalIsoDate(date);
}

export function shiftMonth(month: string, direction: ComparisonDirection): string {
  const { year, monthIndex } = parseMonth(month);
  const shifted = new Date(year, monthIndex + (direction === "next" ? 1 : -1), 1);
  return currentMonthValue(shifted);
}

export function shiftYear(yearValue: string, direction: ComparisonDirection): string {
  const year = Number(yearValue) + (direction === "next" ? 1 : -1);
  return String(year);
}

export function buildAutomaticComparisonRanges(
  period: Exclude<ProductComparisonPeriod, "custom">,
  direction: ComparisonDirection,
  anchors: AutomaticComparisonAnchors
): { selected: ComparisonRange; comparison: ComparisonRange } {
  if (period === "day") {
    return {
      selected: rangeForDay(anchors.day),
      comparison: rangeForDay(shiftDay(anchors.day, direction)),
    };
  }
  if (period === "month") {
    return {
      selected: rangeForMonth(anchors.month),
      comparison: rangeForMonth(shiftMonth(anchors.month, direction)),
    };
  }
  return {
    selected: rangeForYear(anchors.year),
    comparison: rangeForYear(shiftYear(anchors.year, direction)),
  };
}

export function parseLocalIsoDate(value: string): Date {
  return parseDay(value);
}
