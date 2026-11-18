// Extracted from ./LocationWhatsappScheduleDialog.tsx to keep that module under the source-size cap.
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { AlertTriangle, CheckCircle2, Clock3, XCircle } from "lucide-react";
import type { InventoryLocation } from "./locationInventoryTypes";

export type ScheduleFrequency = "daily" | "selected_days";

export interface ScheduleConfig {
  locationId: number;
  enabled: boolean;
  frequency: ScheduleFrequency;
  daysOfWeek: number[];
  sendTime: string;
  timezone: string;
  includeCost: boolean;
  includeZeroStock: boolean;
  includeNegativeStock: boolean;
  stockGroupId: number | null;
  categoryId: number | null;
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastScheduledFor: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextSendAt: string | null;
}

export interface LookupRow {
  id: number;
  name: string;
  active?: boolean;
}

export interface LocationWhatsappScheduleDialogProps {
  location: InventoryLocation;
  companyId?: number;
  canSendWithCost: boolean;
}

export const DAYS = [
  { value: 1, label: releaseDebtEnglish("Mon") },
  { value: 2, label: releaseDebtEnglish("Tue") },
  { value: 3, label: releaseDebtEnglish("Wed") },
  { value: 4, label: releaseDebtEnglish("Thu") },
  { value: 5, label: releaseDebtEnglish("Fri") },
  { value: 6, label: releaseDebtEnglish("Sat") },
  { value: 0, label: releaseDebtEnglish("Sun") },
];

export const COMMON_TIMEZONES = [
  "Africa/Lubumbashi",
  "Africa/Johannesburg",
  "Africa/Kinshasa",
  "Asia/Beirut",
  "Europe/London",
  "America/New_York",
  "UTC",
];

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function scheduleStatus(status: string | null) {
  if (status === "sent")
    return { label: releaseDebtEnglish("Sent"), Icon: CheckCircle2, className: "text-green-600 dark:text-green-400" };
  if (status === "failed") return { label: "Failed", Icon: XCircle, className: "text-destructive" };
  if (status === "skipped_empty")
    return {
      label: releaseDebtEnglish("No matching stock"),
      Icon: AlertTriangle,
      className: "text-amber-600 dark:text-amber-400",
    };
  if (status === "running")
    return { label: releaseDebtEnglish("Sending"), Icon: Clock3, className: "text-blue-600 dark:text-blue-400" };
  return null;
}
