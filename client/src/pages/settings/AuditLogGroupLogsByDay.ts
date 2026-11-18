// Extracted from ./AuditLog.tsx to keep that module under the source-size cap.
import type { SettingsAuditLogRow } from "./settingsTypes";

export const ACTION_FILTER_OPTIONS: { label: string; value: string }[] = [
  { label: "All Activity", value: "all" },
  { label: "Created", value: "create" },
  { label: "Edited", value: "update" },
  { label: "Deleted", value: "delete" },
  { label: "Restored", value: "restore" },
  { label: "Reversed / Voided", value: "reverse,void" },
  { label: "Recalculated / Repaired", value: "recalculate,repair" },
  { label: "Imports", value: "import" },
  { label: "Exports", value: "export" },
  { label: "Sent to WhatsApp / Email", value: "send_whatsapp,send_email" },
  { label: "Approvals / Cancellations", value: "approve,cancel" },
  { label: "Transfers / Adjustments", value: "transfer,adjust,offload" },
  { label: "Settings / Permissions", value: "settings_change,permission_change" },
  { label: "Updates & Deletes", value: "update,delete" },
];

type DayGroup = {
  dateKey: string;
  dateLabel: string;
  logs: SettingsAuditLogRow[];
};

export function groupLogsByDay(logs: SettingsAuditLogRow[]): DayGroup[] {
  const dayMap = new Map<string, SettingsAuditLogRow[]>();

  for (const log of logs) {
    const date = new Date(log.createdAt);
    const dateKey = date.toLocaleDateString("en-CA");
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey)!.push(log);
  }

  return [...dayMap.entries()].map(([dateKey, dayLogs]) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return {
      dateKey,
      dateLabel: date.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      logs: dayLogs,
    };
  });
}

export interface AuditLogProps {
  /** Initial action filter value. "all" = no action restriction. Default: "update,delete" */
  defaultActions?: string;
  /** "settings" = original compact view; "daybook" = full activity view. Default: "settings" */
  context?: "settings" | "daybook";
  /** Whether to show the Card heading. Default: false */
  showHeading?: boolean;
}
