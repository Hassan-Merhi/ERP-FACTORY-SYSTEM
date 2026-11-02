/**
 * Pure safety checks for one-time factory supplier accounting backfills.
 * Estimated container arrival dates must never create future-dated GL expenses.
 */
export interface HistoricalSupplierGoodsDate {
  container_number: string;
  arrival_date: string | null;
  created_on: string;
}

export function factoryBusinessDateInBeirut(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function futureDatedSupplierGoods<T extends HistoricalSupplierGoodsDate>(
  rows: readonly T[],
  businessDate: string,
): T[] {
  return rows.filter((row) => (row.arrival_date || row.created_on) > businessDate);
}
