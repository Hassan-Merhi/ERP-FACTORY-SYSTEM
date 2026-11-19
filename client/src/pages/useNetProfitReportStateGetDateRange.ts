// Extracted from ./useNetProfitReportState.tsx

export type Period =
  "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "all_time" | "specific_month" | "custom_range";

export const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This Week" },
  { value: "this_month", label: "This Month" },
  { value: "this_year", label: "This Year" },
  { value: "all_time", label: "All Time" },
  { value: "specific_month", label: "Monthly" },
  { value: "custom_range", label: "Custom Range" },
];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function getDateRange(
  period: Period,
  specificMonth?: number,
  specificYear?: number,
  customFromDate?: string,
  customToDate?: string
): { startDate: string | null; endDate: string | null } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  if (period === "today") return { startDate: today, endDate: today };

  if (period === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const y = fmt(yesterday);
    return { startDate: y, endDate: y };
  }

  if (period === "this_week") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now);
    monday.setDate(diff);
    return { startDate: fmt(monday), endDate: today };
  }

  if (period === "this_month") {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { startDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, endDate: fmt(lastDay) };
  }

  if (period === "this_year") {
    return { startDate: `${now.getFullYear()}-01-01`, endDate: today };
  }

  if (period === "specific_month" && specificMonth !== undefined && specificYear !== undefined) {
    const lastDay = new Date(specificYear, specificMonth, 0).getDate();
    const start = `${specificYear}-${pad(specificMonth)}-01`;
    const end = `${specificYear}-${pad(specificMonth)}-${pad(lastDay)}`;
    return { startDate: start, endDate: end };
  }

  if (period === "custom_range") {
    return {
      startDate: customFromDate || null,
      endDate: customToDate || null,
    };
  }

  return { startDate: null, endDate: null };
}
