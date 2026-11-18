// Extracted from ./SalesReportLegacy.tsx to keep that module under the source-size cap.
import { type PeriodFilterValue, getDefaultPeriodValue, parsePeriodFilterDate } from "@/components/ui/period-filter";

export function getInitialSalesReportPeriod(): PeriodFilterValue {
  if (typeof window === "undefined") return getDefaultPeriodValue("today");
  const query = new URLSearchParams(window.location.search);
  if (!query.has("startDate") && !query.has("endDate")) return getDefaultPeriodValue("today");
  const fromDate = query.get("startDate") ?? "";
  const toDate = query.get("endDate") ?? "";
  if (!fromDate && !toDate) return getDefaultPeriodValue("all_time");
  if (
    (fromDate && !parsePeriodFilterDate(fromDate)) ||
    (toDate && !parsePeriodFilterDate(toDate)) ||
    (fromDate && toDate && fromDate > toDate)
  ) {
    return getDefaultPeriodValue("today");
  }
  return { fromDate, toDate, preset: "custom" };
}

export function getInitialSalesReportGroups(): string[] {
  if (typeof window === "undefined") return [];
  const groupId = new URLSearchParams(window.location.search).get("stockGroupId");
  return groupId && /^[1-9]\d*$/.test(groupId) ? [groupId] : [];
}
