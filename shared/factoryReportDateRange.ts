import { factoryLocalDate } from "./factoryLocalDate";
import { isValidNetPositionDate } from "./factoryNetPositionAsOf";

/**
 * Supplier report UI defaults are Beirut calendar days, not browser locale strings.
 * This is a display/filter choice only; the server validates report scope.
 */
export function shiftFactoryCalendarDate(date: string, days: number): string {
  if (!isValidNetPositionDate(date) || !Number.isSafeInteger(days)) {
    throw new Error("Invalid report calendar date or shift");
  }
  const day = new Date(`${date}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export function factorySupplierReportDefaultDates(now: Date = new Date()): {
  startDate: string;
  endDate: string;
} {
  const endDate = factoryLocalDate(now);
  return { startDate: shiftFactoryCalendarDate(endDate, -30), endDate };
}

export function isValidFactoryReportDateRange(start: unknown, end: unknown): boolean {
  return isValidNetPositionDate(start) && isValidNetPositionDate(end) && start <= end;
}
